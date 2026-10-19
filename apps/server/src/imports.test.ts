import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { and, count, eq, inArray } from "drizzle-orm";
import {
  mentionLink,
  type Operation,
  type Output,
  type Project,
  type TicketExport,
} from "@kanvil/contracts";
import { createFixture } from "./test-fixture.ts";
import { createDomain, type Actor, type Domain } from "./domain.ts";
import { processImports } from "./import-operations.ts";
import { deliverySecrets } from "./sealing.ts";
import { deliveries, events, importRecords, notifications, tickets } from "./schema.ts";

const prefix = (letter: string) =>
  `${letter}${crypto.randomUUID().replaceAll("-", "").slice(0, 8).toUpperCase()}`;
describe("ticket export and import runs", () => {
  let fixture: Awaited<ReturnType<typeof createFixture>>,
    domain: Domain,
    owner: Actor,
    writer: Actor,
    reader: Actor,
    source: Project,
    workspaceId: string,
    bundle: TicketExport,
    ids: { parent: string; child: string; blocker: string; small: string; size: string };
  beforeAll(async () => {
    fixture = await createFixture();
    domain = createDomain(fixture.database, { secrets: deliverySecrets(fixture.config) });
    const people = await Promise.all(
      ["Owner", "Writer", "Reader"].map((name) =>
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
    reader = await domain.actor(people[2]!.user.id);
    source = await domain.execute(
      "create_project",
      { key: prefix("S"), name: "Source", visibility: "workspace", description: "Origin" },
      owner,
    );
    workspaceId = source.workspaceId;
    for (const [email, role] of [
      ["writer@example.test", "writer"],
      ["reader@example.test", "reader"],
    ] as const)
      await domain.execute("set_workspace_member", { workspaceId, email, role }, owner);
    const projectId = source.id;
    const qa = await domain.execute(
      "create_workflow_state",
      { projectId, name: "QA", category: "in_review", color: "violet" },
      owner,
    );
    const size = await domain.execute(
      "create_custom_field",
      { projectId, name: "Size", type: "select", options: [{ name: "Small" }, { name: "Large" }] },
      owner,
    );
    await domain.execute("create_workspace_label", { workspaceId, name: "shared", color: "blue" }, owner);
    await domain.execute(
      "create_project_label",
      { projectId, name: "local", color: "#123456" },
      owner,
    );
    const small = size.options[0]!.id;
    const parent = await domain.execute(
      "create_ticket",
      {
        projectId,
        title: "Parent work",
        description: "Context",
        acceptanceCriteria: "It works",
        stateId: qa.id,
        priority: "high",
        kind: "bug",
        difficulty: "med",
        labels: ["shared", "local"],
        scopes: ["server"],
        assigneeId: writer.id,
        dueAt: "2031-01-02T23:59:59.000Z",
        customFields: { [size.id]: small },
      },
      owner,
    );
    const child = await domain.execute(
      "create_ticket",
      { projectId, title: "Child work", parentId: parent.id, archived: true },
      owner,
    );
    const blocker = await domain.execute(
      "create_ticket",
      { projectId, title: "Blocking work", status: "done" },
      owner,
    );
    await domain.execute(
      "add_relation",
      { projectId, ticketId: blocker.id, targetId: parent.id, type: "blocks" },
      owner,
    );
    await domain.execute(
      "add_comment",
      { projectId, ticketId: parent.id, body: `Over to ${mentionLink("Writer", writer.id)}` },
      owner,
    );
    await domain.execute(
      "add_evidence",
      {
        projectId,
        ticketId: parent.id,
        kind: "test",
        title: "Suite",
        url: "https://ci.example.test/runs/1",
        outcome: "passed",
      },
      owner,
    );
    await domain.execute(
      "add_resource",
      { projectId, ticketId: child.id, url: "https://github.com/example/repo/pull/1", title: "PR" },
      owner,
    );
    await domain.execute(
      "upload_attachment",
      {
        projectId,
        ticketId: blocker.id,
        name: "log.txt",
        data: Buffer.from("log").toString("base64"),
      },
      owner,
    );
    ids = { parent: parent.id, child: child.id, blocker: blocker.id, small, size: size.id };
    bundle = await domain.execute("export_project", { projectId }, reader);
  });
  afterAll(async () => {
    await fixture?.close();
  });
  const preview = (key: string, actor = owner, overrides: Partial<TicketExport> = {}) =>
    domain.execute(
      "preview_import",
      { workspaceId, key, name: `Imported ${key}`, visibility: "workspace", bundle: { ...bundle, ...overrides } },
      actor,
    );
  const start = (run: Output<"preview_import">, actor = owner) =>
    domain.execute(
      "start_import",
      { workspaceId, importId: run.id, expectedVersion: run.version },
      actor,
    );
  const drain = async (worker = domain) => {
    while (await processImports(worker));
  };
  const read = (importId: string) =>
    domain.execute("get_import", { workspaceId, importId }, owner);
  const writerNotifications = async () =>
    one(
      await fixture.database.db
        .select({ count: count() })
        .from(notifications)
        .where(eq(notifications.userId, writer.id)),
    ).count;
  const one = <T>(rows: T[]) => rows[0]!;

  it("exports a versioned bundle whose records reference each other by source ID", async () => {
    expect(bundle).toMatchObject({
      format: "kanvil.tickets",
      version: 1,
      project: { ref: source.id, key: source.key, name: "Source", description: "Origin" },
    });
    const parent = bundle.tickets.find((ticket) => ticket.ref === ids.parent)!;
    expect(parent).toMatchObject({
      title: "Parent work",
      priority: "high",
      kind: "bug",
      difficulty: "med",
      labels: ["shared", "local"],
      scopes: ["server"],
      assigneeRef: writer.id,
      dueAt: "2031-01-02T23:59:59.000Z",
      customFields: { [ids.size]: ids.small },
    });
    expect(bundle.workflow.find((state) => state.ref === parent.stateRef)).toMatchObject({
      name: "QA",
      category: "in_review",
    });
    expect(bundle.tickets.find((ticket) => ticket.ref === ids.child)).toMatchObject({
      parentRef: ids.parent,
      archived: true,
    });
    expect(bundle.relations).toEqual([
      { sourceRef: ids.blocker, targetRef: ids.parent, type: "blocks" },
    ]);
    expect(bundle.comments).toEqual([
      expect.objectContaining({ ticketRef: ids.parent, authorRef: owner.id }),
    ]);
    expect(bundle.evidence).toEqual([
      expect.objectContaining({ ticketRef: ids.parent, outcome: "passed", title: "Suite" }),
    ]);
    expect(bundle.resources).toEqual([
      expect.objectContaining({ ticketRef: ids.child, url: "https://github.com/example/repo/pull/1" }),
    ]);
    expect(bundle.labels).toEqual(
      expect.arrayContaining([
        { name: "local", color: "#123456" },
        { name: "shared", color: "blue" },
      ]),
    );
    expect(bundle.members.map((person) => person.email).toSorted()).toEqual([
      "owner@example.test",
      "writer@example.test",
    ]);
    // The completeness statement counts what stays behind.
    expect(bundle.completeness.omitted).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ content: "attachments", count: 1 }),
        expect.objectContaining({ content: "project settings", count: null }),
      ]),
    );
  });

  it("previews mapping problems and refuses to start a run with errors", async () => {
    const [first, second] = bundle.tickets;
    const broken = await preview(source.key, owner, {
      tickets: [
        { ...first!, stateRef: "missing", parentRef: second!.ref },
        { ...second!, parentRef: first!.ref, customFields: { [ids.size]: "not-an-option" } },
      ],
    });
    expect(broken.status).toBe("previewed");
    expect(broken.issues.filter((issue) => issue.severity === "error").map((issue) => issue.code))
      .toEqual(
        expect.arrayContaining([
          "duplicate_prefix",
          "unknown_state",
          "invalid_field_value",
          "dependency_cycle",
        ]),
      );
    expect(broken.progress.total).toBe(0);
    await expect(start(broken)).rejects.toMatchObject({ code: "import_blocked" });
    // In a private project only the importer and workspace administrators can be assigned.
    const hidden = await domain.execute(
      "preview_import",
      { workspaceId, key: prefix("H"), name: "Private", visibility: "private", bundle },
      owner,
    );
    expect(hidden.members.find((person) => person.email === "writer@example.test")?.userId).toBeNull();
    expect(hidden.issues).toEqual(
      expect.arrayContaining([expect.objectContaining({ severity: "warning", code: "unassigned" })]),
    );
  });

  it("imports a new project through the regular operations without notifying anyone", async () => {
    const before = await writerNotifications();
    const key = prefix("I"),
      run = await preview(key);
    expect(run.issues.filter((issue) => issue.severity === "error")).toEqual([]);
    expect(run.issues.map((issue) => issue.code)).toEqual(
      expect.arrayContaining(["new_keys", "authorship", "shared_label", "omitted"]),
    );
    expect(run.members.find((person) => person.email === "writer@example.test")?.userId).toBe(
      writer.id,
    );
    expect(run.counts).toMatchObject({ tickets: 3, relations: 1, comments: 1, evidence: 1, links: 1 });
    expect((await start(run)).status).toBe("running");
    await drain();
    const finished = await read(run.id);
    expect(finished).toMatchObject({
      status: "completed",
      key,
      errors: [],
      progress: { failed: 0, done: finished.progress.total },
    });
    const projectId = finished.projectId!;
    const imported = await domain.execute(
      "list_tickets",
      { projectId, archived: "include", sort: "number" },
      owner,
    );
    expect(imported.items.map((ticket) => ticket.title)).toEqual([
      "Parent work",
      "Child work",
      "Blocking work",
    ]);
    const [parent, child, blocker] = imported.items;
    const states = await domain.execute("list_workflow_states", { projectId }, owner);
    expect(states.find((state) => state.id === parent!.stateId)).toMatchObject({
      name: "QA",
      category: "in_review",
    });
    const [size] = await domain.execute("list_custom_fields", { projectId }, owner);
    expect(parent).toMatchObject({
      key: `${key}-1`,
      status: "in_review",
      assigneeId: writer.id,
      labels: ["shared", "local"],
      customFields: { [size!.id]: ids.small },
    });
    expect(child).toMatchObject({ parentId: parent!.id, archived: true });
    expect(blocker!.status).toBe("done");
    expect(await domain.execute("list_relations", { projectId, ticketId: parent!.id }, owner)).toEqual(
      [expect.objectContaining({ sourceId: blocker!.id, targetId: parent!.id, type: "blocks" })],
    );
    const discussion = await domain.execute("list_comments", { projectId, ticketId: parent!.id }, owner);
    expect(discussion.items[0]?.body).toMatch(/^Originally by Owner on \d{4}-\d{2}-\d{2}\.\n\nOver to/);
    expect(await domain.execute("list_evidence", { projectId, ticketId: parent!.id }, owner)).toEqual([
      expect.objectContaining({ outcome: "passed", note: expect.stringMatching(/^Originally by Owner/) }),
    ]);
    expect(
      (await domain.execute("list_resources", { projectId, ticketId: child!.id }, owner))[0]?.url,
    ).toBe("https://github.com/example/repo/pull/1");
    // Every write names the run, and none notified the assignee or the person mentioned.
    const written = await fixture.database.db
      .select()
      .from(events)
      .where(eq(events.projectId, projectId));
    expect(written.length).toBeGreaterThan(0);
    expect(written.every((event) => (event.data.import as { runId?: string })?.runId === run.id)).toBe(
      true,
    );
    expect(await writerNotifications()).toBe(before);
    // Settled records drop their staged payloads.
    expect(
      await fixture.database.db
        .select({ seq: importRecords.seq })
        .from(importRecords)
        .where(and(eq(importRecords.runId, run.id), inArray(importRecords.status, ["pending"]))),
    ).toEqual([]);
  });

  it("resumes after an interruption without writing anything twice", async () => {
    let interrupted = false;
    // The write commits, then the worker dies before it records the outcome.
    async function execute<K extends Operation>(
      name: K,
      value: unknown,
      actor: Actor,
      provenance?: { importRun: string },
    ) {
      const result = await domain.execute(name, value, actor, provenance);
      if (name === "create_ticket" && !interrupted) {
        interrupted = true;
        throw new Error("Simulated restart");
      }
      return result;
    }
    const run = await preview(prefix("R"));
    await start(run);
    await expect(processImports({ ...domain, execute })).rejects.toThrow("Simulated restart");
    expect((await read(run.id)).status).toBe("running");
    await drain();
    const finished = await read(run.id);
    expect(finished).toMatchObject({ status: "completed", progress: { failed: 0 } });
    const rows = await fixture.database.db
      .select({ id: tickets.id })
      .from(tickets)
      .where(eq(tickets.projectId, finished.projectId!));
    expect(rows).toHaveLength(3);
    const settled = await fixture.database.db
      .select({ targetId: importRecords.targetId })
      .from(importRecords)
      .where(and(eq(importRecords.runId, run.id), eq(importRecords.kind, "ticket")));
    expect(settled.map((record) => record.targetId).toSorted()).toEqual(
      rows.map((row) => row.id).toSorted(),
    );
  });

  it("stops a cancelled run and keeps runs private to the person who staged them", async () => {
    const run = await preview(prefix("C"));
    const started = await start(run);
    const cancelled = await domain.execute(
      "cancel_import",
      { workspaceId, importId: run.id, expectedVersion: started.version },
      owner,
    );
    expect(cancelled.status).toBe("cancelled");
    expect(await processImports(domain)).toBe(false);
    expect((await read(run.id)).projectId).toBeNull();
    await expect(
      domain.execute(
        "cancel_import",
        { workspaceId, importId: run.id, expectedVersion: cancelled.version },
        owner,
      ),
    ).rejects.toMatchObject({ code: "import_closed" });
    await expect(
      domain.execute("get_import", { workspaceId, importId: run.id }, writer),
    ).rejects.toMatchObject({ code: "not_found" });
    expect(await domain.execute("list_imports", { workspaceId }, writer)).toEqual([]);
    await expect(preview(prefix("D"), reader)).rejects.toMatchObject({ code: "forbidden" });
    const credential = await domain.actor(owner.id, {
      ownerId: owner.id,
      scopes: ["read", "write"],
    });
    await expect(preview(prefix("E"), credential)).rejects.toMatchObject({
      code: "session_required",
    });
  });

  it("keeps import writes out of project destinations", async () => {
    const run = await preview(prefix("Q"));
    await domain.execute(
      "create_project_destination",
      {
        projectId: source.id,
        name: "Audit hook",
        settings: { kind: "webhook", url: "http://127.0.0.1:9/hook" },
        events: ["created"],
      },
      owner,
    );
    const queued = async (ticketId: string) =>
      (
        await fixture.database.db
          .select({ id: deliveries.id })
          .from(deliveries)
          .innerJoin(events, eq(events.id, deliveries.eventId))
          .where(eq(events.ticketId, ticketId))
      ).length;
    const imported = await domain.execute(
      "create_ticket",
      { projectId: source.id, title: "Arrives by import" },
      owner,
      { importRun: run.id },
    );
    const live = await domain.execute(
      "create_ticket",
      { projectId: source.id, title: "Created live" },
      owner,
    );
    expect(await queued(imported.id)).toBe(0);
    expect(await queued(live.id)).toBe(1);
  });
});
