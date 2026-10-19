import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { readFile } from "node:fs/promises";
import { and, eq, sql } from "drizzle-orm";
import type { Workspace } from "@kanvil/contracts";
import { user } from "./auth-schema.ts";
import { createFixture } from "./test-fixture.ts";
import { createDomain, requireRow, type Actor, type Domain } from "./domain.ts";
import { eventClock, projects, workspaceMembers, workspaces } from "./schema.ts";

const email = (name: string) => `${name}@ownership.test`;
describe("workspace ownership and deletion", () => {
  let fixture: Awaited<ReturnType<typeof createFixture>>,
    domain: Domain,
    owner: Actor,
    deputy: Actor,
    reader: Actor,
    root: Actor;
  const signedIn = (actor: Actor, at: Date) => domain.actor(actor.id, undefined, at);
  beforeAll(async () => {
    fixture = await createFixture();
    domain = createDomain(fixture.database);
    const people = await Promise.all(
      ["owner", "deputy", "reader", "root"].map((name) =>
        fixture.auth.api.createUser({
          body: {
            name,
            email: email(name),
            password: "Isolated ownership password 42!",
            role: name === "root" ? "admin" : "user",
          },
        }),
      ),
    );
    const actors = await Promise.all(
      people.map((person) => domain.actor(person.user.id, undefined, new Date())),
    );
    owner = requireRow(actors[0]);
    deputy = requireRow(actors[1]);
    reader = requireRow(actors[2]);
    root = requireRow(actors[3]);
  });
  afterAll(async () => {
    await fixture?.close();
  });
  async function space(): Promise<Workspace> {
    const created = await domain.execute(
      "create_workspace",
      { name: "Owned", slug: `o-${crypto.randomUUID()}` },
      owner,
    );
    await domain.execute(
      "set_workspace_member",
      { workspaceId: created.id, email: email("deputy"), role: "admin" },
      owner,
    );
    await domain.execute(
      "set_workspace_member",
      { workspaceId: created.id, email: email("reader"), role: "reader" },
      owner,
    );
    return created;
  }
  const current = async (workspace: Workspace, actor = owner) =>
    requireRow(
      (await domain.execute("list_workspaces", {}, actor)).find((row) => row.id === workspace.id),
    );
  const newProject = (workspace: Workspace) =>
    domain.execute(
      "create_project",
      {
        workspaceId: workspace.id,
        visibility: "workspace",
        key: `W${crypto.randomUUID().slice(0, 8).toUpperCase()}`,
        name: "Owned project",
      },
      owner,
    );

  it("makes the creator the owner and refuses to remove or demote the owner", async () => {
    const workspace = await space();
    expect((await current(workspace, reader)).ownerId).toBe(owner.id);
    for (const role of [null, "writer"] as const)
      await expect(
        domain.execute(
          "set_workspace_member",
          { workspaceId: workspace.id, email: email("owner"), role },
          deputy,
        ),
      ).rejects.toMatchObject({ status: 409, code: "workspace_owner" });
    expect((await current(workspace)).role).toBe("admin");
  });

  it("transfers ownership only from the owner to an active administrator", async () => {
    const workspace = await space();
    const transfer = (actor: Actor, userId: string, expectedVersion = workspace.version) =>
      domain.execute(
        "transfer_workspace",
        { workspaceId: workspace.id, userId, expectedVersion },
        actor,
      );
    await expect(transfer(deputy, deputy.id)).rejects.toMatchObject({
      status: 403,
      code: "forbidden",
    });
    await expect(transfer(owner, reader.id)).rejects.toMatchObject({
      status: 409,
      code: "owner_ineligible",
    });
    await expect(transfer(owner, deputy.id, workspace.version + 1)).rejects.toMatchObject({
      code: "version_conflict",
    });
    const requestId = crypto.randomUUID();
    const moved = await domain.execute(
      "transfer_workspace",
      {
        workspaceId: workspace.id,
        userId: deputy.id,
        expectedVersion: workspace.version,
        requestId,
      },
      owner,
    );
    expect(moved).toMatchObject({ ownerId: deputy.id, version: workspace.version + 1 });
    // A retry answers from the receipt instead of transferring again.
    expect(
      await domain.execute(
        "transfer_workspace",
        {
          workspaceId: workspace.id,
          userId: deputy.id,
          expectedVersion: workspace.version,
          requestId,
        },
        owner,
      ),
    ).toEqual(moved);
    // The previous owner stays an administrator and no longer transfers.
    expect((await current(workspace)).role).toBe("admin");
    await expect(transfer(owner, owner.id, moved.version)).rejects.toMatchObject({
      code: "forbidden",
    });
    // Instance administrators can hand any workspace on.
    expect(await transfer(root, owner.id, moved.version)).toMatchObject({ ownerId: owner.id });
  });

  it("never leaves a workspace ownerless when a transfer races a removal", async () => {
    const workspace = await space();
    const outcomes = await Promise.allSettled([
      domain.execute(
        "transfer_workspace",
        { workspaceId: workspace.id, userId: deputy.id, expectedVersion: workspace.version },
        owner,
      ),
      domain.execute(
        "set_workspace_member",
        { workspaceId: workspace.id, email: email("deputy"), role: null },
        owner,
      ),
    ]);
    const rejected = outcomes.filter((outcome) => outcome.status === "rejected");
    expect(rejected).toHaveLength(1);
    expect(rejected[0]).toMatchObject({
      reason: { code: expect.stringMatching(/^(owner_ineligible|workspace_owner)$/) },
    });
    const row = requireRow(
      (
        await fixture.database.db.select().from(workspaces).where(eq(workspaces.id, workspace.id))
      )[0],
    );
    const ownerMembership = await fixture.database.db
      .select()
      .from(workspaceMembers)
      .where(
        and(
          eq(workspaceMembers.workspaceId, workspace.id),
          eq(workspaceMembers.userId, requireRow(row.ownerId ?? undefined)),
        ),
      );
    expect(ownerMembership.map((membership) => membership.role)).toEqual(["admin"]);
  });

  it("previews and deletes a workspace only for a recently signed-in owner without claims", async () => {
    const workspace = await space(),
      kept = await newProject(workspace),
      claimed = await newProject(workspace);
    const ticket = await domain.execute(
      "create_ticket",
      {
        projectId: claimed.id,
        title: "Claimed work",
        description: "Ownership work",
        acceptanceCriteria: "It is done",
        difficulty: "low",
        automationReady: true,
      },
      owner,
    );
    const worker = await domain.actor(owner.id, { ownerId: "worker", scopes: ["read", "claim"] });
    const claim = await domain.execute(
      "claim_ticket",
      {
        projectId: claimed.id,
        ticketId: ticket.id,
        workerId: "w1",
        expectedVersion: ticket.version,
      },
      worker,
    );
    const remove = (actor: Actor, confirmSlug = workspace.slug) =>
      domain.execute(
        "delete_workspace",
        { workspaceId: workspace.id, expectedVersion: workspace.version, confirmSlug },
        actor,
      );
    await expect(
      domain.execute("get_workspace_impact", { workspaceId: workspace.id }, deputy),
    ).rejects.toMatchObject({ status: 403 });
    const impact = await domain.execute(
      "get_workspace_impact",
      { workspaceId: workspace.id },
      owner,
    );
    expect(impact).toMatchObject({
      tickets: 1,
      members: 3,
      projects: expect.arrayContaining([
        expect.objectContaining({ id: kept.id, tickets: 0, archived: false }),
        expect.objectContaining({ id: claimed.id, tickets: 1 }),
      ]),
      blockers: [expect.objectContaining({ code: "claim_conflict", tickets: [ticket.key] })],
    });
    await expect(remove(deputy)).rejects.toMatchObject({ status: 403, code: "forbidden" });
    await expect(remove(await domain.actor(owner.id))).rejects.toMatchObject({
      code: "reauthentication_required",
    });
    await expect(
      remove(await signedIn(owner, new Date(Date.now() - 16 * 60_000))),
    ).rejects.toMatchObject({ code: "reauthentication_required" });
    await expect(remove(worker)).rejects.toMatchObject({ code: "session_required" });
    await expect(remove(owner, "wrong")).rejects.toMatchObject({ code: "validation_error" });
    await expect(remove(owner)).rejects.toMatchObject({ status: 409, code: "claim_conflict" });
    // Nothing changed before the blocker was reported.
    expect((await current(workspace)).version).toBe(workspace.version);
    await domain.execute(
      "release_claim",
      { projectId: claimed.id, ticketId: ticket.id, claimId: claim.id },
      worker,
    );
    const cursor = requireRow((await fixture.database.db.select().from(eventClock))[0]).value;
    const requestId = crypto.randomUUID();
    const input = {
      workspaceId: workspace.id,
      expectedVersion: workspace.version,
      confirmSlug: workspace.slug,
      requestId,
    };
    expect(await domain.execute("delete_workspace", input, owner)).toEqual({ ok: true });
    expect(await domain.execute("delete_workspace", input, owner)).toEqual({ ok: true });
    expect(
      (await domain.execute("list_workspaces", {}, reader)).map((row) => row.id),
    ).not.toContain(workspace.id);
    expect((await domain.execute("list_workspaces", {}, root)).map((row) => row.id)).not.toContain(
      workspace.id,
    );
    await expect(
      domain.execute("list_workspace_members", { workspaceId: workspace.id }, root),
    ).rejects.toMatchObject({ status: 404 });
    const tombstones = await fixture.database.db
      .select({ deletedAt: projects.deletedAt })
      .from(projects)
      .where(eq(projects.workspaceId, workspace.id));
    expect(tombstones.every((row) => row.deletedAt)).toBe(true);
    // Former readers still receive the deletions; accounts are untouched.
    expect(
      (await domain.readEvents(reader, cursor)).items
        .filter((event) => event.type === "project.deleted")
        .map((event) => event.projectId)
        .toSorted(),
    ).toEqual([kept.id, claimed.id].toSorted());
    expect(
      await fixture.database.db.$count(user, sql`${user.id} IN (${owner.id}, ${reader.id})`),
    ).toBe(2);
    // The URL key stays reserved.
    await expect(
      domain.execute("create_workspace", { name: "Again", slug: workspace.slug }, owner),
    ).rejects.toMatchObject({ code: "duplicate_workspace" });
  });

  it("assigns existing workspaces deterministically when ownership is introduced", async () => {
    const workspace = await space();
    await domain.execute(
      "set_workspace_member",
      { workspaceId: workspace.id, email: email("root"), role: "admin" },
      owner,
    );
    // The earliest active administrator wins; a disabled one is passed over.
    const created = (id: string, at: string, banned = false) =>
      fixture.database.db
        .update(user)
        .set({ createdAt: new Date(at), banned })
        .where(eq(user.id, id));
    await created(owner.id, "1999-01-01T00:00:00Z", true);
    await created(root.id, "2000-01-01T00:00:00Z");
    await fixture.database.db
      .update(workspaces)
      .set({ ownerId: null })
      .where(eq(workspaces.id, workspace.id));
    const migration = await readFile(
      new URL("../drizzle/0032_workspace_ownership.sql", import.meta.url),
      "utf8",
    );
    await fixture.database.pool.query(
      requireRow(migration.split("--> statement-breakpoint").at(-1)),
    );

    expect(
      requireRow(
        (
          await fixture.database.db
            .select({ ownerId: workspaces.ownerId })
            .from(workspaces)
            .where(eq(workspaces.id, workspace.id))
        )[0],
      ).ownerId,
    ).toBe(root.id);
  });
});
