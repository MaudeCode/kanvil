import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vite-plus/test";
import { createFixture } from "./test-fixture.ts";
import { createDomain, type Actor, type Domain } from "./domain.ts";
import type { Project, Ticket } from "@kanvil/contracts";

const startAt = "2026-10-01T09:00:00.000Z",
  endAt = "2026-10-01T09:01:30.250Z";
describe("observed ticket time entries", () => {
  let fixture: Awaited<ReturnType<typeof createFixture>>,
    domain: Domain,
    owner: Actor,
    writer: Actor,
    peer: Actor,
    reader: Actor,
    outsider: Actor,
    project: Project,
    ticket: Ticket;
  beforeAll(async () => {
    fixture = await createFixture();
    domain = createDomain(fixture.database);
    const people = await Promise.all(
      ["Owner", "Writer", "Peer", "Reader", "Outsider"].map((name) =>
        fixture.auth.api.createUser({
          body: {
            name,
            email: `${name.toLowerCase()}@time.test`,
            password: "Isolated fixture password 42!",
            role: "user",
          },
        }),
      ),
    );
    const actors = await Promise.all(people.map((person) => domain.actor(person.user.id)));
    owner = actors[0]!;
    writer = actors[1]!;
    peer = actors[2]!;
    reader = actors[3]!;
    outsider = actors[4]!;
  });
  afterAll(async () => {
    await fixture?.close();
  });
  beforeEach(async () => {
    project = await domain.execute(
      "create_project",
      { key: `T${crypto.randomUUID().slice(0, 8).toUpperCase()}`, name: "Observed work" },
      owner,
    );
    for (const [email, role] of [
      ["writer@time.test", "writer"],
      ["peer@time.test", "writer"],
      ["reader@time.test", "reader"],
    ] as const)
      await domain.execute("set_member", { projectId: project.id, email, role }, owner);
    ticket = await domain.execute(
      "create_ticket",
      { projectId: project.id, title: "Observed work" },
      owner,
    );
  });
  const subject = () => ({ projectId: project.id, ticketId: ticket.id });
  const create = (extra: Record<string, unknown> = {}, actor = writer) =>
    domain.execute("create_time_entry", { ...subject(), startAt, ...extra }, actor);
  const list = (actor = writer) => domain.execute("list_time_entries", subject(), actor);

  it("keeps stable attribution, derives durations, paginates, and publishes versioned changes", async () => {
    const running = await create({ note: "Observed by a person" });
    expect(running).toMatchObject({
      ...subject(),
      startAt,
      endAt: null,
      durationMs: null,
      actorId: writer.id,
      version: 1,
    });
    const ended = await domain.execute(
      "update_time_entry",
      { ...subject(), timeEntryId: running.id, expectedVersion: 1, endAt },
      owner,
    );
    expect(ended).toMatchObject({
      id: running.id,
      actorId: writer.id,
      version: 2,
      durationMs: 90_250,
      createdAt: running.createdAt,
    });
    expect(
      await domain.execute(
        "get_time_entry",
        { ...subject(), ticketId: ticket.key, timeEntryId: running.id },
        reader,
      ),
    ).toEqual(ended);
    const zero = await create({ endAt: startAt });
    expect(zero.durationMs).toBe(0);
    expect(
      await domain.execute("list_time_entries", { ...subject(), limit: 1, offset: 1 }, reader),
    ).toEqual({ items: [ended], total: 2 });
    await expect(
      domain.execute(
        "delete_time_entry",
        { ...subject(), timeEntryId: zero.id, expectedVersion: 2 },
        writer,
      ),
    ).rejects.toMatchObject({ code: "version_conflict" });
    await domain.execute(
      "delete_time_entry",
      { ...subject(), timeEntryId: zero.id, expectedVersion: 1 },
      writer,
    );
    const events = (await domain.readEvents(owner, 0n, project.id)).items.filter((event) =>
      event.type.startsWith("time_entry."),
    );
    expect(events.map((event) => event.type)).toEqual([
      "time_entry.created",
      "time_entry.updated",
      "time_entry.created",
      "time_entry.deleted",
    ]);
    expect(events[1]).toMatchObject({
      actorId: owner.id,
      ticketId: ticket.id,
      data: { timeEntryId: running.id, version: 2 },
    });
  });
  it("settles concurrent starts and reopens against the original actor's running entry", async () => {
    const attempts = await Promise.allSettled([create(), create()]);
    expect(attempts.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(attempts.find((result) => result.status === "rejected")).toMatchObject({
      reason: { code: "time_entry_conflict" },
    });
    const active = (await list()).items[0]!;
    const closed = await domain.execute(
      "update_time_entry",
      { ...subject(), timeEntryId: active.id, expectedVersion: 1, endAt },
      writer,
    );
    await create();
    await expect(
      domain.execute(
        "update_time_entry",
        { ...subject(), timeEntryId: closed.id, expectedVersion: 2, endAt: null },
        owner,
      ),
    ).rejects.toMatchObject({ code: "time_entry_conflict" });
    // Other authors and tickets may have their own running ranges.
    await create({}, peer);
    const other = await domain.execute(
      "create_ticket",
      { projectId: project.id, title: "Other" },
      owner,
    );
    await create({ ticketId: other.id });
    expect((await list()).total).toBe(3);
  });
  it("rejects invalid ranges and stale updates without writing events or changing stored values", async () => {
    const before = (await domain.readEvents(owner, 0n, project.id)).items.length;
    await expect(create({ endAt: "2026-10-01T08:59:59.000Z" })).rejects.toMatchObject({
      code: "validation_error",
    });
    await expect(create({ startAt: "yesterday" })).rejects.toMatchObject({ name: "ZodError" });
    expect((await domain.readEvents(owner, 0n, project.id)).items).toHaveLength(before);
    const ended = await create({ endAt });
    await expect(
      domain.execute(
        "update_time_entry",
        {
          ...subject(),
          timeEntryId: ended.id,
          expectedVersion: 1,
          startAt: "2026-10-02T00:00:00.000Z",
        },
        writer,
      ),
    ).rejects.toMatchObject({ code: "validation_error" });
    await expect(
      domain.execute(
        "update_time_entry",
        { ...subject(), timeEntryId: ended.id, expectedVersion: 2, note: "stale" },
        writer,
      ),
    ).rejects.toMatchObject({ code: "version_conflict" });
    expect((await list()).items).toEqual([ended]);
  });
  it("replays create, update, and delete receipts exactly once and rejects changed payloads", async () => {
    const requestId = crypto.randomUUID(),
      running = await create({ requestId });
    expect(await create({ requestId })).toEqual(running);
    await expect(create({ requestId, note: "different" })).rejects.toMatchObject({
      code: "idempotency_conflict",
    });
    const update = {
      ...subject(),
      timeEntryId: running.id,
      expectedVersion: 1,
      endAt,
      requestId: crypto.randomUUID(),
    };
    const ended = await domain.execute("update_time_entry", update, writer);
    expect(await domain.execute("update_time_entry", update, writer)).toEqual(ended);
    const remove = {
      ...subject(),
      timeEntryId: running.id,
      expectedVersion: 2,
      requestId: crypto.randomUUID(),
    };
    await domain.execute("delete_time_entry", remove, writer);
    expect(await domain.execute("delete_time_entry", remove, writer)).toEqual({ ok: true });
    expect((await list()).total).toBe(0);
    expect(
      (await domain.readEvents(owner, 0n, project.id)).items.filter((event) =>
        event.type.startsWith("time_entry."),
      ),
    ).toHaveLength(3);
  });
  it("enforces project, ticket, author, role, credential, and claim boundaries", async () => {
    const ended = await create({ endAt });
    const update = { ...subject(), timeEntryId: ended.id, expectedVersion: 1, note: "edit" };
    for (const actor of [reader, peer]) {
      await expect(domain.execute("update_time_entry", update, actor)).rejects.toMatchObject({
        status: 403,
      });
      await expect(
        domain.execute(
          "delete_time_entry",
          { ...subject(), timeEntryId: ended.id, expectedVersion: 1 },
          actor,
        ),
      ).rejects.toMatchObject({ status: 403 });
    }
    await expect(create({}, reader)).rejects.toMatchObject({ status: 403 });
    await expect(list(outsider)).rejects.toMatchObject({ status: 404 });
    const other = await domain.execute(
      "create_ticket",
      { projectId: project.id, title: "Other" },
      owner,
    );
    await expect(
      domain.execute(
        "get_time_entry",
        { ...subject(), ticketId: other.id, timeEntryId: ended.id },
        writer,
      ),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      domain.execute("update_time_entry", { ...update, actorId: peer.id }, writer),
    ).rejects.toMatchObject({ name: "ZodError" });
    const worker = await domain.actor(writer.id, {
      ownerId: "test-worker",
      scopes: ["read", "write", "claim"],
      projectIds: [project.id],
    });
    const unclaimed = await create({}, worker);
    expect(unclaimed.actorId).toBe(writer.id);
    await domain.execute(
      "delete_time_entry",
      { ...subject(), timeEntryId: unclaimed.id, expectedVersion: 1 },
      worker,
    );
    ticket = await domain.execute(
      "update_ticket",
      {
        ...subject(),
        expectedVersion: ticket.version,
        changes: {
          description: "Record observed work",
          acceptanceCriteria: "Entries are attributed",
          difficulty: "med",
          automationReady: true,
        },
      },
      owner,
    );
    const claim = await domain.execute(
      "claim_ticket",
      { ...subject(), expectedVersion: ticket.version, workerId: "test-worker" },
      worker,
    );
    await expect(create({}, worker)).rejects.toMatchObject({ code: "claim_conflict" });
    await expect(domain.execute("update_time_entry", update, worker)).rejects.toMatchObject({
      code: "claim_conflict",
    });
    await expect(
      domain.execute(
        "delete_time_entry",
        { ...subject(), timeEntryId: ended.id, expectedVersion: 1 },
        worker,
      ),
    ).rejects.toMatchObject({ code: "claim_conflict" });
    expect(
      await domain.execute("update_time_entry", { ...update, claimId: claim.id }, worker),
    ).toMatchObject({ note: "edit", endAt, actorId: writer.id });
    expect(await create({ claimId: claim.id }, worker)).toMatchObject({ actorId: writer.id });
    const readOnly = await domain.actor(writer.id, {
      ownerId: "read-only",
      scopes: ["read"],
      projectIds: [project.id],
    });
    await expect(create({}, readOnly)).rejects.toMatchObject({ code: "insufficient_scope" });
    const foreign = await domain.actor(writer.id, {
      ownerId: "foreign",
      scopes: ["read", "write"],
      projectIds: [crypto.randomUUID()],
    });
    await expect(list(foreign)).rejects.toMatchObject({ status: 404 });
  });
  it("moves entries with their ticket and rejects old-project access and receipt replay", async () => {
    const requestId = crypto.randomUUID(),
      ended = await create({ requestId, endAt, note: "Private observation" });
    const destination = await domain.execute(
      "create_project",
      { key: `D${crypto.randomUUID().slice(0, 8).toUpperCase()}`, name: "Private destination" },
      owner,
    );
    await domain.execute(
      "relocate_ticket",
      { ...subject(), expectedVersion: ticket.version, destinationProjectId: destination.id },
      owner,
    );
    await expect(list()).rejects.toMatchObject({ status: 404 });
    await expect(create({ requestId, endAt, note: "Private observation" })).rejects.toMatchObject({
      status: 404,
    });
    await expect(
      domain.execute("get_time_entry", { ...subject(), timeEntryId: ended.id }, writer),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      domain.execute(
        "list_time_entries",
        { projectId: destination.id, ticketId: ticket.id },
        writer,
      ),
    ).rejects.toMatchObject({ status: 404 });
    expect(
      await domain.execute(
        "get_time_entry",
        { projectId: destination.id, ticketId: ticket.key, timeEntryId: ended.id },
        owner,
      ),
    ).toEqual({ ...ended, projectId: destination.id });
  });
  it("cascades ticket deletion and reports time entries omitted by ticket export", async () => {
    const ended = await create({ endAt });
    const bundle = await domain.execute("export_project", { projectId: project.id }, owner);
    expect(bundle.completeness.omitted).toContainEqual(
      expect.objectContaining({ content: "time entries", count: 1 }),
    );
    await domain.execute("delete_ticket", { ...subject(), expectedVersion: ticket.version }, owner);
    expect(
      (await fixture.database.pool.query("SELECT id FROM time_entries WHERE id = $1", [ended.id]))
        .rows,
    ).toEqual([]);
    await expect(list()).rejects.toMatchObject({ status: 404 });
  });
});
