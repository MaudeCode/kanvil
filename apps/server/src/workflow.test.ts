import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vite-plus/test";
import { join } from "node:path";
import { createFixture } from "./test-fixture.ts";
import { createDomain, type Actor, type Domain } from "./domain.ts";
import type { Output, Project } from "@kanvil/contracts";

type States = Output<"list_workflow_states">;
const byName = (states: States, name: string) => {
  const state = states.find((item) => item.name === name);
  if (!state) throw new Error(`No ${name} state`);
  return state;
};
describe("project workflows on PostgreSQL", () => {
  let fixture: Awaited<ReturnType<typeof createFixture>>,
    domain: Domain,
    owner: Actor,
    writer: Actor,
    project: Project;
  beforeAll(async () => {
    fixture = await createFixture();
    domain = createDomain(fixture.database);
    const people = await Promise.all(
      ["Owner", "Writer"].map((name) =>
        fixture.auth.api.createUser({
          body: {
            name,
            email: `${name.toLowerCase()}@workflow.test`,
            password: "Isolated fixture password 42!",
            role: "user",
          },
        }),
      ),
    );
    owner = await domain.actor(people[0]!.user.id);
    writer = await domain.actor(people[1]!.user.id);
  });
  afterAll(async () => {
    await fixture?.close();
  });
  beforeEach(async () => {
    project = await domain.execute(
      "create_project",
      { key: `W${crypto.randomUUID().slice(0, 8).toUpperCase()}`, name: "Workflow project" },
      owner,
    );
  });
  const states = () => domain.execute("list_workflow_states", { projectId: project.id }, owner);
  const addState = (name: string, category: States[number]["category"]) =>
    domain.execute("create_workflow_state", { projectId: project.id, name, category }, owner);
  const ready = (title: string, extra: Record<string, unknown> = {}) =>
    domain.execute(
      "create_ticket",
      {
        projectId: project.id,
        title,
        description: "Implement the described behavior.",
        acceptanceCriteria: "The behavior is covered.",
        difficulty: "low",
        automationReady: true,
        ...extra,
      },
      owner,
    );
  const read = async (ticketId: string) =>
    (await domain.execute("get_ticket", { projectId: project.id, ticketId }, owner)).ticket;

  it("starts with the canonical states and keeps status-only clients working", async () => {
    const initial = await states();
    expect(initial.map(({ slug, category, position }) => ({ slug, category, position }))).toEqual(
      ["backlog", "todo", "in_progress", "in_review", "done", "cancelled"].map((slug) => ({
        slug,
        category: slug,
        position: 0,
      })),
    );
    const created = await domain.execute(
      "create_ticket",
      { projectId: project.id, title: "Default" },
      owner,
    );
    expect(created).toMatchObject({ status: "todo", stateId: byName(initial, "To do").id });
    const qa = await addState("QA", "in_review");
    // An older client that only knows statuses lands on the category's first state.
    const reviewed = await domain.execute(
      "update_ticket",
      {
        projectId: project.id,
        ticketId: created.id,
        expectedVersion: created.version,
        changes: { status: "in_review" },
      },
      owner,
    );
    expect(reviewed.stateId).toBe(byName(initial, "In review").id);
    // A newer client picks the custom state; a later status-only write of the same category keeps it.
    const moved = await domain.execute(
      "update_ticket",
      {
        projectId: project.id,
        ticketId: created.id,
        expectedVersion: reviewed.version,
        changes: { stateId: qa.id },
      },
      owner,
    );
    expect(moved).toMatchObject({ status: "in_review", stateId: qa.id });
    const kept = await domain.execute(
      "update_ticket",
      {
        projectId: project.id,
        ticketId: created.id,
        expectedVersion: moved.version,
        changes: { status: "in_review", title: "Renamed by an older client" },
      },
      owner,
    );
    expect(kept.stateId).toBe(qa.id);
    const events = (await domain.readEvents(owner, 0n, project.id)).items.filter(
      (event) => event.ticketId === created.id && event.type === "ticket.updated",
    );
    expect(events.at(-2)?.data.changedFields).toEqual(["stateId", "status"]);
  });

  it("adds, renames, reorders, and recategorizes states while tickets follow", async () => {
    const qa = await addState("QA", "in_review");
    expect(qa).toMatchObject({ slug: "qa", category: "in_review", position: 1, color: "default" });
    await expect(addState("qa", "done")).rejects.toMatchObject({ code: "duplicate_state" });
    await expect(
      domain.execute(
        "create_workflow_state",
        { projectId: project.id, name: "Writer state", category: "todo" },
        writer,
      ),
    ).rejects.toMatchObject({ status: 404 });
    const first = await domain.execute(
      "update_workflow_state",
      {
        projectId: project.id,
        stateId: qa.id,
        expectedVersion: qa.version,
        name: "Quality check",
        color: "#1e90ff",
        position: 0,
      },
      owner,
    );
    expect(first).toMatchObject({ slug: "qa", name: "Quality check", color: "#1e90ff" });
    expect(
      (await states()).filter((state) => state.category === "in_review").map((s) => s.name),
    ).toEqual(["Quality check", "In review"]);
    // The shifted sibling is versioned too, so a move based on the old order is refused.
    const review = byName(await states(), "In review");
    expect(review).toMatchObject({ position: 1, version: 2 });
    await expect(
      domain.execute(
        "update_workflow_state",
        { projectId: project.id, stateId: review.id, expectedVersion: 1, position: 0 },
        owner,
      ),
    ).rejects.toMatchObject({ code: "version_conflict" });
    await expect(
      domain.execute(
        "update_workflow_state",
        { projectId: project.id, stateId: qa.id, expectedVersion: qa.version, name: "Stale" },
        owner,
      ),
    ).rejects.toMatchObject({ code: "version_conflict" });

    const held = await ready("Held in QA", { stateId: qa.id });
    const archived = await ready("Archived in QA", { stateId: qa.id, archived: true });
    const before = (await domain.readEvents(owner, 0n, project.id)).cursor;
    const done = await domain.execute(
      "update_workflow_state",
      { projectId: project.id, stateId: qa.id, expectedVersion: first.version, category: "done" },
      owner,
    );
    expect(done).toMatchObject({ category: "done", position: 1 });
    for (const original of [held, archived])
      expect(await read(original.id)).toMatchObject({
        status: "done",
        stateId: qa.id,
        version: original.version + 1,
      });
    const published = (await domain.readEvents(owner, before, project.id)).items;
    expect(published.map((event) => [event.type, event.ticketId])).toEqual([
      ["ticket.updated", held.id],
      ["ticket.updated", archived.id],
      ["workflow.updated", null],
    ]);
    expect(published[0]?.data.changedFields).toEqual(["status"]);
    expect(
      (await states()).filter((state) => state.category === "in_review").map((s) => s.position),
    ).toEqual([0]);

    // The last state of a category cannot leave it, so every status keeps a state.
    const backlog = byName(await states(), "Backlog");
    await expect(
      domain.execute(
        "update_workflow_state",
        { projectId: project.id, stateId: backlog.id, expectedVersion: 1, category: "todo" },
        owner,
      ),
    ).rejects.toMatchObject({ code: "last_state" });
  });

  it("rejects inconsistent and foreign state writes instead of choosing a state", async () => {
    const initial = await states(),
      done = byName(initial, "Done");
    const other = await domain.execute(
      "create_project",
      { key: `O${crypto.randomUUID().slice(0, 8).toUpperCase()}`, name: "Other workflow" },
      owner,
    );
    const foreign = (
      await domain.execute("list_workflow_states", { projectId: other.id }, owner)
    )[0]!;
    await expect(
      domain.execute(
        "create_ticket",
        { projectId: project.id, title: "Mismatch", status: "todo", stateId: done.id },
        owner,
      ),
    ).rejects.toMatchObject({ code: "validation_error" });
    await expect(
      domain.execute(
        "create_ticket",
        { projectId: project.id, title: "Foreign", stateId: foreign.id },
        owner,
      ),
    ).rejects.toMatchObject({ code: "validation_error" });
    const current = await ready("Consistent");
    await expect(
      domain.execute(
        "update_ticket",
        {
          projectId: project.id,
          ticketId: current.id,
          expectedVersion: current.version,
          changes: { status: "in_progress", stateId: done.id },
        },
        owner,
      ),
    ).rejects.toMatchObject({ code: "validation_error" });
    await expect(
      domain.execute(
        "bulk_update_tickets",
        {
          projectId: project.id,
          tickets: [{ ticketId: current.id, expectedVersion: current.version }],
          changes: { stateId: foreign.id },
        },
        owner,
      ),
    ).rejects.toMatchObject({ code: "validation_error" });
    await expect(
      domain.execute(
        "update_ticket",
        {
          projectId: project.id,
          ticketId: current.id,
          expectedVersion: current.version + 1,
          changes: { stateId: done.id },
        },
        owner,
      ),
    ).rejects.toMatchObject({ code: "version_conflict" });
    await expect(
      domain.execute(
        "move_ticket",
        {
          projectId: project.id,
          ticketId: current.id,
          expectedVersion: current.version,
          status: "todo",
          stateId: done.id,
        },
        owner,
      ),
    ).rejects.toMatchObject({ code: "validation_error" });
    expect(await read(current.id)).toMatchObject({
      status: "todo",
      stateId: byName(initial, "To do").id,
      version: current.version,
    });
    // A move names a state the same way.
    const moved = await domain.execute(
      "move_ticket",
      {
        projectId: project.id,
        ticketId: current.id,
        expectedVersion: current.version,
        stateId: done.id,
      },
      owner,
    );
    expect(moved).toMatchObject({ status: "done", stateId: done.id });
  });

  it("deletes a state only after moving its tickets to a valid state", async () => {
    const qa = await addState("QA", "in_review"),
      initial = await states(),
      review = byName(initial, "In review");
    const held = await ready("Held", { stateId: qa.id }),
      archived = await ready("Archived", { stateId: qa.id, archived: true });
    const remove = (reassignTo: string, stateId = qa.id, expectedVersion = qa.version) =>
      domain.execute(
        "delete_workflow_state",
        { projectId: project.id, stateId, expectedVersion, reassignTo },
        owner,
      );
    await expect(remove(qa.id)).rejects.toMatchObject({ code: "validation_error" });
    await expect(remove(crypto.randomUUID())).rejects.toMatchObject({ code: "validation_error" });
    await expect(remove(review.id, qa.id, qa.version + 1)).rejects.toMatchObject({
      code: "version_conflict",
    });
    const backlog = byName(initial, "Backlog");
    await expect(remove(review.id, backlog.id, backlog.version)).rejects.toMatchObject({
      code: "last_state",
    });
    expect(byName(await states(), "QA").count).toBe(2);
    const done = byName(initial, "Done");
    await remove(done.id);
    for (const original of [held, archived])
      expect(await read(original.id)).toMatchObject({
        status: "done",
        stateId: done.id,
        version: original.version + 1,
      });
    const after = await states();
    expect(after.some((state) => state.id === qa.id)).toBe(false);
    expect(byName(after, "Done").count).toBe(2);
    expect(
      (await domain.readEvents(owner, 0n, project.id)).items.slice(-3).map((event) => event.type),
    ).toEqual(["ticket.updated", "ticket.updated", "workflow.deleted"]);
  });

  it("reads categories for readiness, dependencies, counts, filters, sorting, claims, and bulk edits", async () => {
    const queued = await addState("Queued", "todo"),
      building = await addState("Building", "in_progress"),
      shipped = await addState("Shipped", "done");
    // Claims move work to the first In progress state, wherever the project put it.
    await domain.execute(
      "update_workflow_state",
      {
        projectId: project.id,
        stateId: building.id,
        expectedVersion: building.version,
        position: 0,
      },
      owner,
    );
    const blocker = await ready("Blocker", { stateId: shipped.id }),
      work = await ready("Queued work", { stateId: queued.id });
    await domain.execute(
      "add_relation",
      { projectId: project.id, ticketId: blocker.id, targetId: work.id, type: "blocks" },
      owner,
    );
    const detail = await domain.execute(
      "get_ticket",
      { projectId: project.id, ticketId: work.id },
      owner,
    );
    expect(detail.readiness).toEqual({ ready: true, reasons: [] });
    const worker = await domain.actor(owner.id, {
      ownerId: "workflow-worker",
      scopes: ["read", "write", "claim"],
    });
    await domain.execute(
      "claim_ticket",
      { projectId: project.id, ticketId: work.id, expectedVersion: work.version, workerId: "w" },
      worker,
    );
    expect(await read(work.id)).toMatchObject({ status: "in_progress", stateId: building.id });
    // An administrator credential cannot move another worker's claimed ticket by recategorizing.
    const otherWorker = await domain.actor(owner.id, {
      ownerId: "another-worker",
      scopes: ["admin"],
    });
    const current = byName(await states(), "Building");
    await expect(
      domain.execute(
        "update_workflow_state",
        {
          projectId: project.id,
          stateId: current.id,
          expectedVersion: current.version,
          category: "done",
        },
        otherWorker,
      ),
    ).rejects.toMatchObject({ code: "claim_conflict" });
    expect(await read(work.id)).toMatchObject({ status: "in_progress" });

    const listed = await domain.execute("list_projects", {}, owner);
    expect(listed.find((row) => row.id === project.id)).toMatchObject({
      openTickets: 1,
      closedTickets: 1,
    });
    const closed = await domain.execute(
      "list_tickets",
      { projectId: project.id, status: ["done", "cancelled"] },
      owner,
    );
    expect(closed.items.map((ticket) => ticket.id)).toEqual([blocker.id]);
    const inState = await domain.execute(
      "list_tickets",
      { projectId: project.id, stateId: building.id },
      owner,
    );
    expect(inState.items.map((ticket) => ticket.id)).toEqual([work.id]);

    const extra = await ready("Bulk", { status: "backlog" });
    const bulk = await domain.execute(
      "bulk_update_tickets",
      {
        projectId: project.id,
        tickets: [{ ticketId: extra.id, expectedVersion: extra.version }],
        changes: { stateId: queued.id },
      },
      owner,
    );
    expect(bulk[0]).toMatchObject({ status: "todo", stateId: queued.id });
    const done = await domain.execute(
      "create_ticket",
      { projectId: project.id, title: "Plain done", status: "done" },
      owner,
    );
    const sorted = await domain.execute(
      "list_tickets",
      { projectId: project.id, sort: "status" },
      owner,
    );
    // Category first, then each state's place: Queued follows To do; Shipped follows Done.
    expect(sorted.items.map((ticket) => ticket.id)).toEqual([
      extra.id,
      work.id,
      done.id,
      blocker.id,
    ]);
  });
});

it("moves existing tickets onto the default states when upgrading", async () => {
  const { mkdtemp, mkdir, readFile, writeFile, copyFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { fileURLToPath } = await import("node:url");
  const { migrate } = await import("drizzle-orm/node-postgres/migrator");
  const { drizzle } = await import("drizzle-orm/node-postgres");
  const folder = await mkdtemp(join(tmpdir(), "kanvil-workflow-upgrade-"));
  let fixture: Awaited<ReturnType<typeof createFixture>> | undefined;
  try {
    const source = fileURLToPath(new URL("../drizzle/", import.meta.url));
    const journal = JSON.parse(await readFile(join(source, "meta/_journal.json"), "utf8"));
    journal.entries = journal.entries.filter(
      (entry: { tag: string }) => entry.tag < "0024_workflow_states",
    );
    await mkdir(join(folder, "meta"));
    await writeFile(join(folder, "meta/_journal.json"), JSON.stringify(journal));
    for (const entry of journal.entries)
      await copyFile(join(source, `${entry.tag}.sql`), join(folder, `${entry.tag}.sql`));
    const projectId = "00000000-0000-4000-8000-000000000021";
    fixture = await createFixture({
      beforeMigrate: async (database) => {
        await migrate(drizzle(database.pool), { migrationsFolder: folder });
        await database.pool.query(
          `INSERT INTO "user" (id, name, email, role) VALUES ('upgrader', 'Upgrader', 'upgrader@workflow.test', 'user')`,
        );
        const workspace = await database.pool.query<{ id: string }>(
          "SELECT id FROM workspaces LIMIT 1",
        );
        await database.pool.query(
          `INSERT INTO projects (id, key, name, workspace_id, next_number) VALUES ($1, 'UPG', 'Upgraded', $2, 4)`,
          [projectId, workspace.rows[0]!.id],
        );
        await database.pool.query(
          `INSERT INTO project_members (project_id, user_id, role) VALUES ($1, 'upgrader', 'admin')`,
          [projectId],
        );
        await database.pool.query(
          `INSERT INTO tickets (project_id, key, number, title, status, created_by) VALUES
            ($1, 'UPG-1', 1, 'Reviewing', 'in_review', 'upgrader'),
            ($1, 'UPG-2', 2, 'Finished', 'done', 'upgrader'),
            ($1, 'UPG-3', 3, 'Unknown status', 'blocked', 'upgrader')`,
          [projectId],
        );
      },
    });
    const domain = createDomain(fixture.database),
      upgrader = await domain.actor("upgrader");
    const workflow = await domain.execute("list_workflow_states", { projectId }, upgrader);
    expect(workflow.map((state) => [state.slug, state.count])).toEqual([
      ["backlog", 0],
      ["todo", 1],
      ["in_progress", 0],
      ["in_review", 1],
      ["done", 1],
      ["cancelled", 0],
    ]);
    const { items } = await domain.execute("list_tickets", { projectId, sort: "number" }, upgrader);
    expect(items.map((ticket) => [ticket.key, ticket.status, ticket.stateId])).toEqual([
      ["UPG-1", "in_review", byName(workflow, "In review").id],
      ["UPG-2", "done", byName(workflow, "Done").id],
      ["UPG-3", "todo", byName(workflow, "To do").id],
    ]);
  } finally {
    await fixture?.close();
    await rm(folder, { recursive: true, force: true });
  }
});
