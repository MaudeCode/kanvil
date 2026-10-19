import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vite-plus/test";
import { and, eq } from "drizzle-orm";
import { createFixture } from "./test-fixture.ts";
import { createDomain, requireRow, type Actor, type Domain } from "./domain.ts";
import { events, invitations, projects } from "./schema.ts";
import type { MailMessage } from "./adapters/ports.ts";
import type { Workspace } from "@kanvil/contracts";

const tokenOf = (url: string) => requireRow(new URL(url).pathname.split("/").at(-1));

describe("workspace invitations", () => {
  let fixture: Awaited<ReturnType<typeof createFixture>>,
    domain: Domain,
    // The same database through a domain without an SMTP relay.
    linkOnly: Domain,
    owner: Actor,
    guest: Actor,
    other: Actor,
    workspace: Workspace;
  const sent: MailMessage[] = [];
  beforeAll(async () => {
    fixture = await createFixture();
    domain = createDomain(fixture.database, {
      publicUrl: "http://kanvil.test",
      mail: async (message) => {
        sent.push(message);
      },
    });
    linkOnly = createDomain(fixture.database, { publicUrl: "http://kanvil.test" });
    const people = await Promise.all(
      ["owner", "guest", "other"].map((name) =>
        fixture.auth.api.createUser({
          body: {
            name,
            email: `${name}@invite.test`,
            password: "Isolated invitation password 42!",
            role: "user",
          },
        }),
      ),
    );
    const actors = await Promise.all(people.map((person) => domain.actor(person.user.id)));
    owner = requireRow(actors[0]);
    guest = requireRow(actors[1]);
    other = requireRow(actors[2]);
  });
  afterAll(async () => {
    await fixture?.close();
  });
  beforeEach(async () => {
    sent.length = 0;
    workspace = await domain.execute(
      "create_workspace",
      { name: "Invitations", slug: `i-${crypto.randomUUID()}` },
      owner,
    );
  });
  const project = (visibility: "workspace" | "private" = "private") =>
    domain.execute(
      "create_project",
      {
        workspaceId: workspace.id,
        visibility,
        key: `I${crypto.randomUUID().slice(0, 8).toUpperCase()}`,
        name: "Invited project",
      },
      owner,
    );
  const invite = (
    input: {
      email?: string;
      role?: "reader" | "writer" | "admin";
      projectIds?: string[];
    } = {},
    via = domain,
  ) =>
    via.execute(
      "create_invitation",
      { workspaceId: workspace.id, email: "Guest@Invite.test", role: "writer", ...input },
      owner,
    );
  const accept = (token: string, actor = guest) =>
    domain.execute("accept_invitation", { token }, actor);
  const workspaceRole = async (actor: Actor) =>
    (await domain.execute("list_workspaces", {}, actor)).find((row) => row.id === workspace.id)
      ?.role;

  it("emails a one-time link that the invited account accepts once", async () => {
    const created = await invite();
    expect(created).toMatchObject({
      emailed: true,
      invitation: { email: "guest@invite.test", role: "writer", projects: null, status: "pending" },
    });
    expect(sent).toEqual([
      expect.objectContaining({
        to: "guest@invite.test",
        text: expect.stringContaining(created.url),
      }),
    ]);
    const token = tokenOf(created.url);
    const stored = requireRow(
      (
        await fixture.database.db
          .select()
          .from(invitations)
          .where(eq(invitations.id, created.invitation.id))
      )[0],
    );
    expect(stored.tokenHash).not.toContain(token);
    expect(await domain.execute("list_invitations", { workspaceId: workspace.id }, owner)).toEqual([
      created.invitation,
    ]);
    await expect(
      domain.execute("list_invitations", { workspaceId: workspace.id }, guest),
    ).rejects.toMatchObject({ status: 403 });
    expect(await domain.execute("get_invitation", { token }, guest)).toMatchObject({
      workspace: { id: workspace.id, name: "Invitations" },
      invitedBy: "owner",
      matchesAccount: true,
      status: "pending",
    });
    expect(await accept(token)).toEqual({ workspaceId: workspace.id, projectIds: null });
    expect(await workspaceRole(guest)).toBe("writer");
    await expect(accept(token)).rejects.toMatchObject({
      status: 410,
      code: "invitation_unavailable",
      details: { reason: "accepted" },
    });
    expect(await domain.execute("list_invitations", { workspaceId: workspace.id }, owner)).toEqual(
      [],
    );
  });

  it("returns a copyable link without an email relay and refuses a second live invitation", async () => {
    const created = await invite({}, linkOnly);
    expect(created.emailed).toBe(false);
    expect(created.url).toMatch(/^http:\/\/kanvil\.test\/invite\/[\w-]{40,}$/);
    expect(sent).toEqual([]);
    // A retry cannot replay the link, so it reports the live invitation instead of duplicating it.
    await expect(invite()).rejects.toMatchObject({ status: 409, code: "invitation_pending" });
  });

  it("rejects other accounts, unknown links, and credentials without changing access", async () => {
    const token = tokenOf((await invite()).url);
    expect(await domain.execute("get_invitation", { token }, other)).toMatchObject({
      matchesAccount: false,
    });
    await expect(accept(token, other)).rejects.toMatchObject({
      status: 403,
      code: "invitation_email_mismatch",
    });
    await expect(accept(`${token}x`)).rejects.toMatchObject({ status: 404 });
    await expect(accept(token, { ...guest, machine: true })).rejects.toMatchObject({
      status: 403,
      code: "session_required",
    });
    expect(await workspaceRole(other)).toBeUndefined();
    expect(await workspaceRole(guest)).toBeUndefined();
    expect((await accept(token)).workspaceId).toBe(workspace.id);
  });

  it("expires, rotates on resend, and stops working once revoked", async () => {
    const created = await invite(),
      first = tokenOf(created.url);
    await fixture.database.db
      .update(invitations)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(invitations.id, created.invitation.id));
    await expect(accept(first)).rejects.toMatchObject({
      status: 410,
      details: { reason: "expired" },
    });
    expect(
      (await domain.execute("list_invitations", { workspaceId: workspace.id }, owner))[0]?.status,
    ).toBe("expired");
    const resent = await domain.execute(
      "resend_invitation",
      { workspaceId: workspace.id, invitationId: created.invitation.id, expectedVersion: 1 },
      owner,
    );
    expect(resent.invitation).toMatchObject({ status: "pending", version: 2 });
    expect(sent).toHaveLength(2);
    await expect(accept(first)).rejects.toMatchObject({ status: 404 });
    await expect(
      domain.execute(
        "revoke_invitation",
        { workspaceId: workspace.id, invitationId: created.invitation.id, expectedVersion: 1 },
        owner,
      ),
    ).rejects.toMatchObject({ status: 409, code: "version_conflict" });
    await domain.execute(
      "revoke_invitation",
      { workspaceId: workspace.id, invitationId: created.invitation.id, expectedVersion: 2 },
      owner,
    );
    await expect(accept(tokenOf(resent.url))).rejects.toMatchObject({
      status: 410,
      details: { reason: "revoked" },
    });
    expect(await workspaceRole(guest)).toBeUndefined();
  });

  it("announces every invitation change to the workspace's projects without the address", async () => {
    const shared = await project();
    const changes = async () =>
      (
        await fixture.database.db
          .select()
          .from(events)
          .where(and(eq(events.projectId, shared.id), eq(events.type, "invitation.updated")))
          .orderBy(events.id)
      ).map((event) => event.data);
    const created = await invite();
    const resent = await domain.execute(
      "resend_invitation",
      { workspaceId: workspace.id, invitationId: created.invitation.id, expectedVersion: 1 },
      owner,
    );
    await domain.execute(
      "revoke_invitation",
      { workspaceId: workspace.id, invitationId: created.invitation.id, expectedVersion: 2 },
      owner,
    );
    const announced = await changes();
    expect(announced).toMatchObject([
      { workspaceId: workspace.id, invitationId: created.invitation.id, status: "pending" },
      { invitationId: resent.invitation.id, status: "pending" },
      { invitationId: created.invitation.id, status: "revoked" },
    ]);
    expect(JSON.stringify(announced)).not.toContain("invite.test");
  });

  it("keeps one live link per address when an expired invitation is resent", async () => {
    const expired = await invite();
    await fixture.database.db
      .update(invitations)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(invitations.id, expired.invitation.id));
    const replacement = await invite();
    await expect(
      domain.execute(
        "resend_invitation",
        { workspaceId: workspace.id, invitationId: expired.invitation.id, expectedVersion: 1 },
        owner,
      ),
    ).rejects.toMatchObject({ status: 409, code: "invitation_pending" });
    // The live invitation can still be resent; it is not its own duplicate.
    const resent = await domain.execute(
      "resend_invitation",
      { workspaceId: workspace.id, invitationId: replacement.invitation.id, expectedVersion: 1 },
      owner,
    );
    expect(resent.invitation.status).toBe("pending");
  });

  it("grants only the selected projects that still exist", async () => {
    const [kept, removed, hidden] = await Promise.all([project(), project(), project()]);
    const created = await invite({ role: "reader", projectIds: [kept.id, removed.id] });
    expect(created.invitation.projects?.map((item) => item.id).toSorted()).toEqual(
      [kept.id, removed.id].toSorted(),
    );
    await fixture.database.db.delete(projects).where(eq(projects.id, removed.id));
    expect(await accept(tokenOf(created.url))).toEqual({
      workspaceId: workspace.id,
      projectIds: [kept.id],
    });
    const visible = await domain.execute("list_projects", { workspaceId: workspace.id }, guest);
    expect(visible.map(({ id, role }) => ({ id, role }))).toEqual([
      { id: kept.id, role: "reader" },
    ]);
    expect(visible.some((row) => row.id === hidden.id)).toBe(false);
    expect(await workspaceRole(guest)).toBeNull();
    await expect(
      domain.execute("create_ticket", { projectId: kept.id, title: "Read only" }, guest),
    ).rejects.toMatchObject({ status: 403 });
  });

  it("never lowers access the recipient already has", async () => {
    const shared = await project("workspace");
    await domain.execute(
      "set_workspace_member",
      { workspaceId: workspace.id, email: "guest@invite.test", role: "writer" },
      owner,
    );
    await accept(tokenOf((await invite({ role: "reader", projectIds: [shared.id] })).url));
    await accept(tokenOf((await invite({ role: "reader" })).url));
    expect(await workspaceRole(guest)).toBe("writer");
    expect(
      (await domain.execute("list_projects", { workspaceId: workspace.id }, guest))[0]?.role,
    ).toBe("writer");
  });

  it("stops granting access once the sender is no longer an administrator", async () => {
    await domain.execute(
      "set_workspace_member",
      { workspaceId: workspace.id, email: "other@invite.test", role: "admin" },
      owner,
    );
    const token = tokenOf(
      (
        await domain.execute(
          "create_invitation",
          { workspaceId: workspace.id, email: "guest@invite.test", role: "admin" },
          other,
        )
      ).url,
    );
    await domain.execute(
      "set_workspace_member",
      { workspaceId: workspace.id, email: "other@invite.test", role: "writer" },
      owner,
    );
    await expect(accept(token)).rejects.toMatchObject({
      status: 403,
      code: "invitation_unauthorized",
    });
    expect(await workspaceRole(guest)).toBeUndefined();
  });

  it("lets one of two concurrent acceptances win", async () => {
    const token = tokenOf((await invite()).url);
    const results = await Promise.allSettled([accept(token), accept(token)]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.find((result) => result.status === "rejected")).toMatchObject({
      reason: { status: 410, details: { reason: "accepted" } },
    });
  });
});
