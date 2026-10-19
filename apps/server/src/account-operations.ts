import {
  and,
  asc,
  count,
  eq,
  gt,
  inArray,
  isNotNull,
  isNull,
  ne,
  or,
  sql,
  type SQL,
} from "drizzle-orm";
import type { PgTable } from "drizzle-orm/pg-core";
import { deletedAccountName, hasAdminRole, type AccountImpact } from "@kanvil/contracts";
import {
  account,
  apikey,
  oauthAccessToken,
  oauthClient,
  oauthConsent,
  oauthRefreshToken,
  session,
  user,
} from "./auth-schema.ts";
import {
  calendarFeeds,
  claims,
  comments,
  eventAudiences,
  events,
  importRuns,
  members,
  notificationChannels,
  notificationPreferences,
  notifications,
  profilePhotos,
  projects,
  pushDevices,
  subscriptions,
  tickets,
  views,
  workspaceMembers,
  workspaces,
} from "./schema.ts";
import {
  fail,
  publishMany,
  requireRecentSignIn,
  requireRow,
  type Context,
  type Handlers,
} from "./domain.ts";
import type { Connection } from "./database.ts";
import { cancelImportsBy } from "./import-operations.ts";

// Account deletion keeps the `user` row as a tombstone: tickets, comments, evidence, claims, and
// events reference it, and its ID must never be reissued. Everything that identifies the person or
// lets anyone act as them goes, in the one transaction that also releases their claims.
type Blocker = AccountImpact["blockers"][number];
type Reader = Pick<Connection, "select" | "selectDistinct">;
const activeAdministrator = sql`NOT coalesce(${user.banned}, false) AND 'admin' = ANY(string_to_array(${user.role}, ','))`;

// Ownership never passes silently: the owner hands each workspace on first. Account disabling and
// deletion share this check.
export async function ownedWorkspaces(db: Reader, userId: string) {
  const rows = await db
    .select({ name: workspaces.name })
    .from(workspaces)
    .where(and(eq(workspaces.ownerId, userId), isNull(workspaces.deletedAt)))
    .orderBy(asc(workspaces.name));
  return rows.map((row) => row.name);
}
export const ownerBlocker = (names: string[]): Blocker[] =>
  names.length
    ? [
        {
          code: "workspace_owner",
          message: `Transfer ownership of ${names.join(", ")} before disabling or deleting this account`,
          tickets: [],
        },
      ]
    : [];
// Whether an active instance administrator other than `userId` remains.
export async function otherActiveAdministrator(db: Reader, userId: string) {
  return !!(
    await db
      .select({ id: user.id })
      .from(user)
      .where(and(ne(user.id, userId), activeAdministrator))
      .limit(1)
  ).length;
}
async function blockers(db: Reader, person: typeof user.$inferSelect): Promise<Blocker[]> {
  const found = ownerBlocker(await ownedWorkspaces(db, person.id));
  if (
    !person.banned &&
    hasAdminRole(person.role) &&
    !(await otherActiveAdministrator(db, person.id))
  )
    found.push({
      code: "last_administrator",
      message: "Make another account an instance administrator first",
      tickets: [],
    });
  // A workspace without an owner can still depend on this account as its only administrator.
  const sole = await db
    .select({ name: workspaces.name })
    .from(workspaceMembers)
    .innerJoin(workspaces, eq(workspaces.id, workspaceMembers.workspaceId))
    .where(
      and(
        eq(workspaceMembers.userId, person.id),
        eq(workspaceMembers.role, "admin"),
        isNull(workspaces.deletedAt),
        // The ownership blocker already names the workspaces it owns.
        sql`${workspaces.ownerId} IS DISTINCT FROM ${person.id}`,
        // Only an active administrator can still run the workspace.
        sql`NOT EXISTS (SELECT 1 FROM ${workspaceMembers} other JOIN ${user} u ON u.id = other.user_id WHERE other.workspace_id = ${workspaces.id} AND other.role = 'admin' AND other.user_id <> ${person.id} AND NOT coalesce(u.banned, false) AND u.deleted_at IS NULL)`,
      ),
    )
    .orderBy(asc(workspaces.name));
  if (sole.length)
    found.push({
      code: "last_administrator",
      message: `Add another administrator to ${sole.map((row) => row.name).join(", ")} first`,
      tickets: [],
    });
  return found;
}
// The account itself or an instance administrator; anyone else learns nothing about the ID.
async function subject(ctx: Context, userId: string, lock = false) {
  if (userId !== ctx.actor.id && !ctx.actor.admin)
    fail(403, "forbidden", "Only the account itself or an instance administrator can delete it");
  const query = ctx.db
    .select()
    .from(user)
    .where(and(eq(user.id, userId), isNull(user.deletedAt)));
  return requireRow((lock ? await query.for("update") : await query)[0]);
}
const total = async (rows: Promise<{ value: number }[]>) => (await rows)[0]?.value ?? 0;
async function impact(db: Reader, person: typeof user.$inferSelect): Promise<AccountImpact> {
  const id = person.id;
  const counted = (table: PgTable, where: SQL | undefined) =>
    total(db.select({ value: count() }).from(table).where(where));
  const [providers, sessions, keys, grants, devices, channels, spaces, direct] = await Promise.all([
    db.selectDistinct({ provider: account.providerId }).from(account).where(eq(account.userId, id)),
    total(
      db
        .select({ value: count() })
        .from(session)
        .where(and(eq(session.userId, id), gt(session.expiresAt, new Date()))),
    ),
    counted(apikey, eq(apikey.referenceId, id)),
    counted(oauthConsent, eq(oauthConsent.userId, id)),
    counted(pushDevices, eq(pushDevices.userId, id)),
    counted(notificationChannels, eq(notificationChannels.userId, id)),
    counted(workspaceMembers, eq(workspaceMembers.userId, id)),
    counted(members, eq(members.userId, id)),
  ]);
  const [held, running, authored, said, acted, found] = await Promise.all([
    counted(claims, eq(claims.actorId, id)),
    counted(
      importRuns,
      and(eq(importRuns.actorId, id), inArray(importRuns.status, ["previewed", "running"])),
    ),
    counted(tickets, eq(tickets.createdBy, id)),
    counted(comments, eq(comments.actorId, id)),
    counted(events, eq(events.actorId, id)),
    blockers(db, person),
  ]);
  return {
    userId: id,
    name: person.name,
    email: person.email,
    providers: providers.map((row) => row.provider).toSorted((a, b) => a.localeCompare(b)),
    sessions,
    credentials: keys + grants,
    devices: devices + channels,
    workspaces: spaces,
    projects: direct,
    claims: held,
    imports: running,
    tickets: authored,
    comments: said,
    events: acted,
    blockers: found,
  };
}

export const accountHandlers: Pick<
  Handlers,
  "list_deleted_accounts" | "get_account_impact" | "delete_account"
> = {
  async list_deleted_accounts(ctx) {
    // ponytail: every tombstone ID in one list; page it if an instance deletes thousands of accounts.
    const rows = await ctx.db
      .select({ id: user.id })
      .from(user)
      .where(isNotNull(user.deletedAt))
      .orderBy(asc(user.id));
    return rows.map((row) => row.id);
  },
  async get_account_impact(ctx, input) {
    return impact(ctx.db, await subject(ctx, input.userId));
  },
  // Runs under the domain write lock, which account administration also holds while it checks a
  // role or ban change, so the blockers checked here still hold when the deletion commits.
  async delete_account(ctx, input) {
    requireRecentSignIn(ctx.actor, "Sign in again to delete this account");
    // The acting account is read again inside the transaction: one deleted or disabled a moment
    // ago, or no longer an administrator, cannot finish a deletion it started earlier.
    const acting = (
      await ctx.db.select().from(user).where(eq(user.id, ctx.actor.id)).for("update")
    )[0];
    if (!acting || acting.banned || acting.deletedAt)
      fail(403, "account_disabled", "This account is disabled");
    const person = await subject(
      {
        ...ctx,
        actor: { ...ctx.actor, admin: hasAdminRole(acting.role) },
      },
      input.userId,
      true,
    );
    if (input.confirmEmail.toLowerCase() !== person.email.toLowerCase())
      fail(400, "validation_error", "Type the account's email to confirm deletion");
    const [blocker, ...rest] = await blockers(ctx.db, person);
    if (blocker) fail(409, blocker.code, blocker.message, { blockers: [blocker, ...rest] });
    const id = person.id;
    // Every project the account could see through a membership announces the change, so member
    // lists and pickers drop it; released claims appear in their tickets' activity.
    const reached = await ctx.db
      .selectDistinct({ id: projects.id, workspaceId: projects.workspaceId })
      .from(projects)
      .where(
        and(
          isNull(projects.deletedAt),
          or(
            inArray(
              projects.workspaceId,
              ctx.db
                .select({ id: workspaceMembers.workspaceId })
                .from(workspaceMembers)
                .where(eq(workspaceMembers.userId, id)),
            ),
            inArray(
              projects.id,
              ctx.db.select({ id: members.projectId }).from(members).where(eq(members.userId, id)),
            ),
          ),
        ),
      );
    const released = await ctx.db.delete(claims).where(eq(claims.actorId, id)).returning();
    await cancelImportsBy(ctx, id);
    // The OAuth (MCP) clients this account registered go with their tokens; the access and
    // refresh tokens and consents it granted to other clients go too.
    await ctx.db.delete(oauthClient).where(eq(oauthClient.userId, id));
    await ctx.db.delete(oauthAccessToken).where(eq(oauthAccessToken.userId, id));
    await ctx.db.delete(oauthRefreshToken).where(eq(oauthRefreshToken.userId, id));
    await ctx.db.delete(oauthConsent).where(eq(oauthConsent.userId, id));
    await ctx.db.delete(apikey).where(eq(apikey.referenceId, id));
    await ctx.db.delete(account).where(eq(account.userId, id));
    // Push devices hang off sessions and leave with them. Sessions the account opened while
    // impersonating someone else go too.
    await ctx.db.delete(pushDevices).where(eq(pushDevices.userId, id));
    await ctx.db.delete(session).where(or(eq(session.userId, id), eq(session.impersonatedBy, id)));
    await ctx.db.delete(notificationChannels).where(eq(notificationChannels.userId, id));
    await ctx.db.delete(notificationPreferences).where(eq(notificationPreferences.userId, id));
    await ctx.db.delete(notifications).where(eq(notifications.userId, id));
    await ctx.db.delete(subscriptions).where(eq(subscriptions.userId, id));
    await ctx.db.delete(eventAudiences).where(eq(eventAudiences.userId, id));
    await ctx.db.delete(views).where(eq(views.userId, id));
    await ctx.db.delete(calendarFeeds).where(eq(calendarFeeds.createdBy, id));
    // The orphaned image object is collected with other unreferenced blobs.
    await ctx.db.delete(profilePhotos).where(eq(profilePhotos.userId, id));
    await ctx.db.delete(members).where(eq(members.userId, id));
    await ctx.db.delete(workspaceMembers).where(eq(workspaceMembers.userId, id));
    // The `user_deleted_tombstone` constraint holds this shape for as long as `deletedAt` is set.
    await ctx.db
      .update(user)
      .set({
        name: deletedAccountName,
        email: `deleted+${id}@kanvil.invalid`,
        emailVerified: false,
        image: null,
        role: null,
        banned: true,
        banReason: "Account deleted",
        banExpires: null,
        deletedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(user.id, id));
    await publishMany(ctx, [
      ...released.map((claim) => ({
        type: "claim.released",
        ticketId: claim.ticketId,
        projectId: claim.projectId,
        data: { claimId: claim.id, reason: "account_deleted" },
      })),
      ...reached.map((row) => ({
        type: "membership.updated",
        ticketId: null,
        projectId: row.id,
        data: { workspaceId: row.workspaceId, userId: id, role: null, deleted: true },
      })),
    ]);
    return { ok: true };
  },
};
