import { writeLocalBlob, type BlobWriter } from "./blob-storage.ts";
import { builtinSearch, type TicketSearchProvider } from "./search.ts";
import { accessibleProjectRows } from "./project-access.ts";
import { and, asc, eq, gt, inArray, isNull, ne, or, sql, type SQLWrapper } from "drizzle-orm";
import {
  closedStates,
  defaultClaimMaxLeaseSeconds,
  eventCategories,
  ApiError,
  operations,
  parseOutput,
  type Operation,
  type ParsedInput,
  type Output,
  type Project,
  type Ticket,
  type Workspace,
  workspaceSchema,
  scopes,
  snapshotSchema,
  projectSchema,
  ticketSchema,
  hasAdminRole,
  operationPermission,
  permissionLabels,
  permissionScope,
  type Permission,
  type Role,
  type NotificationCategory,
  channelRouteAllows,
  destinationEventKeys,
  publicOperations,
  parsePublicOutput,
  type PublicOperation,
  type PublicOutput,
  type errorSchema,
} from "@kanvil/contracts";
import { z } from "zod";
import { createHash } from "node:crypto";
import { user } from "./auth-schema.ts";
import type { Sealer } from "./sealing.ts";
import type { ImportSources, MailMessage } from "./adapters/ports.ts";
import {
  claims,
  deliveries,
  eventAudiences,
  eventClock,
  events,
  notificationChannels,
  notifications,
  notificationPreferences,
  projectDestinations,
  projectPrefixes,
  pushDevices,
  projects,
  receipts,
  relations,
  subscriptions,
  ticketAliases,
  tickets,
} from "./schema.ts";
import { alias } from "drizzle-orm/pg-core";
import type { Connection, Database, Transaction } from "./database.ts";
import { projectAccess, readsProject } from "./project-access.ts";
import { workspaceHandlers, requireWorkspace, roleHandlers } from "./workspace-operations.ts";
import { projectHandlers } from "./project-operations.ts";
import { lifecycleHandlers } from "./project-lifecycle.ts";
import { labelHandlers } from "./label-operations.ts";
import { ticketHandlers } from "./ticket-operations.ts";
import { collaborationHandlers } from "./collaboration-operations.ts";
import { timeEntryHandlers } from "./time-entry-operations.ts";
import { deliveryHandlers } from "./delivery-operations.ts";
import { calendarHandlers } from "./calendar-operations.ts";
import { invitationHandlers } from "./invitation-operations.ts";
import { workflowHandlers } from "./workflow-operations.ts";
import { publicHandlers } from "./public-operations.ts";
import { customFieldHandlers } from "./custom-field-operations.ts";
import { repositoryHandlers } from "./repository-operations.ts";
import { importHandlers, sourceReads } from "./import-operations.ts";
import { issueSyncHandlers, queueIssueSync } from "./issue-sync.ts";
import { accountHandlers } from "./account-operations.ts";

export interface Actor {
  id: string;
  admin: boolean;
  machine: boolean;
  ownerId: string;
  scopes: readonly (typeof scopes)[number][];
  projectIds?: readonly string[];
  // When the session signed in; credentials have none. Destructive account-level writes need a
  // recent one.
  signedInAt?: Date;
}
// Deleting a workspace or an account asks for a sign-in this recent, so an unattended session
// cannot do it.
const recentSignIn = 15 * 60_000;
export function requireRecentSignIn(actor: Actor, message: string) {
  if (!actor.signedInAt || Date.now() - actor.signedInAt.getTime() > recentSignIn)
    fail(403, "reauthentication_required", message);
}
export interface Context {
  blobs: BlobWriter;
  search: TicketSearchProvider;
  // Seals delivery settings; the application supplies a key derived from the instance secret.
  secrets: Sealer;
  db: Connection | Transaction;
  actor: Actor;
  project: Project | null;
  workspace: Workspace | null;
  // The seeded stand-in of the caller's role here, and the actions that role grants, uncapped by
  // the credential: operations gate on both their scope and their action.
  role: Role;
  permissions: readonly Permission[];
  // The public origin for links in outgoing messages.
  publicUrl: string;
  // Queues an email to send after the write commits; absent without an SMTP relay.
  mail?: (message: MailMessage) => void;
  // The import run this write belongs to. Its events carry the provenance and notify no one.
  importRun?: string;
  // Trackers an import reads; see adapters/import-sources.ts.
  sources: ImportSources;
  claimMaxLeaseSeconds: number;
  // What a write read from another tracker before the write lock; see `sourceReads`.
  read?: unknown;
}
export type Handler<K extends Operation> = (
  ctx: Context,
  input: ParsedInput<K>,
) => Promise<unknown>;
export type Handlers = { [K in Operation]: Handler<K> };
export function fail(status: number, code: string, message: string, details?: unknown): never {
  throw new ApiError(status, code, message, details);
}
// The one error envelope HTTP responses and MCP tool results carry. Anything that is not an
// API or validation error stays internal: only its name is logged, never its message.
export function errorEnvelope(error: unknown): {
  status: number;
  body: z.infer<typeof errorSchema>;
} {
  if (error instanceof ApiError)
    return {
      status: error.status,
      body: {
        error: {
          status: error.status,
          code: error.code,
          message: error.message,
          details: error.details,
        },
      },
    };
  if (error instanceof z.ZodError)
    return {
      status: 400,
      body: {
        error: {
          code: "validation_error",
          message: "Invalid request",
          details: error.issues.map((issue) => ({
            path: issue.path.join("."),
            message: issue.message,
          })),
        },
      },
    };
  console.error("Kanvil request failed", {
    name: error instanceof Error ? error.name : typeof error,
  });
  return {
    status: 500,
    body: { error: { code: "internal_error", message: "The request could not be completed" } },
  };
}
export function requireRow<T>(row: T | undefined): T {
  if (!row) fail(404, "not_found", "The requested record was not found");
  return row;
}
// The first row of a query that must exist; most reads and all `returning()` writes use it.
export const one = <T>(rows: readonly T[]): T => requireRow(rows[0]);
// Every optimistic-concurrency check reports the same code and carries the current version.
export function assertVersion(
  current: { version: number },
  expected: number,
  subject: string,
  action = "editing",
) {
  if (current.version !== expected)
    fail(409, "version_conflict", `The ${subject} changed; reload before ${action}`, {
      currentVersion: current.version,
    });
}
// Database rows carry Date columns; the contracts expect ISO strings.
export function toProject(row: typeof projects.$inferSelect): Project {
  return projectSchema.parse({
    ...row,
    archivedAt: row.archivedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  });
}
export async function accountByEmail(db: Context["db"], email: string) {
  const found = (
    await db
      .select()
      .from(user)
      .where(and(eq(user.email, email.toLowerCase()), isNull(user.deletedAt)))
      .limit(1)
  )[0];
  if (!found)
    fail(
      404,
      "account_not_found",
      "No account uses this email. Ask an instance administrator to create one.",
    );
  return found;
}
export function workspace(ctx: Context): Workspace {
  return requireRow(ctx.workspace ?? undefined);
}
export function project(ctx: Context): Project {
  return requireRow(ctx.project ?? undefined);
}
export function json(value: unknown): unknown {
  return JSON.parse(
    JSON.stringify(value, (_, item: unknown) =>
      typeof item === "bigint" ? item.toString() : item,
    ),
  );
}
export const complete = (status: string) => closedStates.some((closed) => closed === status);
export const intakeHoldReason = "Untrusted intake: human triage required";
// Only a trusted writer can clear the hold that intake creation forces.
export const intakeQuarantined = (ticket: Pick<Ticket, "holdReason">) =>
  ticket.holdReason === intakeHoldReason;
export const intakeOnly = (actor: Actor) =>
  actor.scopes.length > 0 && actor.scopes.every((scope) => scope === "intake");
export const hasScope = (actor: Actor, scope: (typeof scopes)[number], operation?: Operation) =>
  intakeOnly(actor)
    ? operation === "create_ticket"
    : actor.scopes.includes("admin") ||
      actor.scopes.includes(scope) ||
      (scope === "read" && actor.scopes.some((value) => value !== "intake"));
function requireScope(actor: Actor, scope: (typeof scopes)[number], operation?: Operation) {
  if (!hasScope(actor, scope, operation))
    fail(403, "insufficient_scope", `This credential requires ${scope} permission`);
}
// The actions a role grants that the credential's scopes also allow: what clients are told the
// caller can do, and the most the caller can grant to anyone else.
export const capabilities = (actor: Actor, granted: readonly Permission[]) =>
  granted.filter((permission) => hasScope(actor, permissionScope(permission)));
// What a handler may do beyond the operation's own action: the role's grant within the credential.
export const can = (ctx: Context, permission: Permission) =>
  capabilities(ctx.actor, ctx.permissions).includes(permission);
// The stable codes and messages predate custom roles; the writer's and administrator's actions
// keep them.
export function requirePermission(
  granted: readonly Permission[],
  permission: Permission | null,
  where: "project" | "workspace",
) {
  if (!permission || granted.includes(permission)) return;
  if (permission === "ticket.write")
    fail(
      403,
      "forbidden",
      `${where === "project" ? "Project" : "Workspace"} write permission is required`,
    );
  if (where === "workspace")
    fail(
      403,
      "workspace_access_required",
      `${permissionLabels[permission].label} permission is required in this workspace`,
    );
  fail(
    403,
    "forbidden",
    permission === "project.manage"
      ? "Project administration permission is required"
      : `${permissionLabels[permission].label} permission is required`,
  );
}
// No one grants an action they do not hold themselves, through a role definition or an assignment.
// The seeded Admin role also reaches private projects and ownership, which only an administrator
// holds, so only an administrator assigns it.
export function assertGrantable(ctx: Context, granted: readonly Permission[], role?: string) {
  if (role === "admin" && ctx.role !== "admin")
    fail(403, "forbidden", "Only an administrator can grant or change the Admin role");
  const held = capabilities(ctx.actor, ctx.permissions);
  const beyond = granted.filter((permission) => !held.includes(permission));
  if (beyond.length)
    fail(403, "forbidden", "You can only grant actions your own role allows", {
      permissions: beyond,
    });
}

const noSecrets: Sealer = {
  seal: () => fail(503, "delivery_unavailable", "Outbound delivery is not configured"),
  unseal: () => fail(503, "delivery_unavailable", "Outbound delivery is not configured"),
};
const noSources: ImportSources = {
  projects: () => fail(503, "source_unavailable", "Import sources are not configured"),
  bundle: () => fail(503, "source_unavailable", "Import sources are not configured"),
};
const baseContext = (db: Context["db"], actor: Actor): Context => ({
  db,
  actor,
  project: null,
  workspace: null,
  role: "reader",
  permissions: [],
  blobs: { put: writeLocalBlob },
  search: builtinSearch,
  secrets: noSecrets,
  publicUrl: "http://localhost",
  sources: noSources,
  claimMaxLeaseSeconds: defaultClaimMaxLeaseSeconds,
});
// Public reads hold no identity, scope, or project grant: nothing they reach can authorize by actor.
const publicActor: Actor = {
  id: "",
  admin: false,
  machine: false,
  ownerId: "",
  scopes: [],
  projectIds: [],
};
// The one resolver for project and ticket identifiers: an ID, the current key, or any key issued
// before a prefix change or a move. It only names rows; every caller still applies its own access
// check, so an alias reaches nothing the ID would not.
export const projectMatch = (identifier: string) =>
  or(
    sql`${projects.id}::text = ${identifier}`,
    eq(projects.key, identifier.toUpperCase()),
    sql`${projects.id} IN (SELECT pp.project_id FROM ${projectPrefixes} pp WHERE pp.prefix = ${identifier.toUpperCase()})`,
  );
const issuedKey = /^([A-Z][A-Z0-9]{1,9})-([1-9]\d{0,8})$/;
export function ticketMatch(identifier: string) {
  const key = identifier.toUpperCase(),
    [, prefix, number] = issuedKey.exec(key) ?? [];
  return or(
    sql`${tickets.id}::text = ${identifier}`,
    eq(tickets.key, key),
    sql`${tickets.id} IN (SELECT ta.ticket_id FROM ${ticketAliases} ta WHERE ta.key = ${key})`,
    prefix && number
      ? and(
          eq(tickets.number, Number(number)),
          sql`${tickets.projectId} IN (SELECT pp.project_id FROM ${projectPrefixes} pp WHERE pp.prefix = ${prefix})`,
        )
      : undefined,
  );
}
// Every operation resolves the caller's current role here, in the workspace or project it names,
// and needs both the operation's scope from the credential and its action from the role.
export async function context(
  db: Context["db"],
  actor: Actor,
  scope: (typeof scopes)[number],
  projectId?: string,
  workspaceId?: string,
  permission: Permission | null = scope === "read"
    ? null
    : scope === "admin"
      ? "project.manage"
      : "ticket.write",
  operation?: Operation,
): Promise<Context> {
  requireScope(actor, scope, operation);
  const ctx = baseContext(db, actor);
  if (workspaceId) {
    const access = await requireWorkspace(ctx, workspaceId, permission);
    ctx.workspace = access.workspace;
    ctx.role = access.role;
    ctx.permissions = access.permissions;
  }
  if (!projectId) return ctx;
  const row = one(
    await db
      .select()
      .from(projects)
      .where(and(isNull(projects.deletedAt), projectMatch(projectId)))
      .limit(1),
  );
  if (actor.projectIds && !actor.projectIds.includes(row.id))
    fail(404, "not_found", "Project was not found");
  const access = await projectAccess(db, actor, row);
  if (!access) fail(404, "not_found", "Project was not found");
  requirePermission(access.permissions, permission, "project");
  return { ...ctx, project: toProject(row), role: access.role, permissions: access.permissions };
}
export async function getTicket(ctx: Context, identifier: string) {
  return one(
    await ctx.db
      .select()
      .from(tickets)
      .where(and(eq(tickets.projectId, project(ctx).id), ticketMatch(identifier)))
      .limit(1),
  );
}
export type PendingEvent = {
  type: string;
  ticketId: string | null;
  data: Record<string, unknown>;
  // Defaults to the context project; set it to fan one event out to several projects.
  projectId?: string;
};
// PostgreSQL binds at most 65535 parameters per statement; keep multi-row inserts well under it.
const insertBatch = 1000;
export async function insertAll<T, R>(
  rows: T[],
  insert: (batch: T[]) => Promise<R[]>,
): Promise<R[]> {
  const out: R[] = [];
  for (let at = 0; at < rows.length; at += insertBatch)
    out.push(...(await insert(rows.slice(at, at + insertBatch))));
  return out;
}
// Follows a ticket for each user once; duplicates are ignored.
export async function subscribe(
  ctx: Context,
  projectId: string,
  ticketId: string,
  userIds: readonly (string | null | undefined)[],
) {
  const ids = [...new Set(userIds.filter((id): id is string => !!id))];
  if (ids.length)
    await ctx.db
      .insert(subscriptions)
      .values(ids.map((userId) => ({ projectId, ticketId, userId })))
      .onConflictDoNothing();
}
type NewEvent = Omit<typeof events.$inferInsert, "id" | "createdAt">;
// Appends events with consecutive ids from the replay clock and wakes realtime readers on commit.
export async function appendEvents(db: Context["db"], pending: NewEvent[]) {
  const clock = one(
    await db
      .update(eventClock)
      .set({ value: sql`${eventClock.value} + ${pending.length}` })
      .where(eq(eventClock.id, 1))
      .returning(),
  );
  const first = clock.value - BigInt(pending.length) + 1n;
  const rows = await insertAll(
    pending.map((item, index) => ({ ...item, id: first + BigInt(index) })),
    (batch) => db.insert(events).values(batch).returning(),
  );
  await db.execute(sql`SELECT pg_notify('kanvil_events', ${clock.value.toString()})`);
  await queueDestinations(db, rows);
  await queueIssueSync(db, rows);
  return rows;
}
// Queues each ticket event for the project's active destinations that carry its kind of activity.
// Imported records are history arriving, not activity, so they reach no destination.
async function queueDestinations(db: Context["db"], rows: (typeof events.$inferSelect)[]) {
  // A move-away names no ticket, so the source keeps no link to it, yet it is ticket activity.
  const ticketEvents = rows.filter(
    (event) => (event.ticketId || event.type === "ticket.moved_away") && !event.data.import,
  );
  if (!ticketEvents.length) return;
  const targets = await db
    .select({
      id: projectDestinations.id,
      projectId: projectDestinations.projectId,
      events: projectDestinations.events,
    })
    .from(projectDestinations)
    .where(
      and(
        inArray(projectDestinations.projectId, [...new Set(ticketEvents.map((e) => e.projectId))]),
        eq(projectDestinations.paused, false),
      ),
    );
  const queued = ticketEvents.flatMap((event) => {
    const keys = destinationEventKeys(event);
    return targets
      .filter((target) => target.projectId === event.projectId)
      .filter((target) => keys.some((key) => target.events.includes(key)))
      .map((target) => ({ eventId: event.id, destinationId: target.id }));
  });
  await insertAll(queued, (batch) =>
    db.insert(deliveries).values(batch).onConflictDoNothing().returning(),
  );
}
// The preference columns `notify` needs, selected alongside a user joined as a recipient.
export const recipientColumns = {
  userId: user.id,
  inApp: notificationPreferences.inApp,
  push: notificationPreferences.push,
  categories: notificationPreferences.categories,
};
export type Recipient = {
  userId: string;
  inApp: boolean | null;
  push: boolean | null;
  categories: Record<string, boolean> | null;
};
// A joined user who can still read the project, is active, and has a delivery channel on.
export const reachable = (projectId: SQLWrapper) =>
  and(
    readsProject(projectId),
    or(
      sql`coalesce(${notificationPreferences.inApp}, true)`,
      eq(notificationPreferences.push, true),
      sql`exists (select 1 from ${notificationChannels} where ${notificationChannels.userId} = ${user.id} and not ${notificationChannels.paused})`,
    ),
  );
// Records each (event, recipient) once under its first enabled category and queues delivery to the
// recipient's push devices and to their active channels whose routes include the project.
// `categories` replaces the event's own categories for one recipient, as a mention does.
export async function notify(
  db: Context["db"],
  pending: {
    event: typeof events.$inferSelect;
    recipient: Recipient;
    reminderKey?: string;
    categories?: NotificationCategory[];
  }[],
) {
  const entries = pending.flatMap(({ event, recipient, reminderKey, categories }) => {
    const category = (categories ?? eventCategories(event)).find(
      (name) => recipient.categories?.[name] !== false,
    );
    return category ? [{ event, recipient, category, reminderKey }] : [];
  });
  if (!entries.length) return;
  const created = await insertAll(
    entries.map(({ event, recipient, category, reminderKey }) => ({
      userId: recipient.userId,
      projectId: event.projectId,
      eventId: event.id,
      category,
      reminderKey,
      inbox: recipient.inApp ?? true,
    })),
    (batch) => db.insert(notifications).values(batch).onConflictDoNothing().returning(),
  );
  if (!created.length) return;
  const userIds = [...new Set(created.map((row) => row.userId))];
  // Push is decided per (event, user), matched by key rather than by insert order.
  const pushing = new Set(
    entries
      .filter(({ recipient }) => recipient.push)
      .map(({ event, recipient }) => `${event.id}:${recipient.userId}`),
  );
  const devices = pushing.size
    ? await db
        .select({ id: pushDevices.id, userId: pushDevices.userId })
        .from(pushDevices)
        .where(inArray(pushDevices.userId, userIds))
    : [];
  const channels = await db
    .select({
      id: notificationChannels.id,
      userId: notificationChannels.userId,
      routes: notificationChannels.routes,
    })
    .from(notificationChannels)
    .where(
      and(inArray(notificationChannels.userId, userIds), eq(notificationChannels.paused, false)),
    );
  const workspaceOf = new Map(
    channels.length
      ? (
          await db
            .select({ id: projects.id, workspaceId: projects.workspaceId })
            .from(projects)
            .where(inArray(projects.id, [...new Set(created.map((row) => row.projectId))]))
        ).map((row) => [row.id, row.workspaceId])
      : [],
  );
  const queued = created.flatMap((notification) => [
    ...(pushing.has(`${notification.eventId}:${notification.userId}`)
      ? devices
          .filter((device) => device.userId === notification.userId)
          .map((device) => ({ notificationId: notification.id, deviceId: device.id }))
      : []),
    ...channels
      .filter(
        (channel) =>
          channel.userId === notification.userId &&
          channelRouteAllows(
            channel.routes,
            workspaceOf.get(notification.projectId),
            notification.projectId,
          ),
      )
      .map((channel) => ({ notificationId: notification.id, channelId: channel.id })),
  ]);
  await insertAll(queued, (batch) => db.insert(deliveries).values(batch).returning());
}
// Writes a batch of events with consecutive ids and one notification fan-out; bulk edits stay cheap.
// `notifyFollowers: false` records the events without notifying anyone, as deleting a project does,
// and so does every write of an import run, whose events name the run.
export async function publishMany(ctx: Context, pending: PendingEvent[], notifyFollowers = true) {
  if (!pending.length) return [];
  const ticketIds = [...new Set(pending.flatMap((item) => (item.ticketId ? [item.ticketId] : [])))];
  const titles = new Map(
    ticketIds.length
      ? (
          await ctx.db
            .select({ id: tickets.id, key: tickets.key, title: tickets.title })
            .from(tickets)
            .where(inArray(tickets.id, ticketIds))
        ).map((row) => [row.id, { key: row.key, title: row.title }])
      : [],
  );
  const source = { kind: ctx.actor.machine ? "credential" : "session", id: ctx.actor.ownerId };
  const rows = await appendEvents(
    ctx.db,
    pending.map((item) => ({
      projectId: item.projectId ?? project(ctx).id,
      ticketId: item.ticketId,
      actorId: ctx.actor.id,
      type: item.type,
      data: {
        ...item.data,
        ...(item.ticketId ? titles.get(item.ticketId) : {}),
        source,
        ...(ctx.importRun ? { import: { runId: ctx.importRun } } : {}),
      },
    })),
  );
  if (ticketIds.length && notifyFollowers && !ctx.importRun) {
    // A person never notifies themselves; an agent's actions still reach its owner.
    const others = ctx.actor.machine ? undefined : ne(user.id, ctx.actor.id);
    const followers = await ctx.db
      .select({ ticketId: subscriptions.ticketId, ...recipientColumns })
      .from(subscriptions)
      .innerJoin(user, eq(user.id, subscriptions.userId))
      .leftJoin(notificationPreferences, eq(notificationPreferences.userId, subscriptions.userId))
      .where(
        and(inArray(subscriptions.ticketId, ticketIds), reachable(subscriptions.projectId), others),
      );
    // Mentioned users who can read the project are recipients too, following or not. The IDs come
    // from the comment text, so only the server-side reachability check grants anything.
    const mentioned = await Promise.all(
      rows.map(async (event) => {
        const ids = mentionsOf(event);
        return ids.length
          ? ctx.db
              .select(recipientColumns)
              .from(user)
              .leftJoin(notificationPreferences, eq(notificationPreferences.userId, user.id))
              .where(and(inArray(user.id, ids), reachable(sql`${event.projectId}::uuid`), others))
          : [];
      }),
    );
    await notify(
      ctx.db,
      rows.flatMap((event, index) => {
        const following = followers.filter((follower) => follower.ticketId === event.ticketId),
          follows = new Set(following.map((follower) => follower.userId));
        return [
          ...following.map((recipient) => ({
            event,
            recipient,
            ...(mentionsOf(event).includes(recipient.userId)
              ? { categories: ["mention" as const, ...eventCategories(event)] }
              : {}),
          })),
          ...(mentioned[index] ?? [])
            .filter((recipient) => !follows.has(recipient.userId))
            .map((recipient) => ({ event, recipient, categories: ["mention" as const] })),
        ];
      }),
    );
  }
  return rows;
}
const mentionsOf = (event: { data: Record<string, unknown> }) =>
  Array.isArray(event.data.mentions)
    ? event.data.mentions.filter((id): id is string => typeof id === "string")
    : [];
export async function publish(
  ctx: Context,
  type: string,
  ticketId: string | null,
  data: Record<string, unknown>,
) {
  return one(await publishMany(ctx, [{ type, ticketId, data }]));
}
// A relationship change appears in both tickets' activity, each in its own project's feed.
export const relationEvents = (
  type: "relation.added" | "relation.removed",
  relation: { sourceId: string; targetId: string },
  sides: readonly { id: string; projectId: string }[],
): PendingEvent[] =>
  [relation.sourceId, relation.targetId].map((ticketId) => ({
    type,
    ticketId,
    data: { relation },
    projectId: requireRow(sides.find((side) => side.id === ticketId)).projectId,
  }));
const deletedSide = alias(tickets, "deleted_side"),
  survivingSide = alias(tickets, "surviving_side");
// Deleting tickets of this project, the listed ones or all of them, cascades their relationships.
// Each surviving ticket in another project hears that its edge went, in its own project's feed.
export async function severedRelationEvents(
  ctx: Context,
  ticketIds?: readonly string[],
): Promise<PendingEvent[]> {
  const rows = await ctx.db
    .select({
      relation: relations,
      ticketId: survivingSide.id,
      projectId: survivingSide.projectId,
    })
    .from(relations)
    .innerJoin(
      deletedSide,
      or(eq(deletedSide.id, relations.sourceId), eq(deletedSide.id, relations.targetId)),
    )
    .innerJoin(
      survivingSide,
      or(eq(survivingSide.id, relations.sourceId), eq(survivingSide.id, relations.targetId)),
    )
    .where(
      and(
        ticketIds
          ? inArray(deletedSide.id, [...ticketIds])
          : eq(deletedSide.projectId, project(ctx).id),
        ne(survivingSide.projectId, project(ctx).id),
      ),
    );
  return rows.map(({ relation, ticketId, projectId }) => ({
    type: "relation.removed",
    ticketId,
    projectId,
    data: { relation },
  }));
}
export function ownsLiveClaim(ctx: Context, claim: typeof claims.$inferSelect) {
  return (
    claim.ownerId === ctx.actor.ownerId &&
    claim.expiresAt > new Date() &&
    hasScope(ctx.actor, "claim") &&
    ctx.permissions.includes("ticket.write")
  );
}
export async function assertWorkerClaim(
  ctx: Context,
  ticket: typeof tickets.$inferSelect,
  claimId?: string,
) {
  if (!ctx.actor.machine) return;
  const claim = (
    await ctx.db.select().from(claims).where(eq(claims.ticketId, ticket.id)).limit(1)
  )[0];
  if (claim && (claim.id !== claimId || !ownsLiveClaim(ctx, claim)))
    fail(409, "claim_conflict", "An active matching claim is required for this worker write");
  if (!claim && (claimId || ticket.claimRequired))
    fail(409, "claim_conflict", "This ticket requires current ownership for worker writes");
}
// Workflow and custom-field definition changes rewrite their tickets as project administration.
// A recorded ownership requirement without a claim does not stop them; any claim, live or expired
// and whoever holds it, does, since the change can alter status or field meaning under its worker.
export async function assertDefinitionMigration(ctx: Context, affected: readonly { id: string }[]) {
  if (!can(ctx, "project.manage"))
    fail(403, "forbidden", "Project administration permission is required");
  if (!ctx.actor.machine || !affected.length) return;
  const claimed = await ctx.db
    .select({ id: claims.id })
    .from(claims)
    .where(
      inArray(
        claims.ticketId,
        affected.map((ticket) => ticket.id),
      ),
    )
    .limit(1);
  if (claimed.length) fail(409, "claim_conflict", "A claimed ticket blocks this definition change");
}

export function createDomain(
  database: Database,
  services: {
    blobs?: BlobWriter;
    search?: TicketSearchProvider;
    secrets?: Sealer;
    publicUrl?: string;
    mail?: ((message: MailMessage) => Promise<void>) | undefined;
    sources?: ImportSources;
    claimMaxLeaseSeconds?: number;
  } = {},
) {
  const handlers: Handlers = {
    ...workspaceHandlers,
    ...roleHandlers,
    ...projectHandlers,
    ...lifecycleHandlers,
    ...labelHandlers,
    ...ticketHandlers,
    ...collaborationHandlers,
    ...timeEntryHandlers,
    ...deliveryHandlers,
    ...calendarHandlers,
    ...invitationHandlers,
    ...workflowHandlers,
    ...customFieldHandlers,
    ...repositoryHandlers,
    ...importHandlers,
    ...issueSyncHandlers,
    ...accountHandlers,
  };
  // The writes an archived project still accepts: its lifecycle, details, order, and access, and
  // removing what reaches outside it. Everything else waits for a restore.
  const whileArchived: ReadonlySet<Operation> = new Set([
    "archive_project",
    "transfer_project",
    "delete_project",
    "update_project",
    "set_project_icon",
    "set_project_background",
    "move_project",
    "set_member",
    "revoke_calendar_feed",
    "delete_project_destination",
    "delete_repository_connection",
  ]);
  // Operations that act for the person signed in, never for a credential. An import run writes as
  // the person who started it, long after the request.
  const sessionOnly: ReadonlySet<Operation> = new Set([
    "get_invitation",
    "accept_invitation",
    "delete_workspace",
    "preview_import",
    "list_import_source_projects",
    "preview_source_import",
    "list_imports",
    "get_import",
    "start_import",
    "cancel_import",
    "get_account_impact",
    "delete_account",
  ]);
  // Operations where `workspaceId` narrows a listing instead of naming a membership context.
  const workspaceIsFilter: ReadonlySet<Operation> = new Set([
    "list_projects",
    "list_my_work",
    "search_tickets",
    "search_workspace",
  ]);
  // Reads another tracker and writes nothing here, so it runs outside the write lock like a read
  // and a slow source holds up no one.
  const remoteReads: ReadonlySet<Operation> = new Set(["list_import_source_projects"]);
  const withServices = (ctx: Context) => {
    if (services.blobs) ctx.blobs = services.blobs;
    if (services.search) ctx.search = services.search;
    if (services.secrets) ctx.secrets = services.secrets;
    if (services.publicUrl) ctx.publicUrl = services.publicUrl;
    if (services.sources) ctx.sources = services.sources;
    if (services.claimMaxLeaseSeconds !== undefined)
      ctx.claimMaxLeaseSeconds = services.claimMaxLeaseSeconds;
    return ctx;
  };
  // Serializing writes is deliberate for a small self-hosted install: it also gives replay cursors commit order.
  const locked = <T>(run: (tx: Transaction) => Promise<T>) =>
    database.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(7361080)`);
      return run(tx);
    });
  // A locked write that arrives outside the operation registry, such as a signed repository
  // webhook. `as` gives an actor the same write context and project checks an operation gets.
  const transact = <T>(
    run: (tx: Transaction, as: (actor: Actor, projectId: string) => Promise<Context>) => Promise<T>,
  ) =>
    locked((tx) =>
      run(tx, async (actor, projectId) => {
        const ctx = await context(tx, actor, "write", projectId);
        if (ctx.project?.archivedAt)
          fail(409, "project_archived", "Restore this archived project before changing it");
        return withServices(ctx);
      }),
    );
  // `provenance` marks the writes of an import run; see import-operations.ts.
  async function execute<K extends Operation>(
    name: K,
    value: unknown,
    actor: Actor,
    provenance?: { importRun: string },
  ): Promise<Output<K>> {
    const spec = operations[name];
    const input = spec.input.parse(value);
    const projectId = "projectId" in input ? input.projectId : undefined;
    const workspaceId =
      "workspaceId" in input && !workspaceIsFilter.has(name) ? input.workspaceId : undefined;
    if (intakeOnly(actor)) requireScope(actor, spec.scope, name);
    // Check the session-only gate before operation scopes for every machine identity.
    if (actor.machine && sessionOnly.has(name))
      fail(403, "session_required", "Use a signed-in account for this action");
    if (actor.projectIds && spec.method !== "GET" && !projectId)
      fail(
        403,
        "insufficient_scope",
        "Project-bound credentials can only change their configured projects",
      );
    const outgoing: MailMessage[] = [];
    // What a write read from another tracker before the lock.
    let read: unknown;
    const invoke = async (ctx: Context) => {
      withServices(ctx);
      if (services.mail) ctx.mail = (message) => outgoing.push(message);
      if (provenance) ctx.importRun = provenance.importRun;
      if (read !== undefined) ctx.read = read;
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- The operation registry and mapped handler type enforce the same key/input pairing.
      const handler = handlers[name] as (ctx: Context, payload: typeof input) => Promise<unknown>;
      return parseOutput(name, json(await handler(ctx, input)));
    };
    const permission = operationPermission(name);
    if (spec.method === "GET" || remoteReads.has(name))
      return invoke(
        await context(database.db, actor, spec.scope, projectId, workspaceId, permission, name),
      );
    const requestId = "requestId" in input ? input.requestId : undefined;
    // A write that reads another tracker reads it first, outside the lock, unless a receipt
    // already answers the request; it then commits like any other write.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- `sourceReads` pairs each operation with its own input, as the handler map does.
    const reader = sourceReads[name] as
      | {
          read: (ctx: Context, payload: typeof input) => Promise<unknown>;
          receipt: (payload: typeof input) => unknown;
        }
      | undefined;
    if (
      reader &&
      !(
        requestId &&
        (
          await database.db
            .select({ id: receipts.requestId })
            .from(receipts)
            .where(and(eq(receipts.actorId, actor.id), eq(receipts.requestId, requestId)))
            .limit(1)
        ).length
      )
    )
      read = await reader.read(
        withServices(
          await context(database.db, actor, spec.scope, projectId, workspaceId, permission, name),
        ),
        input,
      );
    const committed = await locked(async (tx) => {
      const hash = createHash("sha256")
        .update(
          JSON.stringify({
            name,
            input: reader ? reader.receipt(input) : input,
            ...(intakeOnly(actor) && { intakeCredential: actor.ownerId }),
          }),
        )
        .digest("hex");
      const receipt = requestId
        ? (
            await tx
              .select()
              .from(receipts)
              .where(and(eq(receipts.actorId, actor.id), eq(receipts.requestId, requestId)))
              .limit(1)
          )[0]
        : undefined;
      if (receipt && (receipt.hash !== hash || receipt.operation !== name))
        fail(409, "idempotency_conflict", "This requestId was already used for another write");
      // A deleted project or workspace authorizes no one, so a retried deletion replays its
      // author's receipt.
      if (receipt && (name === "delete_project" || name === "delete_workspace"))
        return parseOutput(name, receipt.result);
      const ctx = await context(tx, actor, spec.scope, projectId, workspaceId, permission, name);
      if (receipt) {
        // Time-entry receipts must not disclose a moved or deleted ticket through its old project.
        if (
          (name === "create_time_entry" ||
            name === "update_time_entry" ||
            name === "delete_time_entry") &&
          "ticketId" in input
        )
          await getTicket(ctx, input.ticketId);
        const prior = parseOutput(name, receipt.result);
        // Creation has no input subject ID, so its stored result must also be authorized on replay.
        if (name === "create_project")
          await context(tx, actor, "read", projectSchema.parse(prior).id);
        if (name === "create_workspace")
          await requireWorkspace(ctx, workspaceSchema.parse(prior).id, null);
        // A move answered from the destination; the caller must still be able to write there.
        if (name === "relocate_ticket")
          await context(tx, actor, "write", ticketSchema.parse(prior).projectId);
        return prior;
      }
      if (ctx.project?.archivedAt && !whileArchived.has(name))
        fail(409, "project_archived", "Restore this archived project before changing it");
      const result = await invoke(ctx);
      if (requestId)
        await tx
          .insert(receipts)
          .values({ actorId: actor.id, requestId, hash, operation: name, result });
      return result;
    });
    // ponytail: mail sends once after commit and a failure is only logged; the sender still has
    // the link to share or resend. Route it through the outbox if invitations need retries.
    for (const message of outgoing)
      await services.mail?.(message).catch(() => console.error("Kanvil email failed"));
    return committed;
  }
  async function resolveActor(
    id: string,
    credential?: {
      ownerId: string;
      scopes: readonly (typeof scopes)[number][];
      projectIds?: readonly string[];
    },
    signedInAt?: Date,
  ): Promise<Actor> {
    const row = one(await database.db.select().from(user).where(eq(user.id, id)).limit(1));
    if (row.banned) fail(403, "account_disabled", "This account is disabled");
    return {
      id,
      admin: hasAdminRole(row.role),
      machine: !!credential,
      ownerId: credential?.ownerId ?? id,
      scopes: credential?.scopes ?? scopes,
      ...(credential?.projectIds ? { projectIds: credential.projectIds } : {}),
      ...(signedInAt && !credential ? { signedInAt } : {}),
    };
  }
  // Realtime and routes need the rows only; `list_projects` adds counts that would run per wake-up.
  async function accessibleProjects(identity: Actor) {
    return accessibleProjectRows(database.db, identity);
  }
  async function readEvents(identity: Actor, cursor: bigint, projectId?: string) {
    if (!hasScope(identity, "read")) fail(403, "insufficient_scope", "Read permission is required");
    const allowed = await accessibleProjects(identity),
      named = projectId
        ? await database.db
            .select({ id: projects.id })
            .from(projects)
            .where(projectMatch(projectId))
        : [];
    const ids = allowed
      .filter((row) => !projectId || named.some((match) => match.id === row.id))
      .map((row) => row.id);
    if (projectId && !ids.length) fail(404, "not_found", "Project was not found");
    const clock = one(await database.db.select().from(eventClock).where(eq(eventClock.id, 1)));
    if (cursor < clock.floor || cursor > clock.value)
      fail(410, "snapshot_required", "Fetch a fresh snapshot before reconnecting", {
        cursor: clock.value.toString(),
      });
    // People a deletion or move cut off still receive the event that did it, so their clients drop
    // what they cached. The audience was recorded with the event; instance administrators read all.
    const farewell = projectId
      ? undefined
      : and(
          inArray(events.type, ["project.deleted", "project.transferred"]),
          identity.projectIds ? inArray(events.projectId, [...identity.projectIds]) : undefined,
          identity.admin
            ? undefined
            : inArray(
                events.id,
                database.db
                  .select({ id: eventAudiences.eventId })
                  .from(eventAudiences)
                  .where(eq(eventAudiences.userId, identity.id)),
              ),
        );
    const rows =
      ids.length || farewell
        ? await database.db
            .select()
            .from(events)
            .where(
              and(
                or(ids.length ? inArray(events.projectId, ids) : undefined, farewell),
                gt(events.id, cursor),
              ),
            )
            .orderBy(asc(events.id))
            .limit(200)
        : [];
    const last = rows.at(-1)?.id ?? cursor;
    return { items: rows, cursor: rows.length === 200 || last > clock.value ? last : clock.value };
  }
  async function snapshot(identity: Actor, identifier: string) {
    return database.db.transaction(
      async (tx) => {
        const ctx = await context(tx, identity, "read", identifier);
        const clock = one(await tx.select().from(eventClock).where(eq(eventClock.id, 1)));
        const rows = await tx
          .select()
          .from(tickets)
          .where(eq(tickets.projectId, project(ctx).id))
          .orderBy(asc(tickets.number));
        return snapshotSchema.parse(
          json({ project: project(ctx), tickets: rows, cursor: clock.value.toString() }),
        );
      },
      { isolationLevel: "repeatable read", accessMode: "read only" },
    );
  }
  // Anonymous reads of a shared project. The sharing policy and every row come from one read-only
  // snapshot, so a concurrent revocation is seen entirely or not at all; an unknown, unshared, or
  // revoked project reads as not found.
  async function readPublic<K extends PublicOperation>(
    name: K,
    value: unknown,
  ): Promise<PublicOutput<K>> {
    const input = publicOperations[name].input.parse(value);
    return database.db.transaction(
      async (tx) => {
        const row = (
          await tx
            .select()
            .from(projects)
            .where(
              and(
                eq(projects.id, input.projectId),
                eq(projects.publicReadEnabled, true),
                // Archiving pauses a public link like a calendar feed; deletion ends it.
                isNull(projects.archivedAt),
                isNull(projects.deletedAt),
              ),
            )
        )[0];
        if (!row) fail(404, "not_found", "Project was not found");
        const ctx: Context = { ...baseContext(tx, publicActor), project: toProject(row) };
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- The public registry and mapped handler type enforce the same key/input pairing.
        const handler = publicHandlers[name] as (
          ctx: Context,
          payload: typeof input,
        ) => Promise<unknown>;
        return parsePublicOutput(name, json(await handler(ctx, input)));
      },
      { isolationLevel: "repeatable read", accessMode: "read only" },
    );
  }
  return {
    execute,
    transact,
    readPublic,
    actor: resolveActor,
    accessibleProjects,
    readEvents,
    snapshot,
    database,
  };
}
export type Domain = ReturnType<typeof createDomain>;
