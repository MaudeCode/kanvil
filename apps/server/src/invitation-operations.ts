import { createHash, randomBytes } from "node:crypto";
import { and, desc, eq, gt, inArray, ne } from "drizzle-orm";
import {
  hasAdminRole,
  invitationStatuses,
  roleLabels,
  roles,
  type Invitation,
} from "@kanvil/contracts";
import { user } from "./auth-schema.ts";
import { invitations, members, projects, workspaceMembers, workspaces } from "./schema.ts";
import { projectRole } from "./project-access.ts";
import { publishWorkspace } from "./workspace-operations.ts";
import {
  assertVersion,
  fail,
  one,
  publishMany,
  workspace,
  type Context,
  type Handlers,
} from "./domain.ts";

type Row = typeof invitations.$inferSelect;
type Role = (typeof roles)[number];
const rank = (role: string | null | undefined) => roles.findIndex((item) => item === role);
const digest = (token: string) => createHash("sha256").update(token).digest("hex");
const statusOf = (row: Row): Invitation["status"] =>
  row.status === "pending" && row.expiresAt <= new Date()
    ? "expired"
    : (invitationStatuses.find((status) => status === row.status) ?? "revoked");
const roleOf = (row: Row): Role => roles.find((role) => role === row.role) ?? "reader";
const expiry = (days: number) => new Date(Date.now() + days * 86_400_000);
function unavailable(row: Row) {
  const status = statusOf(row);
  if (status !== "pending")
    fail(410, "invitation_unavailable", `This invitation is ${status}`, { reason: status });
}
async function projectsOf(ctx: Context, rows: Row[]) {
  const ids = [...new Set(rows.flatMap((row) => row.projectIds ?? []))];
  return ids.length
    ? ctx.db
        .select({ id: projects.id, key: projects.key, name: projects.name })
        .from(projects)
        .where(inArray(projects.id, ids))
        .orderBy(projects.name)
    : [];
}
async function present(ctx: Context, rows: Row[]): Promise<Invitation[]> {
  const known = await projectsOf(ctx, rows),
    senderIds = [...new Set(rows.flatMap((row) => (row.invitedBy ? [row.invitedBy] : [])))];
  const inviters = new Map(
    senderIds.length
      ? (
          await ctx.db
            .select({ id: user.id, name: user.name })
            .from(user)
            .where(inArray(user.id, senderIds))
        ).map((row) => [row.id, row.name])
      : [],
  );
  return rows.map((row) => ({
    id: row.id,
    workspaceId: row.workspaceId,
    email: row.email,
    role: roleOf(row),
    projects: row.projectIds ? known.filter((item) => row.projectIds?.includes(item.id)) : null,
    status: statusOf(row),
    invitedBy: (row.invitedBy && inviters.get(row.invitedBy)) ?? null,
    expiresAt: row.expiresAt.toISOString(),
    sentAt: row.sentAt.toISOString(),
    version: row.version,
  }));
}
// Other administrators' invitation lists follow these events. Project readers receive them too,
// so they carry no address.
const announce = (ctx: Context, row: Row) =>
  publishWorkspace(ctx, row.workspaceId, "invitation.updated", {
    invitationId: row.id,
    status: row.status,
  });
// Issues a fresh token, stores only its hash, and queues the email when the instance has a relay.
async function send(ctx: Context, write: (tokenHash: string) => Promise<Row[]>) {
  const token = randomBytes(32).toString("base64url");
  const row = one(await write(digest(token)));
  await announce(ctx, row);
  const invitation = one(await present(ctx, [row]));
  const url = new URL(`/invite/${token}`, ctx.publicUrl).href;
  const access = invitation.projects
    ? invitation.projects.map((item) => item.name).join(", ")
    : `the ${workspace(ctx).name} workspace`;
  ctx.mail?.({
    to: row.email,
    subject: `Join ${workspace(ctx).name} on Kanvil`,
    text: `${invitation.invitedBy ?? "A workspace administrator"} invited you to ${access} with ${roleLabels[invitation.role]} access.\n\nSign in as ${row.email} and open this link before ${row.expiresAt.toUTCString()}:\n\n${url}`,
  });
  return { invitation, url, emailed: !!ctx.mail };
}
async function pendingRow(ctx: Context, invitationId: string, expectedVersion: number) {
  const row = one(
    await ctx.db
      .select()
      .from(invitations)
      .where(and(eq(invitations.id, invitationId), eq(invitations.workspaceId, workspace(ctx).id))),
  );
  if (row.status !== "pending")
    fail(410, "invitation_unavailable", `This invitation is ${row.status}`, {
      reason: row.status,
    });
  assertVersion(row, expectedVersion, "invitation");
  return row;
}
// One live link per address: creating or reviving another would leave two working invitations.
async function assertNoLiveInvitation(ctx: Context, email: string, except?: string) {
  const live = await ctx.db
    .select({ id: invitations.id })
    .from(invitations)
    .where(
      and(
        eq(invitations.workspaceId, workspace(ctx).id),
        eq(invitations.email, email),
        eq(invitations.status, "pending"),
        gt(invitations.expiresAt, new Date()),
        except ? ne(invitations.id, except) : undefined,
      ),
    );
  if (live.length)
    fail(409, "invitation_pending", "This email already has a pending invitation; resend it");
}
async function byToken(ctx: Context, token: string) {
  const row = (
    await ctx.db
      .select({ invitation: invitations, workspace: { id: workspaces.id, name: workspaces.name } })
      .from(invitations)
      .innerJoin(workspaces, eq(workspaces.id, invitations.workspaceId))
      .where(eq(invitations.tokenHash, digest(token)))
  )[0];
  if (!row) fail(404, "not_found", "This invitation link is not valid");
  const account = one(
    await ctx.db.select({ email: user.email }).from(user).where(eq(user.id, ctx.actor.id)),
  );
  return { ...row, matches: account.email.toLowerCase() === row.invitation.email };
}
// The sender must still administer the workspace, so a demoted or disabled admin's links stop
// granting anything.
async function senderCanGrant(ctx: Context, row: Row) {
  if (!row.invitedBy) return false;
  const sender = (
    await ctx.db
      .select({ role: user.role, banned: user.banned, membership: workspaceMembers.role })
      .from(user)
      .leftJoin(
        workspaceMembers,
        and(
          eq(workspaceMembers.userId, user.id),
          eq(workspaceMembers.workspaceId, row.workspaceId),
        ),
      )
      .where(eq(user.id, row.invitedBy))
  )[0];
  return !!sender && !sender.banned && (hasAdminRole(sender.role) || sender.membership === "admin");
}
export const invitationHandlers: Pick<
  Handlers,
  | "list_invitations"
  | "create_invitation"
  | "resend_invitation"
  | "revoke_invitation"
  | "get_invitation"
  | "accept_invitation"
> = {
  async list_invitations(ctx) {
    const rows = await ctx.db
      .select()
      .from(invitations)
      .where(and(eq(invitations.workspaceId, workspace(ctx).id), eq(invitations.status, "pending")))
      .orderBy(desc(invitations.sentAt));
    return present(ctx, rows);
  },
  async create_invitation(ctx, input) {
    const space = workspace(ctx);
    if (input.projectIds) {
      const wanted = [...new Set(input.projectIds)];
      const found = await ctx.db
        .select({ id: projects.id })
        .from(projects)
        .where(and(eq(projects.workspaceId, space.id), inArray(projects.id, wanted)));
      if (found.length !== wanted.length)
        fail(404, "not_found", "A selected project is not in this workspace");
    }
    await assertNoLiveInvitation(ctx, input.email);
    return send(ctx, (tokenHash) =>
      ctx.db
        .insert(invitations)
        .values({
          workspaceId: space.id,
          email: input.email,
          role: input.role,
          projectIds: input.projectIds ? [...new Set(input.projectIds)] : null,
          tokenHash,
          invitedBy: ctx.actor.id,
          expiresAt: expiry(input.expiresInDays),
        })
        .returning(),
    );
  },
  async resend_invitation(ctx, input) {
    const row = await pendingRow(ctx, input.invitationId, input.expectedVersion);
    await assertNoLiveInvitation(ctx, row.email, row.id);
    // The new link replaces the old one, and the resending administrator becomes its sender.
    return send(ctx, (tokenHash) =>
      ctx.db
        .update(invitations)
        .set({
          tokenHash,
          invitedBy: ctx.actor.id,
          expiresAt: expiry(input.expiresInDays),
          sentAt: new Date(),
          version: row.version + 1,
          updatedAt: new Date(),
        })
        .where(eq(invitations.id, row.id))
        .returning(),
    );
  },
  async revoke_invitation(ctx, input) {
    const row = await pendingRow(ctx, input.invitationId, input.expectedVersion);
    await announce(
      ctx,
      one(
        await ctx.db
          .update(invitations)
          .set({ status: "revoked", version: row.version + 1, updatedAt: new Date() })
          .where(eq(invitations.id, row.id))
          .returning(),
      ),
    );
    return { ok: true };
  },
  async get_invitation(ctx, input) {
    const found = await byToken(ctx, input.token);
    // The output schema keeps the reader-facing fields.
    return {
      ...one(await present(ctx, [found.invitation])),
      workspace: found.workspace,
      matchesAccount: found.matches,
    };
  },
  async accept_invitation(ctx, input) {
    const { invitation: row, matches } = await byToken(ctx, input.token);
    unavailable(row);
    if (!matches)
      fail(
        403,
        "invitation_email_mismatch",
        "This invitation is for another email address. Sign in with that account to accept it.",
      );
    if (!(await senderCanGrant(ctx, row)))
      fail(
        403,
        "invitation_unauthorized",
        "The sender can no longer grant this access. Ask a workspace administrator for a new invitation.",
      );
    const role = roleOf(row),
      userId = ctx.actor.id;
    let granted: string[] | null = null;
    // Accepting only ever raises access: an existing role at or above the invited one stays.
    if (!row.projectIds) {
      const current = (
        await ctx.db
          .select({ role: workspaceMembers.role })
          .from(workspaceMembers)
          .where(
            and(
              eq(workspaceMembers.workspaceId, row.workspaceId),
              eq(workspaceMembers.userId, userId),
            ),
          )
      )[0];
      if (rank(current?.role) < rank(role))
        await ctx.db
          .insert(workspaceMembers)
          .values({ workspaceId: row.workspaceId, userId, role })
          .onConflictDoUpdate({
            target: [workspaceMembers.workspaceId, workspaceMembers.userId],
            set: { role },
          });
      await publishWorkspace(ctx, row.workspaceId, "membership.updated", { userId, role });
    } else {
      // Projects deleted or moved since the invitation was sent are skipped. A direct role
      // overrides an inherited one, so compare with the effective role before writing one.
      const targets = await ctx.db
        .select()
        .from(projects)
        .where(
          and(eq(projects.workspaceId, row.workspaceId), inArray(projects.id, row.projectIds)),
        );
      granted = targets.map((target) => target.id);
      if (!targets.length)
        fail(410, "invitation_unavailable", "The invited projects no longer exist", {
          reason: "projects_removed",
        });
      for (const target of targets)
        if (rank(await projectRole(ctx.db, ctx.actor, target)) < rank(role))
          await ctx.db
            .insert(members)
            .values({ projectId: target.id, userId, role })
            .onConflictDoUpdate({ target: [members.projectId, members.userId], set: { role } });
      await publishMany(
        ctx,
        targets.map((target) => ({
          type: "membership.updated",
          ticketId: null,
          projectId: target.id,
          data: { workspaceId: row.workspaceId, userId, role },
        })),
      );
    }
    await ctx.db
      .update(invitations)
      .set({
        status: "accepted",
        acceptedBy: userId,
        version: row.version + 1,
        updatedAt: new Date(),
      })
      .where(and(eq(invitations.id, row.id), eq(invitations.status, "pending")));
    return { workspaceId: row.workspaceId, projectIds: granted };
  },
};
