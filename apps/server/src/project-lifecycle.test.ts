import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { and, eq, inArray } from "drizzle-orm";
import type { Project, Workspace } from "@kanvil/contracts";
import { createFixture } from "./test-fixture.ts";
import { createDomain, requireRow, type Actor, type Domain } from "./domain.ts";
import { readCalendarFeed } from "./calendar-operations.ts";
import {
  attachments,
  events,
  invitations,
  projectLabels,
  relations,
  subscriptions,
  tickets,
} from "./schema.ts";

describe("project lifecycle", () => {
  let fixture: Awaited<ReturnType<typeof createFixture>>,
    domain: Domain,
    owner: Actor,
    member: Actor,
    guest: Actor,
    deputy: Actor;
  const emails = {
    member: "member@lifecycle.test",
    guest: "guest@lifecycle.test",
    deputy: "deputy@lifecycle.test",
  };
  beforeAll(async () => {
    fixture = await createFixture();
    domain = createDomain(fixture.database);
    const people = await Promise.all(
      ["owner", "member", "guest", "deputy"].map((name) =>
        fixture.auth.api.createUser({
          body: {
            name,
            email: `${name}@lifecycle.test`,
            password: "Isolated lifecycle password 42!",
            role: "user",
          },
        }),
      ),
    );
    const actors = await Promise.all(people.map((person) => domain.actor(person.user.id)));
    owner = requireRow(actors[0]);
    member = requireRow(actors[1]);
    guest = requireRow(actors[2]);
    deputy = requireRow(actors[3]);
  });
  afterAll(async () => {
    await fixture?.close();
  });
  const space = (name: string): Promise<Workspace> =>
    domain.execute("create_workspace", { name, slug: `l-${crypto.randomUUID()}` }, owner);
  const newProject = (workspace: Workspace, visibility: "workspace" | "private" = "workspace") =>
    domain.execute(
      "create_project",
      {
        workspaceId: workspace.id,
        visibility,
        key: `L${crypto.randomUUID().slice(0, 8).toUpperCase()}`,
        name: "Lifecycle project",
      },
      owner,
    );
  const join = (workspace: Workspace, email: string, role: "reader" | "writer" | "admin" | null) =>
    domain.execute("set_workspace_member", { workspaceId: workspace.id, email, role }, owner);
  const current = (project: Project) =>
    domain.execute("get_project", { projectId: project.id }, owner);
  const readyTicket = (project: Project, title = "Agent work") =>
    domain.execute(
      "create_ticket",
      {
        projectId: project.id,
        title,
        description: "Lifecycle work",
        acceptanceCriteria: "It is done",
        difficulty: "low",
        automationReady: true,
        dueAt: "2099-01-01T00:00:00.000Z",
      },
      owner,
    );
  const claim = async (project: Project, ticket: { id: string; version: number }) =>
    domain.execute(
      "claim_ticket",
      {
        projectId: project.id,
        ticketId: ticket.id,
        workerId: "w1",
        expectedVersion: ticket.version,
      },
      await domain.actor(owner.id, { ownerId: "worker", scopes: ["read", "claim"] }),
    );

  it("archives a project out of default reads and agent queues and restores it", async () => {
    const workspace = await space("Archive"),
      project = await newProject(workspace);
    await join(workspace, emails.member, "writer");
    const ticket = await readyTicket(project, "Archived needle");
    await domain.execute(
      "update_ticket",
      {
        projectId: project.id,
        ticketId: ticket.id,
        expectedVersion: ticket.version,
        changes: { assigneeId: member.id },
      },
      owner,
    );
    const feed = await domain.execute(
      "create_calendar_feed",
      { projectId: project.id, name: "Due", timeZone: "UTC" },
      owner,
    );
    const token = requireRow(feed.path.match(/\/api\/calendar\/(.+)\.ics$/)?.[1]);
    const listed = async (archived?: "include" | "only") =>
      (
        await domain.execute(
          "list_projects",
          { workspaceId: workspace.id, ...(archived ? { archived } : {}) },
          member,
        )
      ).map((row) => row.id);
    await expect(
      domain.execute(
        "archive_project",
        { projectId: project.id, expectedVersion: project.version, archived: true },
        member,
      ),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      domain.execute(
        "archive_project",
        { projectId: project.id, expectedVersion: project.version + 1, archived: true },
        owner,
      ),
    ).rejects.toMatchObject({ code: "version_conflict" });
    const archived = await domain.execute(
      "archive_project",
      { projectId: project.id, expectedVersion: project.version, archived: true },
      owner,
    );
    expect(archived.archivedAt).not.toBeNull();
    expect(await listed()).toEqual([]);
    expect(await listed("include")).toEqual([project.id]);
    expect(await listed("only")).toEqual([project.id]);
    expect(
      (await domain.execute("list_my_work", { workspaceId: workspace.id }, member)).items,
    ).toEqual([]);
    expect(
      (await domain.execute("search_tickets", { q: "needle", workspaceId: workspace.id }, member))
        .items,
    ).toEqual([]);
    expect(
      (await domain.execute("search_workspace", { q: "needle", workspaceId: workspace.id }, member))
        .items,
    ).toEqual([]);
    expect(await readCalendarFeed(fixture.database.db, token, "http://localhost")).not.toContain(
      "BEGIN:VEVENT",
    );
    // History stays readable; agents see why the work is not eligible.
    const read = await domain.execute(
      "get_ticket",
      { projectId: project.id, ticketId: ticket.key },
      member,
    );
    expect(read.readiness.reasons.map((reason) => reason.code)).toContain("project_archived");
    expect(
      (await domain.execute("list_eligible_tickets", { projectId: project.id }, owner)).items.every(
        (item) => !item.readiness.ready,
      ),
    ).toBe(true);
    await expect(
      domain.execute("create_ticket", { projectId: project.id, title: "Blocked" }, member),
    ).rejects.toMatchObject({ status: 409, code: "project_archived" });
    await expect(claim(project, read.ticket)).rejects.toMatchObject({
      status: 409,
      code: "project_archived",
    });
    // Access management still works while archived.
    await domain.execute(
      "set_member",
      { projectId: project.id, email: emails.guest, role: "reader" },
      owner,
    );
    const restored = await domain.execute(
      "archive_project",
      { projectId: project.id, expectedVersion: archived.version, archived: false },
      owner,
    );
    expect(restored.archivedAt).toBeNull();
    expect(await listed()).toEqual([project.id]);
    expect(
      (await domain.execute("list_my_work", { workspaceId: workspace.id }, member)).items.map(
        (item) => item.id,
      ),
    ).toEqual([ticket.id]);
    expect(await readCalendarFeed(fixture.database.db, token, "http://localhost")).toContain(
      "BEGIN:VEVENT",
    );
    const types = (
      await fixture.database.db
        .select({ type: events.type })
        .from(events)
        .where(eq(events.projectId, project.id))
    ).map((row) => row.type);
    expect(types).toEqual(expect.arrayContaining(["project.archived", "project.restored"]));
  });

  it("refuses to archive or delete a project while a ticket is claimed", async () => {
    const workspace = await space("Claims"),
      project = await newProject(workspace);
    const ticket = await readyTicket(project);
    await claim(project, ticket);
    for (const [name, input] of [
      ["archive_project", { archived: true }],
      ["delete_project", { confirmKey: project.key }],
    ] as const)
      await expect(
        domain.execute(
          name,
          { projectId: project.id, expectedVersion: project.version, ...input },
          owner,
        ),
      ).rejects.toMatchObject({
        status: 409,
        code: "claim_conflict",
        details: { blockers: [{ code: "claim_conflict", tickets: [ticket.key] }] },
      });
    expect(
      (await domain.execute("get_project_impact", { projectId: project.id }, owner)).blockers,
    ).toEqual([expect.objectContaining({ code: "claim_conflict", tickets: [ticket.key] })]);
    expect((await current(project)).archivedAt).toBeNull();
  });

  it("deletes a project after a reviewed impact, keeping its prefix and history", async () => {
    const workspace = await space("Delete"),
      project = await newProject(workspace),
      other = await newProject(workspace);
    await join(workspace, emails.member, "writer");
    const ticket = await readyTicket(project);
    await domain.execute(
      "add_comment",
      { projectId: project.id, ticketId: ticket.id, body: "Goes with the project" },
      owner,
    );
    await domain.execute(
      "upload_attachment",
      {
        projectId: project.id,
        ticketId: ticket.id,
        name: "notes.txt",
        contentType: "text/plain",
        data: Buffer.from("hello").toString("base64"),
      },
      owner,
    );
    const invited = await domain.execute(
      "create_invitation",
      {
        workspaceId: workspace.id,
        email: "solo@lifecycle.test",
        role: "reader",
        projectIds: [project.id],
      },
      owner,
    );
    const shared = await domain.execute(
      "create_invitation",
      {
        workspaceId: workspace.id,
        email: "both@lifecycle.test",
        role: "reader",
        projectIds: [project.id, other.id],
      },
      owner,
    );
    expect(
      await domain.execute("get_project_impact", { projectId: project.id }, owner),
    ).toMatchObject({
      tickets: 1,
      comments: 1,
      attachments: 1,
      attachmentBytes: 5,
      blockers: [],
      transfer: null,
    });
    await expect(
      domain.execute("get_project_impact", { projectId: project.id }, member),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      domain.execute(
        "delete_project",
        { projectId: project.id, expectedVersion: project.version, confirmKey: project.key },
        member,
      ),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      domain.execute(
        "delete_project",
        { projectId: project.id, expectedVersion: project.version, confirmKey: "WRONG" },
        owner,
      ),
    ).rejects.toMatchObject({ status: 400, code: "validation_error" });
    await expect(
      domain.execute(
        "delete_project",
        { projectId: project.id, expectedVersion: project.version + 1, confirmKey: project.key },
        owner,
      ),
    ).rejects.toMatchObject({ code: "version_conflict" });
    const input = {
      projectId: project.id,
      expectedVersion: project.version,
      confirmKey: project.key.toLowerCase(),
      requestId: crypto.randomUUID(),
    };
    expect(await domain.execute("delete_project", input, owner)).toEqual({ ok: true });
    // A lost response retries safely even though the project no longer authorizes anyone.
    expect(await domain.execute("delete_project", input, owner)).toEqual({ ok: true });
    await expect(current(project)).rejects.toMatchObject({ status: 404 });
    await expect(
      domain.execute("list_tickets", { projectId: project.key }, owner),
    ).rejects.toMatchObject({ status: 404 });
    expect(
      (await domain.execute("list_projects", { archived: "include" }, owner)).map((row) => row.id),
    ).not.toContain(project.id);
    await expect(
      domain.execute(
        "create_project",
        { workspaceId: workspace.id, key: project.key, name: "Reuse" },
        owner,
      ),
    ).rejects.toMatchObject({ code: "duplicate_prefix" });
    const db = fixture.database.db;
    expect(await db.select().from(tickets).where(eq(tickets.projectId, project.id))).toEqual([]);
    expect(
      await db.select().from(attachments).where(eq(attachments.projectId, project.id)),
    ).toEqual([]);
    const history = await db
      .select({ type: events.type, ticketId: events.ticketId, actorId: events.actorId })
      .from(events)
      .where(eq(events.projectId, project.id));
    expect(history).toEqual(
      expect.arrayContaining([
        { type: "ticket.created", ticketId: ticket.id, actorId: owner.id },
        { type: "comment.created", ticketId: ticket.id, actorId: owner.id },
        { type: "ticket.deleted", ticketId: ticket.id, actorId: owner.id },
        { type: "project.deleted", ticketId: null, actorId: owner.id },
      ]),
    );
    expect(history.filter((event) => event.type === "project.deleted")).toHaveLength(1);
    const left = await db
      .select({
        id: invitations.id,
        status: invitations.status,
        projectIds: invitations.projectIds,
      })
      .from(invitations)
      .where(inArray(invitations.id, [invited.invitation.id, shared.invitation.id]));
    expect(left).toEqual(
      expect.arrayContaining([
        { id: invited.invitation.id, status: "revoked", projectIds: [] },
        { id: shared.invitation.id, status: "pending", projectIds: [other.id] },
      ]),
    );
  });

  it("moves a project between workspaces with explicit access, label, and follow reconciliation", async () => {
    const source = await space("Source"),
      destination = await space("Destination"),
      project = await newProject(source),
      sibling = await newProject(source);
    await join(source, emails.member, "writer");
    await join(destination, emails.guest, "reader");
    await domain.execute(
      "set_member",
      { projectId: project.id, email: emails.deputy, role: "writer" },
      owner,
    );
    for (const [workspace, name, color] of [
      [source, "Shared here", "blue"],
      [source, "Shared both", "green"],
      [destination, "Shared both", "red"],
      [destination, "Local there", "purple"],
    ] as const)
      await domain.execute(
        "create_workspace_label",
        { workspaceId: workspace.id, name, color },
        owner,
      );
    await domain.execute(
      "create_project_label",
      { projectId: project.id, name: "Local there", color: "gray" },
      owner,
    );
    const ticket = await domain.execute(
      "create_ticket",
      {
        projectId: project.id,
        title: "Travels with the project",
        labels: ["Shared here", "Shared both", "Local there"],
      },
      owner,
    );
    await domain.execute(
      "set_subscription",
      { projectId: project.id, ticketId: ticket.id, enabled: true },
      member,
    );
    await domain.execute(
      "set_subscription",
      { projectId: project.id, ticketId: ticket.id, enabled: true },
      deputy,
    );
    const invited = await domain.execute(
      "create_invitation",
      {
        workspaceId: source.id,
        email: "late@lifecycle.test",
        role: "reader",
        projectIds: [project.id],
      },
      owner,
    );
    await expect(
      domain.execute(
        "get_project_impact",
        { projectId: project.id, workspaceId: source.id },
        owner,
      ),
    ).rejects.toMatchObject({ status: 400 });
    const impact = await domain.execute(
      "get_project_impact",
      { projectId: project.id, workspaceId: destination.id },
      owner,
    );
    expect(impact).toMatchObject({
      blockers: [],
      transfer: {
        workspaceId: destination.id,
        losingAccess: [{ email: emails.member }],
        gainingAccess: [{ email: emails.guest }],
        copiedLabels: ["Shared here"],
        mergedLabels: ["Local there", "Shared both"],
        subscriptions: 1,
        invitations: 1,
      },
    });
    const input = {
      projectId: project.id,
      expectedVersion: project.version,
      workspaceId: destination.id,
      requestId: crypto.randomUUID(),
    };
    const moved = await domain.execute("transfer_project", input, owner);
    expect(await domain.execute("transfer_project", input, owner)).toEqual(moved);
    expect(moved).toMatchObject({ id: project.id, key: project.key, workspaceId: destination.id });
    // Ticket identity and links are unchanged.
    expect(
      (await domain.execute("get_ticket", { projectId: project.key, ticketId: ticket.key }, guest))
        .ticket,
    ).toMatchObject({ id: ticket.id, key: ticket.key, labels: ticket.labels });
    await expect(
      domain.execute("get_project", { projectId: project.id }, member),
    ).rejects.toMatchObject({ status: 404 });
    expect(
      (await domain.execute("list_projects", { workspaceId: destination.id }, deputy)).map(
        (row) => row.id,
      ),
    ).toEqual([project.id]);
    expect(
      (await domain.execute("list_project_labels", { projectId: project.id }, owner)).map(
        ({ name, color, scope }) => ({ name, color, scope }),
      ),
    ).toEqual(
      expect.arrayContaining([
        { name: "Shared here", color: "blue", scope: "project" },
        { name: "Shared both", color: "red", scope: "workspace" },
        { name: "Local there", color: "purple", scope: "workspace" },
      ]),
    );
    const db = fixture.database.db;
    expect(
      (
        await db
          .select({ name: projectLabels.name })
          .from(projectLabels)
          .where(eq(projectLabels.projectId, project.id))
      ).map((row) => row.name),
    ).toEqual(["Shared here"]);
    expect(
      (
        await db
          .select({ userId: subscriptions.userId })
          .from(subscriptions)
          .where(eq(subscriptions.ticketId, ticket.id))
      ).map((row) => row.userId),
    ).not.toContain(member.id);
    expect(
      (
        await db
          .select({ userId: subscriptions.userId })
          .from(subscriptions)
          .where(and(eq(subscriptions.ticketId, ticket.id), eq(subscriptions.userId, deputy.id)))
      ).length,
    ).toBe(1);
    expect(
      requireRow(
        (
          await db
            .select({ status: invitations.status })
            .from(invitations)
            .where(eq(invitations.id, invited.invitation.id))
        )[0],
      ).status,
    ).toBe("revoked");
    // The source keeps its other projects; the moved one lands at the end of the destination.
    expect(
      (await domain.execute("list_projects", { workspaceId: source.id }, owner)).map(
        (row) => row.id,
      ),
    ).toEqual([sibling.id]);
    const transferred = (
      await db
        .select({ type: events.type })
        .from(events)
        .where(and(eq(events.projectId, project.id), eq(events.type, "project.transferred")))
    ).length;
    expect(transferred).toBe(1);
  });

  it("requires administration of both workspaces, rechecked when the move commits", async () => {
    const source = await space("Guarded source"),
      destination = await space("Guarded destination"),
      project = await newProject(source, "private");
    await join(destination, emails.deputy, "admin");
    await domain.execute(
      "set_member",
      { projectId: project.id, email: emails.deputy, role: "admin" },
      owner,
    );
    // A project administrator who does not administer the source workspace cannot take it away.
    await expect(
      domain.execute(
        "transfer_project",
        { projectId: project.id, expectedVersion: project.version, workspaceId: destination.id },
        deputy,
      ),
    ).rejects.toMatchObject({ status: 403, code: "workspace_access_required" });
    await join(source, emails.deputy, "admin");
    await join(source, emails.member, "admin");
    await join(source, emails.guest, "writer");
    const preview = await domain.execute(
      "get_project_impact",
      { projectId: project.id, workspaceId: destination.id },
      deputy,
    );
    // Private: the source's writer never had access and its other administrator loses it; the
    // deputy keeps it as a direct member.
    expect(preview.transfer?.losingAccess.map((person) => person.email)).toEqual([emails.member]);
    expect(preview.transfer?.gainingAccess).toEqual([]);
    // Access changes between the preview and the write.
    await join(destination, emails.deputy, "writer");
    await expect(
      domain.execute(
        "transfer_project",
        { projectId: project.id, expectedVersion: project.version, workspaceId: destination.id },
        deputy,
      ),
    ).rejects.toMatchObject({ status: 403, code: "workspace_access_required" });
    await expect(
      domain.execute(
        "transfer_project",
        {
          projectId: project.id,
          expectedVersion: project.version + 1,
          workspaceId: destination.id,
        },
        owner,
      ),
    ).rejects.toMatchObject({ code: "version_conflict" });
    expect((await current(project)).workspaceId).toBe(source.id);
    await expect(
      domain.execute(
        "transfer_project",
        { projectId: project.id, expectedVersion: project.version, workspaceId: source.id },
        owner,
      ),
    ).rejects.toMatchObject({ status: 400 });
    const credential = await domain.actor(owner.id, {
      ownerId: owner.id,
      scopes: ["admin"],
      projectIds: [project.id],
    });
    await expect(
      domain.execute(
        "transfer_project",
        { projectId: project.id, expectedVersion: project.version, workspaceId: destination.id },
        credential,
      ),
    ).rejects.toMatchObject({ status: 403 });
  });

  it("leaves everything in place when a move is blocked", async () => {
    const source = await space("Blocked source"),
      destination = await space("Blocked destination"),
      project = await newProject(source),
      other = await newProject(source);
    await domain.execute(
      "create_workspace_label",
      { workspaceId: source.id, name: "Kept", color: "blue" },
      owner,
    );
    const claimed = await readyTicket(project);
    await domain.execute(
      "update_ticket",
      {
        projectId: project.id,
        ticketId: claimed.id,
        expectedVersion: claimed.version,
        changes: { labels: ["Kept"] },
      },
      owner,
    );
    const refreshed = (
      await domain.execute("get_ticket", { projectId: project.id, ticketId: claimed.id }, owner)
    ).ticket;
    await claim(project, refreshed);
    const move = () =>
      domain.execute(
        "transfer_project",
        { projectId: project.id, expectedVersion: project.version, workspaceId: destination.id },
        owner,
      );
    await expect(move()).rejects.toMatchObject({ status: 409, code: "claim_conflict" });
    expect((await current(project)).workspaceId).toBe(source.id);
    expect(
      await fixture.database.db
        .select()
        .from(projectLabels)
        .where(eq(projectLabels.projectId, project.id)),
    ).toEqual([]);
    // A relationship into another project, which only older data can hold, also blocks the move.
    const plain = await domain.execute(
      "create_ticket",
      { projectId: project.id, title: "Linked out" },
      owner,
    );
    const outside = await domain.execute(
      "create_ticket",
      { projectId: other.id, title: "Elsewhere" },
      owner,
    );
    await fixture.database.db
      .insert(relations)
      .values({ projectId: project.id, sourceId: plain.id, targetId: outside.id, type: "related" });
    const impact = await domain.execute(
      "get_project_impact",
      { projectId: project.id, workspaceId: destination.id },
      owner,
    );
    expect(impact.blockers).toEqual([
      expect.objectContaining({ code: "claim_conflict", tickets: [claimed.key] }),
      expect.objectContaining({ code: "relation_conflict", tickets: [plain.key] }),
    ]);
  });
});
