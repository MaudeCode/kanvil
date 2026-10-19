import { writeLocalBlob, type BlobWriter } from "./blob-storage.ts";
import { postgresSearch, type TicketSearchProvider } from "./search.ts";
import { accessibleProjectRows } from "./project-access.ts";
import { and, asc, eq, gt, inArray, isNotNull, ne, or, sql } from "drizzle-orm";
import {
  closedStates,
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
} from "@kanvil/contracts";
import { createHash } from "node:crypto";
import { user } from "./auth-schema.ts";
import {
  claims,
  eventClock,
  events,
  notifications,
  notificationPreferences,
  pushDevices,
  pushDeliveries,
  projects,
  receipts,
  subscriptions,
  tickets,
} from "./schema.ts";
import type { Connection, Database, Transaction } from "./database.ts";
import { projectRole, projectRoleSQL } from "./project-access.ts";
import { workspaceHandlers, requireWorkspace } from "./workspace-operations.ts";
import { projectHandlers } from "./project-operations.ts";
import { ticketHandlers } from "./ticket-operations.ts";
import { collaborationHandlers } from "./collaboration-operations.ts";

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
  db: Connection | Transaction;
  actor: Actor;
  project: Project | null;
  workspace: Workspace | null;
  role: "reader" | "writer" | "admin";
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
    search: { where: async (_db, _ids, query) => postgresSearch(query) },
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
  const clock = one(
    await ctx.db
      .update(eventClock)
      .set({ value: sql`${eventClock.value} + ${pending.length}` })
      .where(eq(eventClock.id, 1))
      .returning(),
  );
  const first = clock.value - BigInt(pending.length) + 1n;
  const source = { kind: ctx.actor.machine ? "credential" : "session", id: ctx.actor.ownerId };
  const rows = await insertAll(
    pending.map((item, index) => ({
      id: first + BigInt(index),
      projectId: item.projectId ?? project(ctx).id,
      ticketId: item.ticketId,
      actorId: ctx.actor.id,
      type: item.type,
      data: { ...item.data, ...(item.ticketId ? titles.get(item.ticketId) : {}), source },
    })),
    (batch) => ctx.db.insert(events).values(batch).returning(),
  );
  if (ticketIds.length) {
    const followers = await ctx.db
      .select({
        ticketId: subscriptions.ticketId,
        userId: subscriptions.userId,
        inApp: notificationPreferences.inApp,
        push: notificationPreferences.push,
      })
      .from(subscriptions)
      .innerJoin(user, eq(user.id, subscriptions.userId))
      .leftJoin(notificationPreferences, eq(notificationPreferences.userId, subscriptions.userId))
      .where(
        and(
          inArray(subscriptions.ticketId, ticketIds),
          or(
            isNotNull(projectRoleSQL(user.id, subscriptions.projectId)),
            sql`'admin' = any(string_to_array(${user.role}, ','))`,
          ),
          sql`not coalesce(${user.banned}, false)`,
          ctx.actor.machine ? undefined : ne(subscriptions.userId, ctx.actor.id),
          or(
            sql`coalesce(${notificationPreferences.inApp}, true)`,
            eq(notificationPreferences.push, true),
          ),
        ),
      );
    const entries = rows.flatMap((event) =>
      followers
        .filter((follower) => follower.ticketId === event.ticketId)
        .map((follower) => ({ event, follower })),
    );
    if (entries.length) {
      const created = await insertAll(
        entries.map(({ event, follower }) => ({
          userId: follower.userId,
          projectId: event.projectId,
          eventId: event.id,
          inbox: follower.inApp ?? true,
        })),
        (batch) => ctx.db.insert(notifications).values(batch).returning(),
      );
      // Push is decided per (event, user), matched by key rather than by insert order.
      const pushing = new Set(
        entries
          .filter(({ follower }) => follower.push)
          .map(({ event, follower }) => `${event.id}:${follower.userId}`),
      );
      if (pushing.size) {
        const devices = await ctx.db
          .select({ id: pushDevices.id, userId: pushDevices.userId })
          .from(pushDevices)
          .where(
            inArray(pushDevices.userId, [
              ...new Set(entries.filter((e) => e.follower.push).map((e) => e.follower.userId)),
            ]),
          );
        const deliveries = created.flatMap((notification) =>
          pushing.has(`${notification.eventId}:${notification.userId}`)
            ? devices
                .filter((device) => device.userId === notification.userId)
                .map((device) => ({ notificationId: notification.id, deviceId: device.id }))
            : [],
        );
        await insertAll(deliveries, (batch) =>
          ctx.db.insert(pushDeliveries).values(batch).returning(),
        );
      }
    }
  }
  await ctx.db.execute(sql`SELECT pg_notify('kanvil_events', ${clock.value.toString()})`);
  return rows;
}
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
  services: { blobs?: BlobWriter; search?: TicketSearchProvider } = {},
) {
  const handlers: Handlers = {
    ...workspaceHandlers,
    ...projectHandlers,
    ...ticketHandlers,
    ...collaborationHandlers,
  };
  // Operations where `workspaceId` narrows a listing instead of naming a membership context.
  const workspaceIsFilter: ReadonlySet<Operation> = new Set([
    "list_projects",
    "list_my_work",
    "search_tickets",
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
    if (actor.projectIds && spec.method !== "GET" && !projectId)
      fail(
        403,
        "insufficient_scope",
        "Project-bound credentials can only change their configured projects",
      );
    const invoke = async (ctx: Context) => {
      if (services.blobs) ctx.blobs = services.blobs;
      if (services.search) ctx.search = services.search;
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- The operation registry and mapped handler type enforce the same key/input pairing.
      const handler = handlers[name] as (ctx: Context, payload: typeof input) => Promise<unknown>;
      return parseOutput(name, json(await handler(ctx, input)));
    };
    if (spec.method === "GET")
      return invoke(await context(database.db, actor, spec.scope, projectId, workspaceId));
    return database.db.transaction(async (tx) => {
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
