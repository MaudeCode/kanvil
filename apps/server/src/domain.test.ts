import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vite-plus/test";
import { createFixture } from "./test-fixture.ts";
import { createDomain, type Actor, type Domain } from "./domain.ts";
import { relationReference, relationChoices, type Project } from "@kanvil/contracts";

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
    ).toMatchObject({ label: "defect, server", priority: "high" });
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
    const cursor = (await domain.readEvents(owner, 0n)).cursor;
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
    const cursor = (await domain.readEvents(owner, 0n)).cursor;
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
    const listed = await domain.execute("list_projects", {}, owner);
    expect(listed.find((entry) => entry.id === project.id)).toMatchObject({
      openTickets: 3,
      overdueTickets: 1,
    });
    expect(await list({ limit: 1, offset: 5 })).toEqual({ titles: [], total: 3 });
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
});
