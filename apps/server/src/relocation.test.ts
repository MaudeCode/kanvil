import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { createFixture } from "./test-fixture.ts";
import { createDomain, type Actor, type Domain } from "./domain.ts";
import type { Project } from "@kanvil/contracts";

const prefix = (letter: string) =>
  `${letter}${crypto.randomUUID().replaceAll("-", "").slice(0, 8).toUpperCase()}`;
describe("project prefixes and ticket moves", () => {
  let fixture: Awaited<ReturnType<typeof createFixture>>,
    domain: Domain,
    owner: Actor,
    writer: Actor,
    outsider: Actor;
  beforeAll(async () => {
    fixture = await createFixture();
    domain = createDomain(fixture.database);
    const people = await Promise.all(
      ["Owner", "Writer", "Outsider"].map((name) =>
        fixture.auth.api.createUser({
          body: {
            name,
            email: `${name.toLowerCase()}@example.test`,
            password: "Isolated fixture password 42!",
            role: "user",
          },
        }),
      ),
    );
    owner = await domain.actor(people[0]!.user.id);
    writer = await domain.actor(people[1]!.user.id);
    outsider = await domain.actor(people[2]!.user.id);
  });
  afterAll(async () => {
    await fixture?.close();
  });
  const newProject = (key = prefix("P")) =>
    domain.execute("create_project", { key, name: `Project ${key}` }, owner);
  const newTicket = (project: Project, title = "Movable work", actor = owner) =>
    domain.execute("create_ticket", { projectId: project.id, title }, actor);
  const rename = (project: Project, key: string, actor = owner) =>
    domain.execute(
      "update_project",
      {
        projectId: project.id,
        expectedVersion: project.version,
        name: project.name,
        description: project.description,
        key,
      },
      actor,
    );
  const share = (project: Project, role: "reader" | "writer" | null, actor = writer) =>
    domain.execute(
      "set_member",
      {
        projectId: project.id,
        email: `${actor === writer ? "writer" : "outsider"}@example.test`,
        role,
      },
      owner,
    );

  it("re-keys a project's tickets while every earlier key and prefix keeps resolving", async () => {
    const original = prefix("A"),
      project = await newProject(original),
      first = await newTicket(project),
      second = await newTicket(project);
    const renamed = await rename(project, prefix("B"));
    expect(renamed.key).not.toBe(original);
    expect(renamed.version).toBe(project.version + 1);
    // The project resolves under both prefixes, and each issued key reaches the same ticket.
    expect((await domain.execute("get_project", { projectId: original }, owner)).id).toBe(
      project.id,
    );
    const read = await domain.execute(
      "get_ticket",
      { projectId: original, ticketId: first.key },
      owner,
    );
    expect(read.ticket).toMatchObject({ id: first.id, key: `${renamed.key}-1`, version: 1 });
    expect(
      (await domain.execute("get_ticket", { projectId: renamed.key, ticketId: second.key }, owner))
        .ticket.key,
    ).toBe(`${renamed.key}-2`);
    // Old clients keep writing through old keys, still with version checks.
    await expect(
      domain.execute(
        "update_ticket",
        { projectId: original, ticketId: first.key, expectedVersion: 2, changes: { title: "x" } },
        owner,
      ),
    ).rejects.toMatchObject({ code: "version_conflict" });
    expect(
      (
        await domain.execute(
          "update_ticket",
          {
            projectId: original,
            ticketId: first.key,
            expectedVersion: 1,
            changes: { title: "Kept" },
          },
          owner,
        )
      ).key,
    ).toBe(`${renamed.key}-1`);
    // New allocations take the new prefix and keep counting.
    expect((await newTicket(project)).key).toBe(`${renamed.key}-3`);
    expect(
      (await domain.execute("search_tickets", { q: first.key }, owner)).items[0]?.ticket.id,
    ).toBe(first.id);
    const events = await domain.readEvents(owner, 0n, project.id);
    expect(events.items.find((event) => event.type === "project.updated")).toMatchObject({
      type: "project.updated",
      data: { key: renamed.key, previousKey: original },
    });
    // The old prefix stays reserved: no other project can take it, the owner can return to it.
    await expect(newProject(original)).rejects.toMatchObject({ code: "duplicate_prefix" });
    const other = await newProject();
    await expect(rename(other, original)).rejects.toMatchObject({ code: "duplicate_prefix" });
    await expect(rename(other, renamed.key)).rejects.toMatchObject({ code: "duplicate_prefix" });
    const restored = await rename(renamed, original);
    expect(restored.key).toBe(original);
    expect(
      (
        await domain.execute(
          "get_ticket",
          { projectId: renamed.key, ticketId: `${renamed.key}-3` },
          owner,
        )
      ).ticket.key,
    ).toBe(`${original}-3`);
  });

  it("limits prefix changes to project administrators with the current version", async () => {
    const project = await newProject();
    await share(project, "writer");
    await expect(rename(project, prefix("W"), writer)).rejects.toMatchObject({
      status: 403,
    });
    await expect(rename(project, prefix("O"), outsider)).rejects.toMatchObject({ status: 404 });
    await expect(
      rename({ ...project, version: project.version + 1 }, prefix("V")),
    ).rejects.toMatchObject({ code: "version_conflict" });
    await expect(rename(project, "bad-prefix")).rejects.toMatchObject({ name: "ZodError" });
  });

  it("moves a ticket with its content to a new key while the old key resolves", async () => {
    const source = await newProject(),
      destination = await newProject();
    await newTicket(destination, "Already here");
    const ticket = await domain.execute(
      "create_ticket",
      { projectId: source.id, title: "Movable work", status: "in_progress", labels: ["moving"] },
      owner,
    );
    await domain.execute(
      "add_comment",
      { projectId: source.id, ticketId: ticket.id, body: "Travels with the ticket" },
      owner,
    );
    const check = await domain.execute(
      "check_ticket_relocation",
      { projectId: source.id, ticketId: ticket.key, destinationProjectId: destination.key },
      owner,
    );
    expect(check.blockers).toEqual([]);
    expect(check.destination).toEqual({
      id: destination.id,
      key: destination.key,
      name: destination.name,
    });
    expect(check.states.find((state) => state.id === check.stateId)?.category).toBe("in_progress");
    const moved = await domain.execute(
      "relocate_ticket",
      {
        projectId: source.id,
        ticketId: ticket.key,
        expectedVersion: ticket.version,
        destinationProjectId: destination.id,
      },
      owner,
    );
    expect(moved).toMatchObject({
      id: ticket.id,
      projectId: destination.id,
      key: `${destination.key}-2`,
      number: 2,
      status: "in_progress",
      stateId: check.stateId,
      version: ticket.version + 1,
      labels: ["moving"],
    });
    // The old key resolves in the destination and across projects, never in the source.
    expect(
      (
        await domain.execute(
          "get_ticket",
          { projectId: destination.id, ticketId: ticket.key },
          owner,
        )
      ).ticket.id,
    ).toBe(ticket.id);
    await expect(
      domain.execute("get_ticket", { projectId: source.id, ticketId: ticket.key }, owner),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      domain.execute("get_ticket", { projectId: source.id, ticketId: ticket.id }, owner),
    ).rejects.toMatchObject({ status: 404 });
    expect(await domain.execute("resolve_ticket", { ticketId: ticket.key }, owner)).toMatchObject({
      ticket: { id: ticket.id, key: moved.key },
      project: { id: destination.id, key: destination.key },
    });
    expect(
      (
        await domain.execute(
          "list_comments",
          { projectId: destination.id, ticketId: moved.key },
          owner,
        )
      ).items.map((comment) => comment.body),
    ).toEqual(["Travels with the ticket"]);
    expect(
      (await domain.execute("list_ticket_labels", { projectId: destination.id }, owner)).map(
        (label) => label.name,
      ),
    ).toContain("moving");
    // The source only learns that a ticket left; the destination records where it came from.
    const left = (await domain.readEvents(owner, 0n, source.id)).items.at(-1);
    expect(left).toMatchObject({ type: "ticket.moved_away", ticketId: null });
    expect(JSON.stringify(left?.data)).not.toContain(destination.key);
    expect(JSON.stringify(left?.data)).not.toContain(destination.id);
    expect((await domain.readEvents(owner, 0n, destination.id)).items.at(-1)).toMatchObject({
      type: "ticket.moved",
      ticketId: ticket.id,
      data: { from: ticket.key, key: moved.key, version: moved.version },
    });
    // Moving on keeps every earlier key.
    const third = await newProject();
    const again = await domain.execute(
      "relocate_ticket",
      {
        projectId: destination.id,
        ticketId: ticket.key,
        expectedVersion: moved.version,
        destinationProjectId: third.id,
        status: "todo",
      },
      owner,
    );
    expect(again).toMatchObject({ key: `${third.key}-1`, status: "todo" });
    for (const key of [ticket.key, moved.key, again.key])
      expect((await domain.execute("resolve_ticket", { ticketId: key }, owner)).ticket.id).toBe(
        ticket.id,
      );
  });

  it("checks versions, states, and the destination before moving", async () => {
    const source = await newProject(),
      destination = await newProject(),
      ticket = await newTicket(source),
      move = (input: Record<string, unknown>, actor = owner) =>
        domain.execute(
          "relocate_ticket",
          {
            projectId: source.id,
            ticketId: ticket.id,
            expectedVersion: ticket.version,
            destinationProjectId: destination.id,
            ...input,
          },
          actor,
        );
    await expect(move({ expectedVersion: ticket.version + 1 })).rejects.toMatchObject({
      code: "version_conflict",
    });
    const foreignState = (
      await domain.execute("list_workflow_states", { projectId: source.id }, owner)
    )[0]!;
    await expect(move({ stateId: foreignState.id })).rejects.toMatchObject({ status: 400 });
    await expect(move({ destinationProjectId: source.id })).rejects.toMatchObject({ status: 400 });
    const elsewhere = await domain.execute(
      "create_workspace",
      { name: "Elsewhere", slug: `elsewhere-${crypto.randomUUID()}` },
      owner,
    );
    const foreign = await domain.execute(
      "create_project",
      { key: prefix("F"), name: "Foreign", workspaceId: elsewhere.id },
      owner,
    );
    await expect(move({ destinationProjectId: foreign.id })).rejects.toMatchObject({
      status: 400,
      message: "Tickets move only between projects of one workspace",
    });
    const archived = await domain.execute(
      "archive_project",
      { projectId: destination.id, expectedVersion: destination.version, archived: true },
      owner,
    );
    await expect(move({})).rejects.toMatchObject({ status: 409, code: "project_archived" });
    await domain.execute(
      "archive_project",
      { projectId: destination.id, expectedVersion: archived.version, archived: false },
      owner,
    );
    await expect(
      move({ destinationProjectId: "00000000-0000-4000-8000-000000000000" }),
    ).rejects.toMatchObject({ status: 404 });
  });

  it("names every claim, hierarchy, relationship, and assignee that blocks a move", async () => {
    const source = await newProject(),
      destination = await newProject();
    await share(source, "writer");
    const parent = await newTicket(source, "Parent"),
      child = await domain.execute(
        "create_ticket",
        { projectId: source.id, title: "Child", parentId: parent.id, assigneeId: writer.id },
        owner,
      ),
      linked = await newTicket(source, "Linked");
    await domain.execute(
      "add_relation",
      { projectId: source.id, ticketId: child.id, targetId: linked.id, type: "blocks" },
      owner,
    );
    const check = await domain.execute(
      "check_ticket_relocation",
      { projectId: source.id, ticketId: child.id, destinationProjectId: destination.id },
      owner,
    );
    expect(check.blockers.map((blocker) => blocker.code)).toEqual([
      "parent",
      "relations",
      "assignee",
    ]);
    expect(check.blockers[0]).toMatchObject({ ticketId: parent.id });
    expect(check.blockers[1]).toMatchObject({ ticketId: linked.id });
    expect(
      (
        await domain.execute(
          "check_ticket_relocation",
          { projectId: source.id, ticketId: parent.id, destinationProjectId: destination.id },
          owner,
        )
      ).blockers,
    ).toMatchObject([{ code: "children", ticketId: child.id }]);
    await expect(
      domain.execute(
        "relocate_ticket",
        {
          projectId: source.id,
          ticketId: child.id,
          expectedVersion: child.version,
          destinationProjectId: destination.id,
        },
        owner,
      ),
    ).rejects.toMatchObject({
      status: 409,
      code: "relocation_blocked",
      details: { blockers: check.blockers },
    });
    const ready = await domain.execute(
      "create_ticket",
      {
        projectId: source.id,
        title: "Claimed",
        description: "Work",
        acceptanceCriteria: "Done",
        difficulty: "low",
        automationReady: true,
      },
      owner,
    );
    await domain.execute(
      "claim_ticket",
      {
        projectId: source.id,
        ticketId: ready.id,
        expectedVersion: ready.version,
        workerId: "worker-1",
        leaseSeconds: 600,
      },
      owner,
    );
    expect(
      (
        await domain.execute(
          "check_ticket_relocation",
          { projectId: source.id, ticketId: ready.id, destinationProjectId: destination.id },
          owner,
        )
      ).blockers.map((blocker) => blocker.code),
    ).toEqual(["claimed"]);
  });

  it("keeps custom field values with their project and applies the destination's defaults", async () => {
    const source = await newProject(),
      destination = await newProject(),
      field = (project: Project, input: Record<string, unknown>) =>
        domain.execute("create_custom_field", { projectId: project.id, ...input }, owner);
    const estimate = await field(source, { name: "Estimate", type: "number" });
    await field(destination, { name: "Team", type: "text", required: true, defaultValue: "Core" });
    const ticket = await domain.execute(
      "create_ticket",
      { projectId: source.id, title: "Estimated", customFields: { [estimate.id]: 3 } },
      owner,
    );
    const check = (ticketId: string) =>
      domain.execute(
        "check_ticket_relocation",
        { projectId: source.id, ticketId, destinationProjectId: destination.id },
        owner,
      );
    expect((await check(ticket.id)).blockers).toMatchObject([
      { code: "custom_fields", message: "Clear its custom field values first: Estimate" },
    ]);
    const cleared = await domain.execute(
      "update_ticket",
      {
        projectId: source.id,
        ticketId: ticket.id,
        expectedVersion: ticket.version,
        changes: { customFields: { [estimate.id]: null } },
      },
      owner,
    );
    const moved = await domain.execute(
      "relocate_ticket",
      {
        projectId: source.id,
        ticketId: ticket.id,
        expectedVersion: cleared.version,
        destinationProjectId: destination.id,
      },
      owner,
    );
    expect(Object.values(moved.customFields)).toEqual(["Core"]);
    // A required destination field without a default has nothing to give a moved ticket.
    await field(destination, { name: "Owner", type: "text", required: true });
    expect((await check((await newTicket(source)).id)).blockers).toMatchObject([
      {
        code: "required_fields",
        message: "The destination requires fields without a default: Owner",
      },
    ]);
  });

  it("never lets an alias reach past destination access, bound credentials, or revocation", async () => {
    const source = await newProject(),
      destination = await newProject(),
      ticket = await newTicket(source);
    await share(source, "writer");
    // A destination the writer cannot reach reads as not found; a read-only one is refused.
    const attempt = (actor: Actor, requestId?: string) =>
      domain.execute(
        "relocate_ticket",
        {
          projectId: source.id,
          ticketId: ticket.id,
          expectedVersion: ticket.version,
          destinationProjectId: destination.id,
          ...(requestId ? { requestId } : {}),
        },
        actor,
      );
    await expect(attempt(writer)).rejects.toMatchObject({ status: 404, code: "not_found" });
    await expect(
      domain.execute(
        "check_ticket_relocation",
        { projectId: source.id, ticketId: ticket.id, destinationProjectId: destination.key },
        writer,
      ),
    ).rejects.toMatchObject({ status: 404 });
    await share(destination, "reader");
    await expect(attempt(writer)).rejects.toMatchObject({ status: 403 });
    // A credential bound to the source cannot move tickets out of it.
    const bound = await domain.actor(writer.id, {
      ownerId: writer.id,
      scopes: ["read", "write"],
      projectIds: [source.id],
    });
    await share(destination, "writer");
    await expect(attempt(bound)).rejects.toMatchObject({ status: 404 });
    const requestId = crypto.randomUUID(),
      moved = await attempt(writer, requestId);
    // Retrying the same request answers from its receipt while the writer can still reach both ends.
    expect(await attempt(writer, requestId)).toEqual(moved);
    // Someone left behind in the source cannot follow the old key.
    await share(source, "reader", outsider);
    for (const ticketId of [ticket.key, ticket.id, moved.key])
      await expect(domain.execute("resolve_ticket", { ticketId }, outsider)).rejects.toMatchObject({
        status: 404,
        code: "not_found",
      });
    // Activity left in the source never describes the ticket as it is now.
    const found = await domain.execute(
      "search_workspace",
      { q: "Ticket created", workspaceId: source.workspaceId },
      outsider,
    );
    const history = found.items.filter((item) => item.type === "activity");
    expect(history.length).toBeGreaterThan(0);
    expect(history.every((item) => item.ticket === null)).toBe(true);
    expect(JSON.stringify(found)).not.toContain(moved.key);
    expect(
      (
        await domain.execute(
          "search_workspace",
          { q: "Ticket created", workspaceId: source.workspaceId, status: "todo" },
          outsider,
        )
      ).items,
    ).toEqual([]);
    await expect(
      domain.execute("resolve_ticket", { ticketId: ticket.key }, bound),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      domain.execute("resolve_ticket", { ticketId: `${source.key}-999` }, owner),
    ).rejects.toMatchObject({ status: 404 });
    // Revoking destination access closes the alias and the stored receipt alike.
    expect(
      (await domain.execute("resolve_ticket", { ticketId: ticket.key }, writer)).ticket.id,
    ).toBe(ticket.id);
    await share(destination, null);
    await expect(
      domain.execute("resolve_ticket", { ticketId: ticket.key }, writer),
    ).rejects.toMatchObject({ status: 404 });
    await expect(attempt(writer, requestId)).rejects.toMatchObject({ status: 404 });
  });

  it("serializes concurrent allocations, moves, and prefix changes without reusing a key", async () => {
    const source = await newProject(),
      destination = await newProject();
    const tickets = await Promise.all([1, 2, 3, 4].map(() => newTicket(source)));
    const writes = await Promise.allSettled([
      ...tickets.map((ticket) =>
        domain.execute(
          "relocate_ticket",
          {
            projectId: source.id,
            ticketId: ticket.id,
            expectedVersion: ticket.version,
            destinationProjectId: destination.id,
          },
          owner,
        ),
      ),
      ...[1, 2, 3].map(() => newTicket(destination)),
      rename(destination, prefix("R")),
      ...[1, 2].map(() => newTicket(source)),
    ]);
    expect(writes.filter((write) => write.status === "rejected")).toEqual([]);
    const current = await domain.execute("get_project", { projectId: destination.id }, owner);
    const listed = await domain.execute(
      "list_tickets",
      { projectId: destination.id, limit: 100 },
      owner,
    );
    expect(listed.items.map((item) => item.number).toSorted((a, b) => a - b)).toEqual([
      1, 2, 3, 4, 5, 6, 7,
    ]);
    expect(listed.items.every((item) => item.key === `${current.key}-${item.number}`)).toBe(true);
    // Every key ever issued names exactly one ticket.
    for (const ticket of tickets)
      expect(
        (await domain.execute("resolve_ticket", { ticketId: ticket.key }, owner)).ticket.id,
      ).toBe(ticket.id);
    expect(
      (await domain.execute("list_tickets", { projectId: source.id }, owner)).items.map(
        (item) => item.number,
      ),
    ).toEqual([5, 6]);
  });
});
