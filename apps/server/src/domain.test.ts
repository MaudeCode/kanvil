import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vite-plus/test";
import { eq } from "drizzle-orm";
import { createFixture } from "./test-fixture.ts";
import { notifications } from "./schema.ts";
import { createDomain, requireRow, type Actor, type Domain } from "./domain.ts";
import { relationReference, relationChoices, type Project } from "@kanvil/contracts";

const sorted = (...rows: { id: string }[]) => rows.map((row) => row.id).toSorted();
describe("ticket operations on PostgreSQL", () => {
  let fixture: Awaited<ReturnType<typeof createFixture>>,
    domain: Domain,
    owner: Actor,
    writer: Actor,
    outsider: Actor,
    project: Project;
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
  beforeEach(async () => {
    project = await domain.execute(
      "create_project",
      { key: `K${crypto.randomUUID().slice(0, 8).toUpperCase()}`, name: "Isolated project" },
      owner,
    );
  });
  const ticket = (title = "A deliverable ticket") =>
    domain.execute(
      "create_ticket",
      {
        projectId: project.id,
        title,
        description: "Implement the described behavior.",
        acceptanceCriteria: "The regression is covered and checks pass.",
        difficulty: "med",
        automationReady: true,
      },
      owner,
    );
  it("lists all project labels with archive-aware counts and sorts labels before pagination", async () => {
    const rows = [];
    for (const [title, labels] of [
      ["Zebra", ["zeta"]],
      ["Two labels", ["beta", "alpha"]],
      ["Capital", ["ALPHA"]],
      ["Unlabelled", []],
      ["Literal punctuation", ["red,blue", "O'Reilly"]],
    ] as const)
      rows.push(
        await domain.execute("create_ticket", { projectId: project.id, title, labels }, owner),
      );
    const labels = await domain.execute("list_ticket_labels", { projectId: project.id }, owner);
    expect(labels).toEqual([
      { name: "ALPHA", count: 1 },
      { name: "alpha", count: 1 },
      { name: "beta", count: 1 },
      { name: "O'Reilly", count: 1 },
      { name: "red,blue", count: 1 },
      { name: "zeta", count: 1 },
    ]);
    expect(
      (
        await domain.execute(
          "list_tickets",
          { projectId: project.id, sort: "labels", limit: 2, offset: 1 },
          owner,
        )
      ).items.map((t) => t.id),
    ).toEqual([rows[2]!.id, rows[4]!.id]);
    const all = await domain.execute(
      "list_tickets",
      { projectId: project.id, sort: "labels" },
      owner,
    );
    expect(all.items.at(-1)?.id).toBe(rows[3]!.id);
    expect(
      (
        await domain.execute("list_tickets", { projectId: project.id, label: "O'Reilly" }, owner)
      ).items.map((t) => t.id),
    ).toEqual([rows[4]!.id]);
    await domain.execute(
      "update_ticket",
      {
        projectId: project.id,
        ticketId: rows[0]!.id,
        expectedVersion: 1,
        changes: { archived: true },
      },
      owner,
    );
    expect(
      (await domain.execute("list_ticket_labels", { projectId: project.id }, owner)).some(
        (l) => l.name === "zeta",
      ),
    ).toBe(false);
    expect(
      await domain.execute(
        "list_ticket_labels",
        { projectId: project.id, archived: "only" },
        owner,
      ),
    ).toEqual([{ name: "zeta", count: 1 }]);
    expect(
      (
        await domain.execute(
          "list_ticket_labels",
          { projectId: project.id, archived: "include" },
          owner,
        )
      ).find((l) => l.name === "zeta")?.count,
    ).toBe(1);
    await expect(
      domain.execute("list_ticket_labels", { projectId: project.id }, outsider),
    ).rejects.toMatchObject({ status: 404 });
  });
  it("manages label colors and atomically renames and deletes ticket and saved-view references", async () => {
    const first = await domain.execute(
      "create_ticket",
      { projectId: project.id, title: "Active labelled ticket", labels: ["bug", "keep"] },
      owner,
    );
    const archived = await domain.execute(
      "create_ticket",
      { projectId: project.id, title: "Archived labelled ticket", labels: ["bug"] },
      owner,
    );
    await domain.execute(
      "update_ticket",
      {
        projectId: project.id,
        ticketId: archived.id,
        expectedVersion: 1,
        changes: { archived: true },
      },
      owner,
    );
    const catalog = await domain.execute("list_project_labels", { projectId: project.id }, owner);
    const bug = catalog.find((label) => label.name === "bug")!;
    expect(bug).toMatchObject({ color: "gray", count: 2, version: 1 });
    const unused = await domain.execute(
      "create_project_label",
      { projectId: project.id, name: "planned", color: "purple" },
      owner,
    );
    expect(
      (await domain.execute("list_project_labels", { projectId: project.id }, owner)).find(
        (label) => label.id === unused.id,
      ),
    ).toMatchObject({ color: "purple", count: 0 });
    await domain.execute(
      "save_view",
      { projectId: project.id, name: "Bug work", filters: { label: "bug", priority: "high" } },
      owner,
    );
    const cursor = (await domain.snapshot(owner, project.id)).cursor;
    const recolored = await domain.execute(
      "update_project_label",
      { projectId: project.id, labelId: bug.id, expectedVersion: 1, name: "bug", color: "red" },
      owner,
    );
    expect(
      (await domain.execute("get_ticket", { projectId: project.id, ticketId: first.id }, owner))
        .ticket.version,
    ).toBe(1);
    const renamed = await domain.execute(
      "update_project_label",
      {
        projectId: project.id,
        labelId: bug.id,
        expectedVersion: recolored.version,
        name: "defect, server",
        color: "orange",
      },
      owner,
    );
    expect(renamed).toMatchObject({
      id: bug.id,
      name: "defect, server",
      color: "orange",
      version: 3,
    });
    expect(
      (await domain.execute("get_ticket", { projectId: project.id, ticketId: first.id }, owner))
        .ticket,
    ).toMatchObject({ labels: ["defect, server", "keep"], version: 2 });
    expect(
      (await domain.execute("get_ticket", { projectId: project.id, ticketId: archived.id }, owner))
        .ticket,
    ).toMatchObject({ labels: ["defect, server"], archived: true, version: 3 });
    expect(
      (await domain.execute("list_views", { projectId: project.id }, owner))[0]?.filters,
    ).toMatchObject({ label: ["defect, server"], priority: "high" });
    expect(
      (
        await domain.execute(
          "list_tickets",
          { projectId: project.id, label: "defect, server" },
          owner,
        )
      ).total,
    ).toBe(1);
    await expect(
      domain.execute(
        "update_ticket",
        {
          projectId: project.id,
          ticketId: first.id,
          expectedVersion: 1,
          changes: { labels: ["bug"] },
        },
        owner,
      ),
    ).rejects.toMatchObject({ code: "version_conflict" });
    await expect(
      domain.execute(
        "update_project_label",
        {
          projectId: project.id,
          labelId: bug.id,
          expectedVersion: 1,
          name: "stale",
          color: "blue",
        },
        owner,
      ),
    ).rejects.toMatchObject({ code: "version_conflict" });
    await expect(
      domain.execute(
        "update_project_label",
        {
          projectId: project.id,
          labelId: bug.id,
          expectedVersion: renamed.version,
          name: "planned",
          color: "blue",
        },
        owner,
      ),
    ).rejects.toMatchObject({ code: "duplicate_label" });
    await domain.execute(
      "delete_project_label",
      { projectId: project.id, labelId: bug.id, expectedVersion: renamed.version },
      owner,
    );
    expect(
      (await domain.execute("get_ticket", { projectId: project.id, ticketId: first.id }, owner))
        .ticket.labels,
    ).toEqual(["keep"]);
    expect(
      (await domain.execute("get_ticket", { projectId: project.id, ticketId: archived.id }, owner))
        .ticket.labels,
    ).toEqual([]);
    expect(
      (await domain.execute("list_views", { projectId: project.id }, owner))[0]?.filters,
    ).not.toHaveProperty("label");
    expect(
      (await domain.execute("list_views", { projectId: project.id }, owner))[0]?.filters.priority,
    ).toBe("high");
    const events = (await domain.readEvents(owner, BigInt(cursor), project.id)).items;
    expect(events.filter((event) => event.type === "ticket.updated")).toHaveLength(4);
    expect(
      events.filter((event) => event.type.startsWith("label.")).map((event) => event.type),
    ).toEqual(["label.updated", "label.updated", "label.deleted"]);
  });
  it("renames labels inside saved list, exclusion, and legacy single-value filters", async () => {
    const alpha = await domain.execute(
      "create_project_label",
      { projectId: project.id, name: "alpha" },
      owner,
    );
    await domain.execute(
      "save_view",
      { projectId: project.id, name: "Lists", filters: { label: ["alpha"], labelNot: ["beta"] } },
      owner,
    );
    await fixture.database.pool.query(
      `INSERT INTO saved_views (project_id, user_id, name, filters) VALUES ($1, $2, 'Legacy', $3)`,
      [project.id, owner.id, JSON.stringify({ label: "alpha", status: "todo" })],
    );
    await domain.execute(
      "update_project_label",
      { projectId: project.id, labelId: alpha.id, expectedVersion: 1, name: "beta", color: "gray" },
      owner,
    );
    const saved = await domain.execute("list_views", { projectId: project.id }, owner);
    expect(saved.find((view) => view.name === "Legacy")?.filters).toMatchObject({
      label: ["beta"],
      status: "todo",
    });
    // The included label wins when a rename lands on a name the view excluded.
    const lists = saved.find((view) => view.name === "Lists")?.filters;
    expect(lists).toMatchObject({ label: ["beta"] });
    expect(lists).not.toHaveProperty("labelNot");
  });
  it("keeps custom label colors in a site-wide palette until removed", async () => {
    const label = await domain.execute(
      "create_project_label",
      { projectId: project.id, name: "Brand", color: "#1E90FF" },
      owner,
    );
    expect(label.color).toBe("#1e90ff");
    expect(
      (await domain.execute("list_label_colors", {}, outsider)).map((entry) => entry.value),
    ).toContain("#1e90ff");
    await expect(
      domain.execute(
        "create_project_label",
        { projectId: project.id, name: "Bad", color: "blueish" },
        owner,
      ),
    ).rejects.toMatchObject({ name: "ZodError" });
    await domain.execute(
      "set_member",
      { projectId: project.id, email: "writer@example.test", role: "writer" },
      owner,
    );
    await expect(
      domain.execute("remove_label_color", { value: "#1e90ff" }, writer),
    ).rejects.toMatchObject({ status: 403 });
    const cursor = (await domain.readEvents(owner, 0n, project.id)).cursor;
    await domain.execute("remove_label_color", { value: "#1e90ff" }, owner);
    expect(
      (await domain.execute("list_label_colors", {}, owner)).map((entry) => entry.value),
    ).not.toContain("#1e90ff");
    expect(
      (await domain.readEvents(owner, cursor, project.id)).items.map((event) => [
        event.type,
        event.data.value,
      ]),
    ).toEqual([["label.color_removed", "#1e90ff"]]);
    expect(
      (await domain.execute("list_project_labels", { projectId: project.id }, owner)).find(
        (entry) => entry.id === label.id,
      )?.color,
    ).toBe("#1e90ff");
  });
  it("enforces label administration, project isolation, and idempotent creation", async () => {
    await domain.execute(
      "set_member",
      { projectId: project.id, email: "writer@example.test", role: "writer" },
      owner,
    );
    const requestId = crypto.randomUUID();
    const input = { projectId: project.id, name: "Shared name", color: "green", requestId };
    const label = await domain.execute("create_project_label", input, owner);
    expect(await domain.execute("create_project_label", input, owner)).toEqual(label);
    await expect(
      domain.execute("create_project_label", { projectId: project.id, name: "Shared name" }, owner),
    ).rejects.toMatchObject({ code: "duplicate_label" });
    expect(
      await domain.execute("list_project_labels", { projectId: project.id }, writer),
    ).toHaveLength(1);
    await expect(
      domain.execute("create_project_label", { projectId: project.id, name: "Denied" }, writer),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      domain.execute(
        "update_project_label",
        {
          projectId: project.id,
          labelId: label.id,
          expectedVersion: 1,
          name: "Denied",
          color: "red",
        },
        writer,
      ),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      domain.execute(
        "delete_project_label",
        { projectId: project.id, labelId: label.id, expectedVersion: 1 },
        writer,
      ),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      domain.execute("list_project_labels", { projectId: project.id }, outsider),
    ).rejects.toMatchObject({ status: 404 });
    const other = await domain.execute(
      "create_project",
      { key: `L${crypto.randomUUID().slice(0, 8).toUpperCase()}`, name: "Other label project" },
      owner,
    );
    await expect(
      domain.execute(
        "delete_project_label",
        { projectId: other.id, labelId: label.id, expectedVersion: 1 },
        owner,
      ),
    ).rejects.toMatchObject({ status: 404 });
    await domain.execute(
      "create_ticket",
      { projectId: project.id, title: "Agent freeform label", labels: ["new from agent"] },
      writer,
    );
    expect(
      (await domain.execute("list_project_labels", { projectId: project.id }, owner)).find(
        (item) => item.name === "new from agent",
      ),
    ).toMatchObject({ color: "gray", count: 1 });
  });
  it("lists the tickets linked to a ticket in either direction", async () => {
    const current = await ticket("Linked hub"),
      blocker = await ticket("Blocks the hub"),
      peer = await ticket("Related to the hub"),
      unrelated = await ticket("Not linked");
    for (const [ticketId, targetId, type] of [
      [blocker.id, current.id, "blocks"],
      [current.id, peer.id, "related"],
    ] as const)
      await domain.execute(
        "add_relation",
        { projectId: project.id, ticketId, targetId, type },
        owner,
      );
    const linked = await domain.execute(
      "list_tickets",
      { projectId: project.id, relatedTo: current.key, archived: "include", sort: "number" },
      owner,
    );
    expect(linked.items.map((item) => item.id)).toEqual([blocker.id, peer.id]);
    expect(linked.items.map((item) => item.id)).not.toContain(unrelated.id);
  });
  it("normalizes incoming relationships, preserves inverse wording, and enforces blockers", async () => {
    const current = await ticket("Current work"),
      other = await ticket("Selected work");
    for (const choice of relationChoices) {
      const relation = await domain.execute(
        "add_relation",
        {
          projectId: project.id,
          ticketId: current.id,
          targetId: other.id,
          type: choice.type,
          direction: choice.direction,
        },
        owner,
      );
      expect(relationReference(relation, current.id).label).toBe(choice.label);
      if (choice.type !== "related")
        expect(relation.sourceId).toBe(choice.direction === "incoming" ? other.id : current.id);
      await domain.execute(
        "remove_relation",
        { projectId: project.id, relationId: relation.id },
        owner,
      );
    }
    const incoming = await domain.execute(
      "add_relation",
      {
        projectId: project.id,
        ticketId: current.id,
        targetId: other.id,
        type: "blocks",
        direction: "incoming",
      },
      owner,
    );
    const outgoing = await domain.execute(
      "add_relation",
      { projectId: project.id, ticketId: other.id, targetId: current.id, type: "blocks" },
      owner,
    );
    expect(outgoing.id).toBe(incoming.id);
    for (const ticketId of [current.id, other.id]) {
      const activity = await domain.execute(
        "list_activity",
        { projectId: project.id, ticketId },
        owner,
      );
      expect(activity.items).toContainEqual(expect.objectContaining({ type: "relation.added" }));
    }
    expect(
      (await domain.execute("get_ticket", { projectId: project.id, ticketId: current.id }, owner))
        .readiness.reasons,
    ).toContainEqual(expect.objectContaining({ code: "dependency", ticketId: other.id }));
    await expect(
      domain.execute(
        "add_relation",
        {
          projectId: project.id,
          ticketId: other.id,
          targetId: current.id,
          type: "blocks",
          direction: "incoming",
        },
        owner,
      ),
    ).rejects.toMatchObject({ code: "dependency_cycle" });
    await domain.execute(
      "remove_relation",
      { projectId: project.id, relationId: incoming.id },
      owner,
    );
    await domain.execute(
      "add_relation",
      {
        projectId: project.id,
        ticketId: current.id,
        targetId: other.id,
        type: "causes",
        direction: "incoming",
      },
      owner,
    );
    expect(
      (await domain.execute("get_ticket", { projectId: project.id, ticketId: current.id }, owner))
        .readiness.ready,
    ).toBe(true);
  });
  it("deduplicates retried writes and rejects reuse for different work", async () => {
    const requestId = crypto.randomUUID(),
      input = { projectId: project.id, title: "Retry me", requestId };
    const first = await domain.execute("create_ticket", input, owner),
      second = await domain.execute("create_ticket", input, owner);
    expect(first).toEqual(second);
    expect((await domain.execute("list_tickets", { projectId: project.id }, owner)).total).toBe(1);
    await expect(
      domain.execute("create_ticket", { ...input, title: "Different work" }, owner),
    ).rejects.toMatchObject({ code: "idempotency_conflict" });
    expect((await ticket("Next ticket")).number).toBe(2);
  });
  it("duplicates requirements and properties once per request and resets ownership", async () => {
    await domain.execute(
      "set_member",
      { projectId: project.id, email: "writer@example.test", role: "writer" },
      owner,
    );
    const parent = await ticket("Parent");
    const created = await domain.execute(
      "create_ticket",
      {
        projectId: project.id,
        title: "x".repeat(500),
        description: "Copied description",
        acceptanceCriteria: "Copied criteria",
        priority: "high",
        kind: "bug",
        difficulty: "high",
        dueAt: "2030-01-01T00:00:00.000Z",
        labels: ["web"],
        scopes: ["server"],
        assigneeId: writer.id,
        parentId: parent.id,
        automationReady: true,
      },
      owner,
    );
    await domain.execute(
      "add_comment",
      { projectId: project.id, ticketId: created.id, body: "Not copied" },
      owner,
    );
    const worker = await domain.actor(owner.id, { ownerId: "worker", scopes: ["read", "claim"] });
    await domain.execute(
      "claim_ticket",
      { projectId: project.id, ticketId: created.id, workerId: "w1", expectedVersion: 1 },
      worker,
    );
    await ticket("Child").then((child) =>
      domain.execute(
        "update_ticket",
        {
          projectId: project.id,
          ticketId: child.id,
          expectedVersion: child.version,
          changes: { parentId: created.id },
        },
        owner,
      ),
    );
    const requestId = crypto.randomUUID(),
      input = { projectId: project.id, ticketId: created.key, requestId };
    const copy = await domain.execute("duplicate_ticket", input, writer);
    expect(await domain.execute("duplicate_ticket", input, writer)).toEqual(copy);
    expect(copy).toMatchObject({
      title: `${"x".repeat(493)} (copy)`,
      description: "Copied description",
      acceptanceCriteria: "Copied criteria",
      status: "todo",
      priority: "high",
      kind: "bug",
      difficulty: "high",
      dueAt: "2030-01-01T00:00:00.000Z",
      labels: ["web"],
      scopes: ["server"],
      assigneeId: writer.id,
      parentId: parent.id,
      automationReady: false,
      claimRequired: false,
      archived: false,
      createdBy: writer.id,
      version: 1,
    });
    expect(copy.key).not.toBe(created.key);
    const read = await domain.execute(
      "get_ticket",
      { projectId: project.id, ticketId: copy.id },
      owner,
    );
    expect(read.claim).toBeNull();
    for (const [operation, filter] of [
      ["list_comments", { ticketId: copy.id }],
      ["list_tickets", { parentId: copy.id }],
    ] as const)
      expect(
        (await domain.execute(operation, { projectId: project.id, ...filter }, owner)).total,
      ).toBe(0);
    expect(
      await domain.execute("list_relations", { projectId: project.id, ticketId: copy.id }, owner),
    ).toEqual([
      expect.objectContaining({ sourceId: copy.id, targetId: created.id, type: "clones" }),
    ]);
    const activity = await domain.execute(
      "list_activity",
      { projectId: project.id, ticketId: copy.id },
      owner,
    );
    expect(activity.items.filter((event) => event.type === "ticket.created")).toEqual([
      expect.objectContaining({
        actorId: writer.id,
        data: expect.objectContaining({ duplicateOf: created.id }),
      }),
    ]);
    const second = await domain.execute(
      "duplicate_ticket",
      { ...input, requestId: crypto.randomUUID() },
      writer,
    );
    expect(second.id).not.toBe(copy.id);
    // Workspace membership keeps the assignee; a former member is not assigned to new copies.
    const assigneeOfCopy = async () =>
      (
        await domain.execute(
          "duplicate_ticket",
          { projectId: project.id, ticketId: copy.id },
          owner,
        )
      ).assigneeId;
    await domain.execute(
      "set_member",
      { projectId: project.id, email: "writer@example.test", role: null },
      owner,
    );
    await domain.execute(
      "update_project",
      {
        projectId: project.id,
        expectedVersion: project.version,
        name: project.name,
        description: project.description,
        visibility: "workspace",
      },
      owner,
    );
    const membership = { workspaceId: project.workspaceId, email: "writer@example.test" };
    await domain.execute("set_workspace_member", { ...membership, role: "writer" }, owner);
    expect(await assigneeOfCopy()).toBe(writer.id);
    await domain.execute("set_workspace_member", { ...membership, role: null }, owner);
    expect(await assigneeOfCopy()).toBeNull();
    const total = (await domain.execute("list_tickets", { projectId: project.id }, owner)).total;
    const readOnly = await domain.actor(owner.id, { ownerId: "reader", scopes: ["read"] });
    await expect(
      domain.execute("duplicate_ticket", { projectId: project.id, ticketId: copy.id }, readOnly),
    ).rejects.toMatchObject({ code: "insufficient_scope" });
    await expect(
      domain.execute("duplicate_ticket", { projectId: project.id, ticketId: copy.id }, outsider),
    ).rejects.toMatchObject({ status: 404 });
    expect((await domain.execute("list_tickets", { projectId: project.id }, owner)).total).toBe(
      total,
    );
  });
  const manual = async (filter: { status?: "todo" | "in_review"; label?: string } = {}) =>
    (
      await domain.execute(
        "list_tickets",
        { projectId: project.id, sort: "manual", ...filter },
        owner,
      )
    ).items.map((row) => row.title);
  const move = async (
    title: string,
    placement: { before?: string; after?: string; status?: "todo" | "in_review" },
    actor = owner,
  ) => {
    const rows = (
      await domain.execute("list_tickets", { projectId: project.id, sort: "manual" }, owner)
    ).items;
    const find = (name?: string) => rows.find((row) => row.title === name);
    const current = requireRow(find(title));
    return domain.execute(
      "move_ticket",
      {
        projectId: project.id,
        ticketId: current.key,
        expectedVersion: current.version,
        ...(placement.before && { before: requireRow(find(placement.before)).id }),
        ...(placement.after && { after: requireRow(find(placement.after)).id }),
        ...(placement.status && { status: placement.status }),
      },
      actor,
    );
  };
  const createTitled = async (...titles: string[]) => {
    for (const title of titles)
      await domain.execute(
        "create_ticket",
        { projectId: project.id, title, labels: title.startsWith("x") ? ["x"] : [] },
        owner,
      );
  };
  it("manual order: places tickets next to a neighbor and changes status in the same versioned write", async () => {
    await createTitled("A", "B", "C", "D");
    expect(await manual()).toEqual(["A", "B", "C", "D"]);
    await move("D", { before: "A" });
    expect(await manual()).toEqual(["D", "A", "B", "C"]);
    await move("D", { after: "C" });
    expect(await manual()).toEqual(["A", "B", "C", "D"]);
    const moved = await move("C", { status: "in_review", before: "A" });
    expect(moved).toMatchObject({ status: "in_review", version: 2 });
    expect(await manual({ status: "todo" })).toEqual(["A", "B", "D"]);
    expect(await manual({ status: "in_review" })).toEqual(["C"]);
    const events = (
      await domain.execute("list_activity", { projectId: project.id, ticketId: moved.id }, owner)
    ).items.filter((event) => event.type === "ticket.updated");
    expect(events.map((event) => event.data.changedFields)).toEqual([
      ["status", "stateId", "position"],
    ]);
    // Computed sorts ignore the manual order.
    expect(
      (
        await domain.execute("list_tickets", { projectId: project.id, sort: "number" }, owner)
      ).items.map((row) => row.title),
    ).toEqual(["A", "B", "C", "D"]);
    await expect(
      domain.execute(
        "move_ticket",
        { projectId: project.id, ticketId: moved.id, expectedVersion: 1, after: moved.id },
        owner,
      ),
    ).rejects.toMatchObject({ code: "version_conflict" });
    await expect(move("A", { after: "A" })).rejects.toMatchObject({ status: 400 });
    await expect(
      domain.execute(
        "move_ticket",
        {
          projectId: project.id,
          ticketId: moved.id,
          expectedVersion: 2,
          before: "A",
          after: "B",
        },
        owner,
      ),
    ).rejects.toMatchObject({ name: "ZodError" });
  });
  it("manual order: moves within a filtered subset without reordering hidden tickets", async () => {
    await createTitled("x1", "hidden1", "x2", "hidden2", "x3");
    await move("x3", { before: "x1" });
    expect(await manual({ label: "x" })).toEqual(["x3", "x1", "x2"]);
    await move("x1", { after: "x2" });
    expect(await manual({ label: "x" })).toEqual(["x3", "x2", "x1"]);
    expect(await manual()).toEqual(["x3", "hidden1", "x2", "x1", "hidden2"]);
  });
  it("manual order: renumbers only when neighbors leave no room and keeps every relative order", async () => {
    await createTitled("A", "B", "C", "D");
    // Each move halves the gap before B, so the scope is renumbered along the way.
    for (let round = 0; round < 12; round++) {
      await move(round % 2 ? "C" : "D", { before: "B" });
      await move(round % 2 ? "D" : "C", { after: "A" });
    }
    const order = await manual();
    expect(order).toHaveLength(4);
    expect(order.toSorted()).toEqual(["A", "B", "C", "D"]);
    expect(order.at(0)).toBe("A");
    expect(order.at(-1)).toBe("B");
    await move("B", { before: "A" });
    expect((await manual()).slice(0, 2)).toEqual(["B", "A"]);
  });
  it("manual order: rejects stale or foreign anchors and replays retries without moving twice", async () => {
    await createTitled("A", "B", "C");
    const [a, , c] = (
      await domain.execute("list_tickets", { projectId: project.id, sort: "manual" }, owner)
    ).items;
    await domain.execute(
      "delete_ticket",
      { projectId: project.id, ticketId: requireRow(a).id, expectedVersion: 1 },
      owner,
    );
    await expect(move("C", { before: "B" }).then(() => manual())).resolves.toEqual(["C", "B"]);
    await expect(
      domain.execute(
        "move_ticket",
        {
          projectId: project.id,
          ticketId: requireRow(c).id,
          expectedVersion: 2,
          after: requireRow(a).id,
        },
        owner,
      ),
    ).rejects.toMatchObject({ code: "not_found" });
    const other = await domain.execute(
      "create_project",
      { key: `K${crypto.randomUUID().slice(0, 8).toUpperCase()}`, name: "Other project" },
      owner,
    );
    const foreign = await domain.execute(
      "create_ticket",
      { projectId: other.id, title: "Elsewhere" },
      owner,
    );
    await expect(
      domain.execute(
        "move_ticket",
        {
          projectId: project.id,
          ticketId: requireRow(c).id,
          expectedVersion: 2,
          after: foreign.id,
        },
        owner,
      ),
    ).rejects.toMatchObject({ code: "not_found" });
    expect(await manual()).toEqual(["C", "B"]);
    const rows = (
      await domain.execute("list_tickets", { projectId: project.id, sort: "manual" }, owner)
    ).items;
    const retry = {
      projectId: project.id,
      ticketId: requireRow(rows[0]).id,
      expectedVersion: requireRow(rows[0]).version,
      after: requireRow(rows[1]).id,
      requestId: crypto.randomUUID(),
    };
    const first = await domain.execute("move_ticket", retry, owner);
    expect(await domain.execute("move_ticket", retry, owner)).toEqual(first);
    expect(await manual()).toEqual(["B", "C"]);
  });
  it("manual order: serializes concurrent moves without duplicating or dropping tickets", async () => {
    await createTitled("A", "B", "C", "D", "E");
    const rows = (
      await domain.execute("list_tickets", { projectId: project.id, sort: "manual" }, owner)
    ).items;
    const [a, b, c, d, e] = rows.map((row) => requireRow(row));
    const outcomes = await Promise.allSettled([
      domain.execute(
        "move_ticket",
        { projectId: project.id, ticketId: e!.id, expectedVersion: 1, before: a!.id },
        owner,
      ),
      domain.execute(
        "move_ticket",
        { projectId: project.id, ticketId: d!.id, expectedVersion: 1, before: a!.id },
        owner,
      ),
      domain.execute(
        "move_ticket",
        { projectId: project.id, ticketId: a!.id, expectedVersion: 1, after: c!.id },
        owner,
      ),
      domain.execute(
        "move_ticket",
        { projectId: project.id, ticketId: b!.id, expectedVersion: 1, after: e!.id },
        owner,
      ),
      domain.execute(
        "move_ticket",
        { projectId: project.id, ticketId: e!.id, expectedVersion: 1, after: d!.id },
        owner,
      ),
    ]);
    // The two moves of E share a version, so exactly one of them wins.
    expect(
      outcomes.flatMap((outcome) => (outcome.status === "rejected" ? [outcome.reason] : [])),
    ).toEqual([expect.objectContaining({ code: "version_conflict" })]);
    const order = await manual();
    expect(order.toSorted()).toEqual(["A", "B", "C", "D", "E"]);
  });
  it("manual order: lets only writers move tickets and keeps pure reorders out of follower inboxes", async () => {
    await createTitled("A", "B");
    await domain.execute(
      "set_member",
      { projectId: project.id, email: "writer@example.test", role: "reader" },
      owner,
    );
    await expect(move("B", { before: "A" }, writer)).rejects.toMatchObject({ status: 403 });
    await expect(move("B", { before: "A" }, outsider)).rejects.toMatchObject({ status: 404 });
    await domain.execute(
      "set_member",
      { projectId: project.id, email: "writer@example.test", role: "writer" },
      owner,
    );
    const inbox = async () =>
      (
        await fixture.database.db
          .select({ id: notifications.id })
          .from(notifications)
          .where(eq(notifications.userId, owner.id))
      ).length;
    const before = await inbox();
    await move("B", { before: "A" }, writer);
    expect(await inbox()).toBe(before);
    await move("B", { status: "in_review" }, writer);
    expect(await inbox()).toBe(before + 1);
    expect(await manual()).toEqual(["B", "A"]);
  });
  it("allows only one concurrent update to the same version", async () => {
    const current = await ticket();
    const outcomes = await Promise.allSettled(
      ["First edit", "Second edit"].map((title) =>
        domain.execute(
          "update_ticket",
          { projectId: project.id, ticketId: current.id, expectedVersion: 1, changes: { title } },
          owner,
        ),
      ),
    );
    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    const failure = outcomes.find((outcome) => outcome.status === "rejected");
    expect(failure?.status === "rejected" ? failure.reason : null).toMatchObject({
      code: "version_conflict",
    });
    const state = await domain.execute(
      "get_ticket",
      { projectId: project.id, ticketId: current.key },
      owner,
    );
    expect(state.ticket.version).toBe(2);
    expect(
      (
        await domain.execute(
          "list_activity",
          { projectId: project.id, ticketId: current.id },
          owner,
        )
      ).items.filter((event) => event.type === "ticket.updated"),
    ).toHaveLength(1);
  });
  it("lists children by parent key with pagination and returns readable relationship context", async () => {
    const parent = await ticket("Parent requirements"),
      peer = await ticket("Linked ticket with a complete title");
    const first = await domain.execute(
      "create_ticket",
      { projectId: project.id, title: "First child", parentId: parent.id },
      owner,
    );
    const second = await domain.execute(
      "create_ticket",
      { projectId: project.id, title: "Archived child", parentId: parent.id },
      owner,
    );
    await domain.execute(
      "update_ticket",
      {
        projectId: project.id,
        ticketId: second.id,
        expectedVersion: 1,
        changes: { archived: true },
      },
      owner,
    );
    const children = await domain.execute(
      "list_tickets",
      { projectId: project.id, parentId: parent.key, archived: "include", limit: 1, offset: 1 },
      owner,
    );
    expect(children.total).toBe(2);
    expect(children.items.map((row) => row.id)).toEqual([second.id]);
    expect(
      (
        await domain.execute("list_tickets", { projectId: project.id, parentId: parent.id }, owner)
      ).items.map((row) => row.id),
    ).toEqual([first.id]);
    await domain.execute(
      "add_relation",
      { projectId: project.id, ticketId: parent.id, targetId: peer.id, type: "related" },
      owner,
    );
    const related = await domain.execute(
      "list_relations",
      { projectId: project.id, ticketId: parent.id },
      owner,
    );
    expect(related).toHaveLength(1);
    expect(relationReference(related[0]!, parent.id)).toEqual({
      id: peer.id,
      label: "Related to",
      title: `${peer.key} · ${peer.title}`,
    });
    await domain.execute(
      "add_relation",
      { projectId: project.id, ticketId: parent.id, targetId: peer.id, type: "blocks" },
      owner,
    );
    const incoming = (
      await domain.execute("list_relations", { projectId: project.id, ticketId: peer.id }, owner)
    ).find((row) => row.type === "blocks");
    expect(relationReference(incoming!, peer.id)).toEqual({
      id: parent.id,
      label: "Is blocked by",
      title: `${parent.key} · ${parent.title}`,
    });
    const other = await domain.execute(
      "create_project",
      { key: `O${crypto.randomUUID().slice(0, 8).toUpperCase()}`, name: "Other project" },
      owner,
    );
    await expect(
      domain.execute("list_tickets", { projectId: other.id, parentId: parent.id }, owner),
    ).rejects.toMatchObject({ code: "not_found" });
  });
  it("rolls back an entire bulk edit when one ticket changed", async () => {
    const first = await ticket(),
      second = await ticket("Second ticket");
    await domain.execute(
      "update_ticket",
      {
        projectId: project.id,
        ticketId: second.id,
        expectedVersion: 1,
        changes: { title: "Changed" },
      },
      owner,
    );
    await expect(
      domain.execute(
        "bulk_update_tickets",
        {
          projectId: project.id,
          tickets: [
            { ticketId: first.id, expectedVersion: 1 },
            { ticketId: second.id, expectedVersion: 1 },
          ],
          changes: { priority: "urgent" },
        },
        owner,
      ),
    ).rejects.toMatchObject({ code: "version_conflict" });
    expect(
      (await domain.execute("get_ticket", { projectId: project.id, ticketId: first.id }, owner))
        .ticket,
    ).toMatchObject({ version: 1, priority: "medium" });
  });
  it("publishes bulk edits as one consecutive batch of per-ticket events", async () => {
    const first = await ticket("Batch one"),
      second = await ticket("Batch two");
    const cursor = (await domain.readEvents(owner, 0n, project.id)).cursor;
    const rows = await domain.execute(
      "bulk_update_tickets",
      {
        projectId: project.id,
        tickets: [
          { ticketId: first.id, expectedVersion: first.version },
          { ticketId: second.id, expectedVersion: second.version },
        ],
        changes: { priority: "urgent" },
      },
      owner,
    );
    expect(rows.map((row) => row.priority)).toEqual(["urgent", "urgent"]);
    const events = (await domain.readEvents(owner, cursor, project.id)).items;
    expect(events.map((event) => [event.type, event.ticketId])).toEqual([
      ["ticket.updated", first.id],
      ["ticket.updated", second.id],
    ]);
    expect(events[1]!.id - events[0]!.id).toBe(1n);
    expect(events.map((event) => event.data.key)).toEqual([first.key, second.key]);
  });
  it("deletes a selection atomically after validating every ticket", async () => {
    const parent = await ticket("Parent"),
      stays = await ticket("Child that stays"),
      leaves = await ticket("Child that leaves"),
      claimed = await ticket("Claimed");
    for (const child of [stays, leaves])
      await domain.execute(
        "update_ticket",
        {
          projectId: project.id,
          ticketId: child.id,
          expectedVersion: child.version,
          changes: { parentId: parent.id },
        },
        owner,
      );
    const worker = await domain.actor(owner.id, { ownerId: "worker", scopes: ["read", "claim"] });
    await domain.execute(
      "claim_ticket",
      { projectId: project.id, ticketId: claimed.id, workerId: "w1", expectedVersion: 1 },
      worker,
    );
    const remaining = async () =>
      (await domain.execute("list_tickets", { projectId: project.id }, owner)).total;
    const selection = [
      { ticketId: parent.id, expectedVersion: 1 },
      { ticketId: leaves.key, expectedVersion: 2 },
    ];
    await domain.execute(
      "set_member",
      { projectId: project.id, email: "writer@example.test", role: "writer" },
      owner,
    );
    for (const [tickets, actor, code] of [
      [[...selection, { ticketId: claimed.id, expectedVersion: 2 }], owner, "claim_conflict"],
      [[...selection, { ticketId: stays.id, expectedVersion: 1 }], owner, "version_conflict"],
      [[...selection, { ticketId: crypto.randomUUID(), expectedVersion: 1 }], owner, "not_found"],
      [
        [...selection, { ticketId: parent.key.toLowerCase(), expectedVersion: 1 }],
        owner,
        "validation_error",
      ],
      [selection, writer, "forbidden"],
    ] as const)
      await expect(
        domain.execute("bulk_delete_tickets", { projectId: project.id, tickets }, actor),
      ).rejects.toMatchObject({ code });
    expect(await remaining()).toBe(4);
    const cursor = (await domain.readEvents(owner, 0n, project.id)).cursor;
    const input = { projectId: project.id, tickets: selection, requestId: crypto.randomUUID() };
    expect(await domain.execute("bulk_delete_tickets", input, owner)).toEqual({ ok: true });
    expect(await domain.execute("bulk_delete_tickets", input, owner)).toEqual({ ok: true });
    expect(await remaining()).toBe(2);
    expect(
      (await domain.execute("get_ticket", { projectId: project.id, ticketId: stays.id }, owner))
        .ticket,
    ).toMatchObject({ parentId: null, version: 3 });
    const events = (await domain.readEvents(owner, cursor, project.id)).items;
    expect(events.map((event) => [event.type, event.ticketId, event.data.key])).toEqual([
      ["ticket.updated", stays.id, stays.key],
      ["ticket.deleted", parent.id, parent.key],
      ["ticket.deleted", leaves.id, leaves.key],
    ]);
  });
  it("searches tickets by key or text across accessible projects", async () => {
    const other = await domain.execute(
      "create_project",
      { key: `S${crypto.randomUUID().slice(0, 8).toUpperCase()}`, name: "Second project" },
      owner,
    );
    const here = await ticket("Rotate the signing key");
    const there = await domain.execute(
      "create_ticket",
      { projectId: other.id, title: "Signing key rotation runbook" },
      owner,
    );
    const found = await domain.execute("search_tickets", { q: "signing key" }, owner);
    expect(found.items.map((item) => item.ticket.id).toSorted()).toEqual(
      [here.id, there.id].toSorted(),
    );
    expect(found.items.find((item) => item.ticket.id === there.id)?.project).toMatchObject({
      id: other.id,
      key: other.key,
      name: "Second project",
    });
    const byKey = await domain.execute("search_tickets", { q: there.key.toLowerCase() }, owner);
    expect(byKey.items[0]?.ticket.id).toBe(there.id);
    // A workspace filter narrows the listing; it is not a membership requirement.
    const bound = await domain.actor(owner.id, {
      ownerId: "credential",
      scopes: ["read"],
      projectIds: [project.id],
    });
    expect(
      (
        await domain.execute(
          "search_tickets",
          { q: "signing key", workspaceId: project.workspaceId },
          bound,
        )
      ).items.map((item) => item.ticket.id),
    ).toEqual([here.id]);
    await domain.execute(
      "update_ticket",
      {
        projectId: project.id,
        ticketId: here.id,
        expectedVersion: here.version,
        changes: { archived: true },
      },
      owner,
    );
    expect((await domain.execute("search_tickets", { q: "signing key" }, bound)).items).toEqual([]);
    expect((await domain.execute("search_tickets", { q: "signing key" }, outsider)).items).toEqual(
      [],
    );
  });
  it("filters tickets by any-of and none-of values through one predicate catalog", async () => {
    const create = (title: string, fields: Record<string, unknown>) =>
      domain.execute("create_ticket", { projectId: project.id, title, ...fields }, owner);
    const alpha = await create("Alpha", {
        status: "todo",
        priority: "high",
        labels: ["x"],
        difficulty: "med",
        assigneeId: owner.id,
      }),
      beta = await create("Beta", { status: "in_progress", priority: "low", labels: ["y"] }),
      gamma = await create("Gamma", { status: "done", labels: ["x", "y, z"], difficulty: "high" });
    const ids = async (filter: Record<string, unknown>) =>
      (await domain.execute("list_tickets", { projectId: project.id, ...filter }, owner)).items
        .map((row) => row.id)
        .toSorted();
    expect(await ids({ status: ["todo", "in_progress"] })).toEqual(sorted(alpha, beta));
    expect(await ids({ status: "todo" })).toEqual(sorted(alpha));
    expect(await ids({ statusNot: ["done"] })).toEqual(sorted(alpha, beta));
    expect(await ids({ label: ["x", "y, z"] })).toEqual(sorted(alpha, gamma));
    expect(await ids({ labelNot: ["x"] })).toEqual(sorted(beta));
    expect(await ids({ assigneeId: ["none"] })).toEqual(sorted(beta, gamma));
    expect(await ids({ assigneeIdNot: ["none"] })).toEqual(sorted(alpha));
    expect(await ids({ assigneeId: [owner.id, "none"] })).toEqual(sorted(alpha, beta, gamma));
    // Excluding a value keeps tickets where the field is unset.
    expect(await ids({ difficultyNot: ["med"] })).toEqual(sorted(beta, gamma));
    expect(await ids({ priority: ["high", "low"], labelNot: ["y"] })).toEqual(sorted(alpha));
    await expect(
      domain.execute(
        "list_tickets",
        { projectId: project.id, status: ["todo"], statusNot: ["todo"] },
        owner,
      ),
    ).rejects.toMatchObject({ name: "ZodError" });
    await expect(
      domain.execute(
        "list_tickets",
        { projectId: project.id, label: Array.from({ length: 26 }, (_, index) => `l${index}`) },
        owner,
      ),
    ).rejects.toMatchObject({ name: "ZodError" });
    await expect(
      domain.execute(
        "save_view",
        { projectId: project.id, name: "Conflict", filters: { label: "x", labelNot: "x" } },
        owner,
      ),
    ).rejects.toMatchObject({ name: "ZodError" });
  });
  it("searches tickets, projects, comments, and activity within access", async () => {
    const token = `q${crypto.randomUUID().slice(0, 8)}`;
    const board = await domain.execute(
      "create_project",
      {
        key: `B${crypto.randomUUID().slice(0, 8).toUpperCase()}`,
        name: `${token} board`,
        description: "Planning board",
      },
      owner,
    );
    const hidden = await domain.execute(
      "create_project",
      { key: `H${crypto.randomUUID().slice(0, 8).toUpperCase()}`, name: "Hidden project" },
      owner,
    );
    const open = await domain.execute(
      "create_ticket",
      {
        projectId: project.id,
        title: `Rotate ${token} keys`,
        description: `Before rotation, read the ${token} runbook carefully.`,
      },
      owner,
    );
    const done = await domain.execute(
      "create_ticket",
      { projectId: project.id, title: "Closed work", status: "done" },
      owner,
    );
    const comment = await domain.execute(
      "add_comment",
      { projectId: project.id, ticketId: done.id, body: `The ${token} fix shipped.` },
      owner,
    );
    const secret = await domain.execute(
      "create_ticket",
      { projectId: hidden.id, title: `Secret ${token} payroll` },
      owner,
    );
    await domain.execute(
      "set_member",
      { projectId: project.id, email: "writer@example.test", role: "reader" },
      owner,
    );
    const search = (actor: Actor, input: Record<string, unknown> = {}) =>
      domain.execute("search_workspace", { q: token, ...input }, actor);
    const all = await search(owner);
    expect(all.counts).toEqual({ project: 1, ticket: 2, comment: 1, activity: 0 });
    expect(all.items.map((item) => [item.type, item.id])).toEqual([
      ["project", board.id],
      ["ticket", secret.id],
      ["ticket", open.id],
      ["comment", comment.id],
    ]);
    expect(all).toMatchObject({ total: 4, engine: "postgres", indexing: false });
    const ticketHit = all.items.find((item) => item.id === open.id);
    expect(ticketHit).toMatchObject({
      title: `Rotate ${token} keys`,
      ticket: { id: open.id, key: open.key, status: open.status },
      project: { id: project.id, key: project.key },
    });
    expect(ticketHit?.excerpt).toContain(`read the ${token} runbook`);
    expect(all.items.find((item) => item.type === "comment")).toMatchObject({
      ticket: { id: done.id, key: done.key },
      excerpt: `The ${token} fix shipped.`,
      actorId: owner.id,
    });
    // A reader sees only accessible projects; counts exclude what they cannot open.
    const reader = await search(writer);
    expect(reader.counts).toEqual({ project: 0, ticket: 1, comment: 1, activity: 0 });
    expect(reader.items.map((item) => item.id)).toEqual([open.id, comment.id]);
    expect((await search(outsider)).total).toBe(0);
    // Pages walk one stable order, and a type narrows the page without changing counts.
    const first = await search(owner, { limit: 2 }),
      second = await search(owner, { limit: 2, offset: 2 });
    expect([...first.items, ...second.items].map((item) => item.id)).toEqual(
      all.items.map((item) => item.id),
    );
    const comments = await search(owner, { type: "comment" });
    expect(comments).toMatchObject({ total: 1, counts: all.counts });
    expect(comments.items.map((item) => item.id)).toEqual([comment.id]);
    // Property filters restrict results to matching tickets and their comments.
    const closed = await search(owner, { status: ["done"] });
    expect(closed.counts).toEqual({ project: 0, ticket: 0, comment: 1, activity: 0 });
    // A ticket key ranks its ticket first, then its activity follows the other results.
    const byKey = await search(owner, { q: done.key.toLowerCase() });
    expect(byKey.items[0]).toMatchObject({ type: "ticket", id: done.id });
    expect(
      byKey.items.filter((item) => item.type === "activity").map((item) => item.title),
    ).toEqual([
      `Comment added · ${done.key} · Closed work`,
      `Ticket created · ${done.key} · Closed work`,
    ]);
    // Activity matches an active actor's name; disabled identities are not matched.
    const editor = await fixture.auth.api.createUser({
      body: {
        name: `Editor ${token}`,
        email: `${token}@example.test`,
        password: "Isolated fixture password 42!",
        role: "user",
      },
    });
    await domain.execute(
      "set_member",
      { projectId: project.id, email: `${token}@example.test`, role: "writer" },
      owner,
    );
    const editorActor = await domain.actor(editor.user.id);
    await domain.execute(
      "add_comment",
      { projectId: project.id, ticketId: open.id, body: "Reviewed." },
      editorActor,
    );
    expect((await search(owner, { type: "activity" })).items.map((item) => item.actorId)).toEqual([
      editor.user.id,
    ]);
    await fixture.database.pool.query(`UPDATE "user" SET banned = true WHERE id = $1`, [
      editor.user.id,
    ]);
    expect((await search(owner)).counts.activity).toBe(0);
    await expect(domain.actor(editor.user.id)).rejects.toMatchObject({ code: "account_disabled" });
  });
  it("reports when PostgreSQL answers while an external index is behind", async () => {
    const lagging = createDomain(fixture.database, {
      search: { where: async () => ({ where: undefined, engine: "postgres", indexing: true }) },
    });
    const result = await lagging.execute("search_workspace", { q: "anything" }, owner);
    expect(result).toMatchObject({ engine: "postgres", indexing: true });
  });
  it("lists open assigned work and recent activity only from accessible projects", async () => {
    const hidden = await domain.execute(
      "create_project",
      { key: `M${crypto.randomUUID().slice(0, 8).toUpperCase()}`, name: "Private project" },
      owner,
    );
    for (const target of [project, hidden])
      await domain.execute(
        "set_member",
        { projectId: target.id, email: "writer@example.test", role: "writer" },
        owner,
      );
    const assign = async (projectId: string, title: string, changes: Record<string, unknown>) =>
      domain.execute(
        "create_ticket",
        { projectId, title, assigneeId: writer.id, ...changes },
        owner,
      );
    const later = await assign(project.id, "Assigned later", {
      dueAt: new Date(Date.now() + 86_400_000).toISOString(),
    });
    const sooner = await assign(project.id, "Assigned sooner", {
      dueAt: new Date(Date.now() + 3_600_000).toISOString(),
    });
    await assign(project.id, "Assigned and done", { status: "done" });
    await assign(project.id, "Assigned and archived", { archived: true });
    await ticket("Unassigned");
    const elsewhere = await assign(hidden.id, "Assigned in the private project", {});
    const work = (input: Record<string, unknown>, actor = writer) =>
      domain.execute("list_my_work", input, actor);
    const all = await work({ sort: "due", activity: 50 });
    expect(all.items.map((row) => row.id)).toEqual([sooner.id, later.id, elsewhere.id]);
    expect(all.total).toBe(3);
    expect(all.activity.some((event) => event.projectId === hidden.id)).toBe(true);
    // Batches report the full total so clients can fetch every page.
    const batch = await work({ sort: "due", limit: 2, offset: 2 });
    expect([batch.items.map((row) => row.id), batch.total]).toEqual([[elsewhere.id], 3]);
    expect(batch.activity).toEqual([]);
    expect((await work({ q: "sooner" })).items.map((row) => row.id)).toEqual([sooner.id]);
    // The workspace filter narrows the listing; it does not grant access.
    expect((await work({ workspaceId: crypto.randomUUID() })).total).toBe(0);
    const bound = await domain.actor(writer.id, {
      ownerId: "credential",
      scopes: ["read"],
      projectIds: [project.id],
    });
    expect((await work({ activity: 50 }, bound)).total).toBe(2);
    expect(
      (await work({ activity: 50 }, bound)).activity.every(
        (event) => event.projectId === project.id,
      ),
    ).toBe(true);
    expect(await work({ activity: 50 }, outsider)).toEqual({ items: [], total: 0, activity: [] });
    // Revoking membership removes that project's tickets, counts, and activity at once.
    await domain.execute(
      "set_member",
      { projectId: hidden.id, email: "writer@example.test", role: null },
      owner,
    );
    const revoked = await work({ sort: "due", activity: 50 });
    expect([revoked.items.map((row) => row.id), revoked.total]).toEqual([[sooner.id, later.id], 2]);
    expect(revoked.activity.some((event) => event.projectId === hidden.id)).toBe(false);
  });
  it("stores due dates and filters and sorts by them", async () => {
    const soon = new Date(Date.now() + 3_600_000).toISOString(),
      late = new Date(Date.now() - 86_400_000).toISOString();
    const dated = await domain.execute(
      "create_ticket",
      { projectId: project.id, title: "Due soon", dueAt: soon },
      owner,
    );
    expect(dated.dueAt).toBe(soon);
    const overdue = await ticket("Overdue");
    await domain.execute(
      "update_ticket",
      {
        projectId: project.id,
        ticketId: overdue.id,
        expectedVersion: overdue.version,
        changes: { dueAt: late },
      },
      owner,
    );
    await ticket("Undated");
    const list = (filter: Record<string, unknown>) =>
      domain
        .execute("list_tickets", { projectId: project.id, ...filter }, owner)
        .then((page) => ({ titles: page.items.map((row) => row.title), total: page.total }));
    expect(await list({ due: "overdue" })).toEqual({ titles: ["Overdue"], total: 1 });
    expect(await list({ due: "today" })).toEqual({ titles: ["Due soon"], total: 1 });
    expect(await list({ due: "week" })).toEqual({ titles: ["Due soon"], total: 1 });
    expect(await list({ due: "none" })).toEqual({ titles: ["Undated"], total: 1 });
    expect((await list({ sort: "due" })).titles).toEqual(["Overdue", "Due soon", "Undated"]);
    expect((await list({ sort: "due", order: "desc" })).titles).toEqual([
      "Due soon",
      "Overdue",
      "Undated",
    ]);
    expect((await list({ sort: "number", order: "desc" })).titles).toEqual([
      "Undated",
      "Overdue",
      "Due soon",
    ]);
    expect((await list({ assigneeId: "none" })).total).toBe(3);
    expect((await list({ assigneeId: owner.id })).total).toBe(0);
    const finished = await ticket("Finished");
    await domain.execute(
      "update_ticket",
      {
        projectId: project.id,
        ticketId: finished.id,
        expectedVersion: finished.version,
        changes: { status: "done", dueAt: new Date(Date.now() + 60_000).toISOString() },
      },
      owner,
    );
    const listed = await domain.execute("list_projects", {}, owner);
    // Rollups count unarchived tickets; the next due date is the soonest upcoming open one.
    expect(listed.find((entry) => entry.id === project.id)).toMatchObject({
      openTickets: 3,
      overdueTickets: 1,
      closedTickets: 1,
      nextDueAt: soon,
    });
    expect(await list({ limit: 1, offset: 5 })).toEqual({ titles: [], total: 4 });
  });
  it("rejects cycles across blockers and parent relationships and explains readiness", async () => {
    const first = await ticket(),
      second = await ticket("Dependent ticket");
    await domain.execute(
      "add_relation",
      { projectId: project.id, ticketId: first.id, targetId: second.id, type: "blocks" },
      owner,
    );
    await expect(
      domain.execute(
        "add_relation",
        { projectId: project.id, ticketId: second.id, targetId: first.id, type: "blocks" },
        owner,
      ),
    ).rejects.toMatchObject({ code: "dependency_cycle" });
    await expect(
      domain.execute(
        "update_ticket",
        {
          projectId: project.id,
          ticketId: second.id,
          expectedVersion: 1,
          changes: { parentId: first.id },
        },
        owner,
      ),
    ).rejects.toMatchObject({ code: "dependency_cycle" });
    expect(
      (await domain.execute("get_ticket", { projectId: project.id, ticketId: second.id }, owner))
        .readiness,
    ).toMatchObject({ ready: false, reasons: [{ code: "dependency", ticketId: first.id }] });
    await domain.execute(
      "update_ticket",
      {
        projectId: project.id,
        ticketId: first.id,
        expectedVersion: 1,
        changes: { status: "done" },
      },
      owner,
    );
    expect(
      (await domain.execute("get_ticket", { projectId: project.id, ticketId: second.id }, owner))
        .readiness.ready,
    ).toBe(true);
  });
  it.each([86400, 1800, 172800, 60])(
    "enforces the configured claim lease cap for acquisition and renewal: %s",
    async (maximum) => {
      const configured = createDomain(fixture.database, { claimMaxLeaseSeconds: maximum });
      const current = await ticket();
      const worker = await domain.actor(owner.id, {
        ownerId: "lease-policy-worker",
        scopes: ["read", "claim"],
      });
      const input = { projectId: project.id, ticketId: current.id };
      const acquire = { ...input, expectedVersion: 1, workerId: "lease-policy-worker" };
      await expect(
        configured.execute("claim_ticket", { ...acquire, leaseSeconds: maximum + 1 }, worker),
      ).rejects.toMatchObject({ code: "validation_error" });
      const started = Date.now();
      const claim = await configured.execute(
        "claim_ticket",
        { ...acquire, leaseSeconds: maximum },
        worker,
      );
      expect(new Date(claim.expiresAt).getTime()).toBeGreaterThanOrEqual(started + maximum * 1000);
      const renew = { ...input, claimId: claim.id };
      await expect(
        configured.execute("renew_claim", { ...renew, leaseSeconds: maximum + 1 }, worker),
      ).rejects.toMatchObject({ code: "validation_error" });
      const renewed = await configured.execute(
        "renew_claim",
        { ...renew, leaseSeconds: maximum },
        worker,
      );
      expect(new Date(renewed.expiresAt).getTime()).toBeGreaterThanOrEqual(
        started + maximum * 1000,
      );
      const defaultStart = Date.now();
      const boundedDefault = await configured.execute("renew_claim", renew, worker);
      expect(new Date(boundedDefault.expiresAt).getTime()).toBeGreaterThanOrEqual(
        defaultStart + Math.min(300, maximum) * 1000,
      );
      expect(new Date(boundedDefault.expiresAt).getTime()).toBeLessThanOrEqual(
        Date.now() + Math.min(300, maximum) * 1000,
      );
      await configured.execute("release_claim", renew, worker);
      const reset = await domain.execute(
        "update_ticket",
        { ...input, expectedVersion: 2, changes: { status: "todo" } },
        owner,
      );
      const omitted = await configured.execute(
        "claim_ticket",
        { ...acquire, expectedVersion: reset.version },
        worker,
      );
      expect(new Date(omitted.expiresAt).getTime()).toBeLessThanOrEqual(
        Date.now() + Math.min(300, maximum) * 1000,
      );
    },
  );
  it("lets claim-authorized writers recover expired ownership without administrator access", async () => {
    const current = await ticket();
    await domain.execute(
      "set_member",
      { projectId: project.id, email: "writer@example.test", role: "writer" },
      owner,
    );
    const worker = await domain.actor(writer.id, {
      ownerId: "recovery-worker",
      scopes: ["read", "write", "claim"],
    });
    const input = { projectId: project.id, ticketId: current.id };
    const claim = await domain.execute(
      "claim_ticket",
      { ...input, expectedVersion: 1, workerId: "old-worker" },
      owner,
    );
    const recovery = {
      ...input,
      claimId: claim.id,
      reason: "Confirmed the old worker has stopped",
      confirmedStopped: true as const,
    };
    await expect(domain.execute("recover_claim", recovery, worker)).rejects.toMatchObject({
      code: "claim_not_expired",
    });
    await fixture.database.pool.query(
      "UPDATE claims SET expires_at = now() - interval '1 second' WHERE id = $1",
      [claim.id],
    );
    const withoutClaimScope = await domain.actor(writer.id, {
      ownerId: "no-claim",
      scopes: ["read", "write"],
    });
    await expect(
      domain.execute("recover_claim", recovery, withoutClaimScope),
    ).rejects.toMatchObject({ code: "insufficient_scope" });
    await expect(domain.execute("recover_claim", recovery, outsider)).rejects.toMatchObject({
      status: 404,
    });
    await domain.execute(
      "set_member",
      { projectId: project.id, email: "writer@example.test", role: "reader" },
      owner,
    );
    await expect(domain.execute("recover_claim", recovery, worker)).rejects.toMatchObject({
      status: 403,
    });
    await domain.execute(
      "set_member",
      { projectId: project.id, email: "writer@example.test", role: "writer" },
      owner,
    );
    await expect(
      domain.execute("recover_claim", { ...recovery, confirmedStopped: false }, worker),
    ).rejects.toThrow("confirmedStopped");
    const requestId = crypto.randomUUID();
    expect(await domain.execute("recover_claim", { ...recovery, requestId }, worker)).toEqual({
      ok: true,
    });
    expect(await domain.execute("recover_claim", { ...recovery, requestId }, worker)).toEqual({
      ok: true,
    });
    const read = await domain.execute("get_ticket", input, owner);
    expect(read.claim).toBeNull();
    expect(read.ticket.status).toBe("in_progress");
    await expect(
      domain.execute("renew_claim", { ...input, claimId: claim.id }, owner),
    ).rejects.toMatchObject({ status: 404 });
    const activity = await domain.execute("list_activity", input, owner);
    expect(activity.items.filter((event) => event.type === "claim.recovered")).toHaveLength(1);
    await domain.execute(
      "update_ticket",
      { ...input, expectedVersion: 2, changes: { status: "todo" } },
      owner,
    );
    const replacement = await domain.execute(
      "claim_ticket",
      { ...input, expectedVersion: 3, workerId: "replacement" },
      worker,
    );
    expect(replacement.id).not.toBe(claim.id);
    await expect(
      domain.execute(
        "update_ticket",
        { ...input, expectedVersion: 4, claimId: claim.id, changes: { title: "Stale owner" } },
        worker,
      ),
    ).rejects.toMatchObject({ code: "claim_conflict" });
    await expect(
      domain.execute("renew_claim", { ...input, claimId: claim.id }, worker),
    ).rejects.toMatchObject({ status: 404 });
    await fixture.database.pool.query(
      "UPDATE claims SET expires_at = now() - interval '1 second' WHERE id = $1",
      [replacement.id],
    );
    const reschedule = { ...recovery, claimId: replacement.id, reschedule: true };
    await expect(domain.execute("recover_claim", reschedule, worker)).rejects.toThrow(
      "expectedVersion",
    );
    await expect(
      domain.execute("recover_claim", { ...reschedule, expectedVersion: 3 }, worker),
    ).rejects.toMatchObject({ code: "version_conflict" });
    expect((await domain.execute("get_ticket", input, owner)).claim?.id).toBe(replacement.id);
    const claimOnly = await domain.actor(writer.id, {
      ownerId: worker.ownerId,
      scopes: ["read", "claim"],
    });
    await domain.execute("recover_claim", { ...reschedule, expectedVersion: 4 }, claimOnly);
    const rescheduled = await domain.execute("get_ticket", input, claimOnly);
    expect(rescheduled.claim).toBeNull();
    expect(rescheduled.ticket).toMatchObject({ status: "todo", version: 5 });
    expect((await domain.execute("list_activity", input, claimOnly)).items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "ticket.updated",
          data: expect.objectContaining({ version: 5, changedFields: ["status", "stateId"] }),
        }),
        expect.objectContaining({
          type: "claim.recovered",
          data: expect.objectContaining({ claimId: replacement.id, confirmedStopped: true }),
        }),
      ]),
    );
    const resumed = await domain.execute(
      "claim_ticket",
      { ...input, expectedVersion: 5, workerId: "resumed-worker" },
      claimOnly,
    );
    expect(resumed.id).not.toBe(replacement.id);
    await expect(
      domain.execute("renew_claim", { ...input, claimId: replacement.id }, worker),
    ).rejects.toMatchObject({ status: 404 });
  });
  it("coordinates competing workers and fences old ownership after recovery", async () => {
    const current = await ticket();
    const workers = [
      await domain.actor(owner.id, { ownerId: "worker-a", scopes: ["read", "write", "claim"] }),
      await domain.actor(owner.id, { ownerId: "worker-b", scopes: ["read", "write", "claim"] }),
    ];
    const outcomes = await Promise.allSettled(
      workers.map((actor, index) =>
        domain.execute(
          "claim_ticket",
          {
            projectId: project.id,
            ticketId: current.id,
            expectedVersion: 1,
            workerId: `worker-${index}`,
          },
          actor,
        ),
      ),
    );
    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    const claim = (
      await domain.execute("get_ticket", { projectId: project.id, ticketId: current.id }, owner)
    ).claim!;
    await fixture.database.pool.query(
      "UPDATE claims SET expires_at = now() - interval '1 second' WHERE id = $1",
      [claim.id],
    );
    const owningWorker = claim.workerId === "worker-0" ? workers[0]! : workers[1]!;
    await expect(
      domain.execute(
        "release_claim",
        { projectId: project.id, ticketId: current.id, claimId: claim.id },
        owningWorker,
      ),
    ).rejects.toMatchObject({ code: "claim_conflict" });
    await expect(
      domain.execute(
        "claim_ticket",
        {
          projectId: project.id,
          ticketId: current.id,
          expectedVersion: 2,
          workerId: "replacement",
        },
        workers[1]!,
      ),
    ).rejects.toMatchObject({ code: "not_ready" });
    await domain.execute(
      "recover_claim",
      {
        projectId: project.id,
        ticketId: current.id,
        claimId: claim.id,
        reason: "Confirmed the old worker has stopped",
        confirmedStopped: true,
      },
      owner,
    );
    await expect(
      domain.execute(
        "update_ticket",
        {
          projectId: project.id,
          ticketId: current.id,
          expectedVersion: 2,
          claimId: claim.id,
          changes: { status: "done" },
        },
        workers[0]!,
      ),
    ).rejects.toMatchObject({ code: "claim_conflict" });
    await expect(
      domain.execute(
        "update_ticket",
        {
          projectId: project.id,
          ticketId: current.id,
          expectedVersion: 2,
          changes: { title: "Bypass by omitting ownership token" },
        },
        workers[0]!,
      ),
    ).rejects.toMatchObject({ code: "claim_conflict" });
    await expect(
      domain.execute(
        "add_evidence",
        {
          projectId: project.id,
          ticketId: current.id,
          kind: "test",
          title: "Stale worker evidence",
          url: "https://example.test/proof",
        },
        workers[0]!,
      ),
    ).rejects.toMatchObject({ code: "claim_conflict" });
    expect(
      (await domain.execute("get_ticket", { projectId: project.id, ticketId: current.id }, owner))
        .ticket.status,
    ).toBe("in_progress");
  });
  it("reports release capability for the exact live claim identity and preserves fences after release", async () => {
    const current = await ticket();
    const worker = await domain.actor(owner.id, {
      ownerId: "capability-worker",
      scopes: ["read", "write", "claim"],
    });
    const readOnly = await domain.actor(owner.id, { ownerId: worker.ownerId, scopes: ["read"] });
    const claim = await domain.execute(
      "claim_ticket",
      {
        projectId: project.id,
        ticketId: current.id,
        expectedVersion: 1,
        workerId: "capability-worker",
      },
      worker,
    );
    const input = { projectId: project.id, ticketId: current.id };
    expect((await domain.execute("get_ticket", input, owner)).canReleaseClaim).toBe(false);
    expect((await domain.execute("get_ticket", input, worker)).canReleaseClaim).toBe(true);
    expect((await domain.execute("get_ticket", input, readOnly)).canReleaseClaim).toBe(false);
    await domain.execute("release_claim", { ...input, claimId: claim.id }, worker);
    expect((await domain.execute("get_ticket", input, worker)).canReleaseClaim).toBe(false);
    await expect(
      domain.execute(
        "update_ticket",
        { ...input, expectedVersion: 2, changes: { status: "done" } },
        worker,
      ),
    ).rejects.toMatchObject({ code: "claim_conflict" });
    await domain.execute(
      "update_ticket",
      { ...input, expectedVersion: 2, changes: { status: "todo" } },
      owner,
    );
    const humanClaim = await domain.execute(
      "claim_ticket",
      { ...input, expectedVersion: 3, workerId: "manual owner" },
      owner,
    );
    expect((await domain.execute("get_ticket", input, owner)).canReleaseClaim).toBe(true);
    await domain.execute("release_claim", { ...input, claimId: humanClaim.id }, owner);
  });
  it("enforces project membership, credential scopes, and access on idempotent replay", async () => {
    const current = await ticket();
    await expect(
      domain.execute("get_ticket", { projectId: project.id, ticketId: current.id }, outsider),
    ).rejects.toMatchObject({ status: 404 });
    await domain.execute(
      "set_member",
      { projectId: project.id, email: "writer@example.test", role: "reader" },
      owner,
    );
    await expect(
      domain.execute(
        "update_ticket",
        {
          projectId: project.id,
          ticketId: current.id,
          expectedVersion: 1,
          changes: { title: "Forbidden" },
        },
        writer,
      ),
    ).rejects.toMatchObject({ status: 403 });
    const readOnly = await domain.actor(owner.id, {
      ownerId: "read-only",
      scopes: ["read"],
      projectIds: [project.id],
    });
    await expect(
      domain.execute("create_ticket", { projectId: project.id, title: "Forbidden" }, readOnly),
    ).rejects.toMatchObject({ status: 403 });
    await domain.execute(
      "set_member",
      { projectId: project.id, email: "writer@example.test", role: "writer" },
      owner,
    );
    const input = {
      projectId: project.id,
      title: "Writer's ticket",
      requestId: crypto.randomUUID(),
    };
    await domain.execute("create_ticket", input, writer);
    await domain.execute(
      "set_member",
      { projectId: project.id, email: "writer@example.test", role: null },
      owner,
    );
    await expect(domain.execute("create_ticket", input, writer)).rejects.toMatchObject({
      status: 404,
    });
  });
  it("preserves committed event order and returns permission-filtered replay", async () => {
    const snapshot = await domain.snapshot(owner, project.id);
    await Promise.all(
      Array.from({ length: 12 }, (_, index) => ticket(`Concurrent ticket ${index}`)),
    );
    const replay = await domain.readEvents(owner, BigInt(snapshot.cursor), project.id);
    expect(replay.items).toHaveLength(12);
    expect(replay.items.map((event) => event.id)).toEqual(
      replay.items.map((event) => event.id).toSorted((a, b) => (a < b ? -1 : 1)),
    );
    expect(new Set(replay.items.map((event) => event.id.toString())).size).toBe(12);
    expect((await domain.readEvents(outsider, 0n)).items).toEqual([]);
    await expect(domain.readEvents(owner, replay.cursor + 1n, project.id)).rejects.toMatchObject({
      code: "snapshot_required",
    });
  });
  it("attributes discussion and evidence and rejects moderation by another writer", async () => {
    const current = await ticket();
    await domain.execute(
      "set_member",
      { projectId: project.id, email: "writer@example.test", role: "writer" },
      owner,
    );
    const comment = await domain.execute(
      "add_comment",
      { projectId: project.id, ticketId: current.id, body: "A reproducible observation" },
      owner,
    );
    await expect(
      domain.execute(
        "update_comment",
        { projectId: project.id, commentId: comment.id, expectedVersion: 1, body: "Rewritten" },
        writer,
      ),
    ).rejects.toMatchObject({ status: 403 });
    const result = await domain.execute(
      "add_evidence",
      {
        projectId: project.id,
        ticketId: current.id,
        kind: "test",
        title: "Regression run",
        url: "https://example.test/result",
        outcome: "passed",
      },
      writer,
    );
    expect(result.actorId).toBe(writer.id);
    expect(
      (
        await domain.execute(
          "list_evidence",
          { projectId: project.id, ticketId: current.id },
          owner,
        )
      )[0]?.outcome,
    ).toBe("passed");
  });
  it("versions editable links separately from evidence and fences readers, stale edits, and stale workers", async () => {
    const current = await ticket();
    await domain.execute(
      "set_member",
      { projectId: project.id, email: "writer@example.test", role: "reader" },
      owner,
    );
    const cursor = (await domain.readEvents(owner, 0n, project.id)).cursor;
    const requestId = crypto.randomUUID(),
      input = {
        projectId: project.id,
        ticketId: current.key,
        url: "https://github.com/MaudeCode/kanvil/pull/1",
        requestId,
      };
    const added = await domain.execute("add_resource", input, owner);
    expect(await domain.execute("add_resource", input, owner)).toEqual(added);
    expect(added).toMatchObject({
      ticketId: current.id,
      actorId: owner.id,
      title: "",
      provider: "GitHub",
      remoteState: null,
      remoteCheckedAt: null,
      version: 1,
    });
    for (const url of ["javascript:alert(1)", "data:text/html,hi", "ftp://example.test/file"])
      await expect(
        domain.execute("add_resource", { projectId: project.id, ticketId: current.id, url }, owner),
      ).rejects.toThrow("Use an HTTP or HTTPS URL");
    await expect(
      domain.execute(
        "add_resource",
        { projectId: project.id, ticketId: current.id, url: "https://example.test" },
        writer,
      ),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      domain.execute(
        "update_resource",
        { projectId: project.id, resourceId: added.id, expectedVersion: 1, title: "Read only" },
        writer,
      ),
    ).rejects.toMatchObject({ status: 403 });
    expect(
      await domain.execute(
        "list_resources",
        { projectId: project.id, ticketId: current.id },
        writer,
      ),
    ).toEqual([added]);

    const titled = await domain.execute(
      "update_resource",
      { projectId: project.id, resourceId: added.id, expectedVersion: 1, title: "Release PR" },
      owner,
    );
    expect(titled).toMatchObject({ title: "Release PR", provider: "GitHub", version: 2 });
    await expect(
      domain.execute(
        "update_resource",
        { projectId: project.id, resourceId: added.id, expectedVersion: 1, title: "Stale" },
        owner,
      ),
    ).rejects.toMatchObject({ code: "version_conflict", details: { currentVersion: 2 } });
    await fixture.database.pool.query(
      "UPDATE resources SET remote_state = 'merged', remote_checked_at = now() WHERE id = $1",
      [added.id],
    );
    const moved = await domain.execute(
      "update_resource",
      {
        projectId: project.id,
        resourceId: added.id,
        expectedVersion: 2,
        url: "https://docs.example.test/runbook",
      },
      owner,
    );
    expect(moved).toMatchObject({
      title: "Release PR",
      url: "https://docs.example.test/runbook",
      provider: null,
      remoteState: null,
      remoteCheckedAt: null,
      version: 3,
    });
    await expect(
      domain.execute(
        "delete_resource",
        { projectId: project.id, resourceId: added.id, expectedVersion: 2 },
        owner,
      ),
    ).rejects.toMatchObject({ code: "version_conflict" });

    const worker = await domain.actor(owner.id, {
      ownerId: "resource-worker",
      scopes: ["read", "write", "claim"],
    });
    const claim = await domain.execute(
      "claim_ticket",
      {
        projectId: project.id,
        ticketId: current.id,
        expectedVersion: 1,
        workerId: "resource-worker",
      },
      worker,
    );
    await expect(
      domain.execute(
        "update_resource",
        { projectId: project.id, resourceId: added.id, expectedVersion: 3, title: "No claim" },
        worker,
      ),
    ).rejects.toMatchObject({ code: "claim_conflict" });
    await expect(
      domain.execute(
        "add_resource",
        { projectId: project.id, ticketId: current.id, url: "https://example.test/log" },
        worker,
      ),
    ).rejects.toMatchObject({ code: "claim_conflict" });
    await domain.execute(
      "delete_resource",
      { projectId: project.id, resourceId: added.id, expectedVersion: 3, claimId: claim.id },
      worker,
    );
    expect(
      await domain.execute(
        "list_resources",
        { projectId: project.id, ticketId: current.id },
        owner,
      ),
    ).toEqual([]);
    expect(
      await domain.execute("list_evidence", { projectId: project.id, ticketId: current.id }, owner),
    ).toEqual([]);
    expect(
      (await domain.readEvents(owner, cursor, project.id)).items
        .filter((event) => event.type.startsWith("resource."))
        .map((event) => [event.type, event.ticketId, event.data.resourceId]),
    ).toEqual([
      ["resource.added", current.id, added.id],
      ["resource.updated", current.id, added.id],
      ["resource.updated", current.id, added.id],
      ["resource.removed", current.id, added.id],
    ]);
  });
});
