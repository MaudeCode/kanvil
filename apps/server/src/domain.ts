import { writeLocalBlob, type BlobWriter } from "./blob-storage.ts";
import { builtinSearch, type TicketSearchProvider } from "./search.ts";
import { accessibleProjectRows } from "./project-access.ts";
import { and, asc, eq, gt, inArray, ne, or, sql, type SQLWrapper } from "drizzle-orm";
import {
  closedStates,
  eventCategories,
  ApiError,
  operations,
  parseOutput,
  type Operation,
  type ParsedInput,
  type Output,
  type Project,
  type Workspace,
  workspaceSchema,
  scopes,
  snapshotSchema,
  projectSchema,
  hasAdminRole,
  type NotificationCategory,
  channelRouteAllows,
  destinationEventKeys,
} from "@kanvil/contracts";
import { createHash } from "node:crypto";
import { user } from "./auth-schema.ts";
import type { Sealer } from "./sealing.ts";
import type { MailMessage } from "./adapters/ports.ts";
import {
  claims,
  deliveries,
  eventClock,
  events,
  notificationChannels,
  notifications,
  notificationPreferences,
  projectDestinations,
  pushDevices,
  projects,
  receipts,
  subscriptions,
  tickets,
} from "./schema.ts";
import type { Connection, Database, Transaction } from "./database.ts";
import { projectRole, readsProject } from "./project-access.ts";
import { workspaceHandlers, requireWorkspace } from "./workspace-operations.ts";
import { projectHandlers } from "./project-operations.ts";
import { labelHandlers } from "./label-operations.ts";
import { ticketHandlers } from "./ticket-operations.ts";
import { collaborationHandlers } from "./collaboration-operations.ts";
import { deliveryHandlers } from "./delivery-operations.ts";
import { calendarHandlers } from "./calendar-operations.ts";
import { invitationHandlers } from "./invitation-operations.ts";
import { workflowHandlers } from "./workflow-operations.ts";

export interface Actor {
  id: string;
  admin: boolean;
  machine: boolean;
  ownerId: string;
  scopes: readonly (typeof scopes)[number][];
  projectIds?: readonly string[];
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
  role: "reader" | "writer" | "admin";
  // The public origin for links in outgoing messages.
  publicUrl: string;
  // Queues an email to send after the write commits; absent without an SMTP relay.
  mail?: (message: MailMessage) => void;
}
export type Handler<K extends Operation> = (
  ctx: Context,
  input: ParsedInput<K>,
) => Promise<unknown>;
export type Handlers = { [K in Operation]: Handler<K> };
export function fail(status: number, code: string, message: string, details?: unknown): never {
  throw new ApiError(status, code, message, details);
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
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  });
}
export async function accountByEmail(db: Context["db"], email: string) {
  const found = (
    await db.select().from(user).where(eq(user.email, email.toLowerCase())).limit(1)
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
export const hasScope = (actor: Actor, scope: (typeof scopes)[number]) =>
  actor.scopes.includes("admin") ||
  actor.scopes.includes(scope) ||
  (scope === "read" && actor.scopes.length > 0);

const noSecrets: Sealer = {
  seal: () => fail(503, "delivery_unavailable", "Outbound delivery is not configured"),
  unseal: () => fail(503, "delivery_unavailable", "Outbound delivery is not configured"),
};
async function context(
  db: Context["db"],
  actor: Actor,
  scope: (typeof scopes)[number],
  projectId?: string,
  workspaceId?: string,
): Promise<Context> {
  if (!hasScope(actor, scope))
    fail(403, "insufficient_scope", `This credential requires ${scope} permission`);
  const ctx: Context = {
    db,
    actor,
    project: null,
    workspace: null,
    role: "reader",
    blobs: { put: writeLocalBlob },
    search: builtinSearch,
    secrets: noSecrets,
    publicUrl: "http://localhost",
  };
  if (workspaceId) {
    ctx.workspace = await requireWorkspace(ctx, workspaceId, scope === "admin");
    if ((scope === "write" || scope === "claim") && ctx.workspace.role === "reader")
      fail(403, "forbidden", "Workspace write access is required");
  }
  if (!projectId) return ctx;
  const row = one(
    await db
      .select()
      .from(projects)
      .where(
        or(eq(projects.key, projectId.toUpperCase()), sql`${projects.id}::text = ${projectId}`),
      )
      .limit(1),
  );
  if (actor.projectIds && !actor.projectIds.includes(row.id))
    fail(404, "not_found", "Project was not found");
  const role = await projectRole(db, actor, row);
  if (!role) fail(404, "not_found", "Project was not found");
  if (role !== "reader" && role !== "writer" && role !== "admin")
    fail(403, "forbidden", "Project access is unavailable");
  if (scope === "admin" && role !== "admin")
    fail(403, "forbidden", "Project administration permission is required");
  if ((scope === "write" || scope === "claim") && role === "reader")
    fail(403, "forbidden", "Project write permission is required");
  return { ...ctx, project: toProject(row), role };
}
export async function getTicket(ctx: Context, identifier: string) {
  return one(
    await ctx.db
      .select()
      .from(tickets)
      .where(
        and(
          eq(tickets.projectId, project(ctx).id),
          or(eq(tickets.key, identifier.toUpperCase()), sql`${tickets.id}::text = ${identifier}`),
        ),
      )
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
async function insertAll<T, R>(rows: T[], insert: (batch: T[]) => Promise<R[]>): Promise<R[]> {
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
  return rows;
}
// Queues each ticket event for the project's active destinations that carry its kind of activity.
async function queueDestinations(db: Context["db"], rows: (typeof events.$inferSelect)[]) {
  const ticketEvents = rows.filter((event) => event.ticketId);
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
export async function publishMany(ctx: Context, pending: PendingEvent[]) {
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
      data: { ...item.data, ...(item.ticketId ? titles.get(item.ticketId) : {}), source },
    })),
  );
  if (ticketIds.length) {
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
// A relationship change appears in both tickets' activity.
export const relationEvents = (
  type: "relation.added" | "relation.removed",
  relation: { sourceId: string; targetId: string },
): PendingEvent[] =>
  [relation.sourceId, relation.targetId].map((ticketId) => ({
    type,
    ticketId,
    data: { relation },
  }));
export function ownsLiveClaim(ctx: Context, claim: typeof claims.$inferSelect) {
  return (
    claim.ownerId === ctx.actor.ownerId &&
    claim.expiresAt > new Date() &&
    hasScope(ctx.actor, "claim") &&
    ctx.role !== "reader"
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

export function createDomain(
  database: Database,
  services: {
    blobs?: BlobWriter;
    search?: TicketSearchProvider;
    secrets?: Sealer;
    publicUrl?: string;
    mail?: ((message: MailMessage) => Promise<void>) | undefined;
  } = {},
) {
  const handlers: Handlers = {
    ...workspaceHandlers,
    ...projectHandlers,
    ...labelHandlers,
    ...ticketHandlers,
    ...collaborationHandlers,
    ...deliveryHandlers,
    ...calendarHandlers,
    ...invitationHandlers,
    ...workflowHandlers,
  };
  // Operations that act for the person signed in, never for a credential.
  const sessionOnly: ReadonlySet<Operation> = new Set(["get_invitation", "accept_invitation"]);
  // Operations where `workspaceId` narrows a listing instead of naming a membership context.
  const workspaceIsFilter: ReadonlySet<Operation> = new Set([
    "list_projects",
    "list_my_work",
    "search_tickets",
    "search_workspace",
  ]);
  async function execute<K extends Operation>(
    name: K,
    value: unknown,
    actor: Actor,
  ): Promise<Output<K>> {
    const spec = operations[name];
    const input = spec.input.parse(value);
    const projectId = "projectId" in input ? input.projectId : undefined;
    const workspaceId =
      "workspaceId" in input && !workspaceIsFilter.has(name) ? input.workspaceId : undefined;
    // Checked first: every credential is project-bound and would otherwise get a scope error.
    if (actor.machine && sessionOnly.has(name))
      fail(403, "session_required", "Use a signed-in account for this action");
    if (actor.projectIds && spec.method !== "GET" && !projectId)
      fail(
        403,
        "insufficient_scope",
        "Project-bound credentials can only change their configured projects",
      );
    const outgoing: MailMessage[] = [];
    const invoke = async (ctx: Context) => {
      if (services.blobs) ctx.blobs = services.blobs;
      if (services.search) ctx.search = services.search;
      if (services.secrets) ctx.secrets = services.secrets;
      if (services.publicUrl) ctx.publicUrl = services.publicUrl;
      if (services.mail) ctx.mail = (message) => outgoing.push(message);
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- The operation registry and mapped handler type enforce the same key/input pairing.
      const handler = handlers[name] as (ctx: Context, payload: typeof input) => Promise<unknown>;
      return parseOutput(name, json(await handler(ctx, input)));
    };
    if (spec.method === "GET")
      return invoke(await context(database.db, actor, spec.scope, projectId, workspaceId));
    const committed = await database.db.transaction(async (tx) => {
      // Serializing writes is deliberate for a small self-hosted install: it also gives replay cursors commit order.
      await tx.execute(sql`SELECT pg_advisory_xact_lock(7361080)`);
      const ctx = await context(tx, actor, spec.scope, projectId, workspaceId);
      const requestId = "requestId" in input ? input.requestId : undefined;
      const hash = createHash("sha256").update(JSON.stringify({ name, input })).digest("hex");
      if (requestId) {
        const receipt = (
          await tx
            .select()
            .from(receipts)
            .where(and(eq(receipts.actorId, actor.id), eq(receipts.requestId, requestId)))
            .limit(1)
        )[0];
        if (receipt) {
          if (receipt.hash !== hash || receipt.operation !== name)
            fail(409, "idempotency_conflict", "This requestId was already used for another write");
          const prior = parseOutput(name, receipt.result);
          // Creation has no input subject ID, so its stored result must also be authorized on replay.
          if (name === "create_project")
            await context(tx, actor, "read", projectSchema.parse(prior).id);
          if (name === "create_workspace")
            await requireWorkspace(ctx, workspaceSchema.parse(prior).id);
          return prior;
        }
      }
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
    };
  }
  // Realtime and routes need the rows only; `list_projects` adds counts that would run per wake-up.
  async function accessibleProjects(identity: Actor) {
    return accessibleProjectRows(database.db, identity);
  }
  async function readEvents(identity: Actor, cursor: bigint, projectId?: string) {
    if (!hasScope(identity, "read")) fail(403, "insufficient_scope", "Read permission is required");
    const allowed = await accessibleProjects(identity);
    const ids = allowed
      .filter((row) => !projectId || row.id === projectId || row.key === projectId.toUpperCase())
      .map((row) => row.id);
    if (projectId && !ids.length) fail(404, "not_found", "Project was not found");
    const clock = one(await database.db.select().from(eventClock).where(eq(eventClock.id, 1)));
    if (cursor < clock.floor || cursor > clock.value)
      fail(410, "snapshot_required", "Fetch a fresh snapshot before reconnecting", {
        cursor: clock.value.toString(),
      });
    const rows = ids.length
      ? await database.db
          .select()
          .from(events)
          .where(and(inArray(events.projectId, ids), gt(events.id, cursor)))
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
  return { execute, actor: resolveActor, accessibleProjects, readEvents, snapshot, database };
}
export type Domain = ReturnType<typeof createDomain>;
