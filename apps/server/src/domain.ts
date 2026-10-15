import { and, asc, eq, gt, inArray, isNotNull, ne, or, sql } from "drizzle-orm";
import {
  ApiError,
  operations,
  parseOutput,
  type Operation,
  type ParsedInput,
  type Output,
  type Project,
  scopes,
  snapshotSchema,
} from "@kanvil/contracts";
import { createHash } from "node:crypto";
import { user } from "./auth-schema.ts";
import {
  claims,
  eventClock,
  events,
  members,
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
  db: Connection | Transaction;
  actor: Actor;
  project: Project | null;
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
export const complete = (status: string) => status === "done" || status === "cancelled";
export const hasScope = (actor: Actor, scope: (typeof scopes)[number]) =>
  actor.scopes.includes("admin") ||
  actor.scopes.includes(scope) ||
  (scope === "read" && actor.scopes.length > 0);

async function context(
  db: Context["db"],
  actor: Actor,
  scope: (typeof scopes)[number],
  projectId?: string,
): Promise<Context> {
  if (!hasScope(actor, scope))
    fail(403, "insufficient_scope", `This credential requires ${scope} permission`);
  const ctx: Context = { db, actor, project: null, role: "reader" };
  if (!projectId) return ctx;
  const row = requireRow(
    (
      await db
        .select()
        .from(projects)
        .where(
          or(eq(projects.key, projectId.toUpperCase()), sql`${projects.id}::text = ${projectId}`),
        )
        .limit(1)
    )[0],
  );
  if (actor.projectIds && !actor.projectIds.includes(row.id))
    fail(404, "not_found", "Project was not found");
  const membership = (
    await db
      .select()
      .from(members)
      .where(and(eq(members.projectId, row.id), eq(members.userId, actor.id)))
      .limit(1)
  )[0];
  if (!membership && !actor.admin) fail(404, "not_found", "Project was not found");
  const role = actor.admin ? "admin" : membership?.role;
  if (role !== "reader" && role !== "writer" && role !== "admin")
    fail(403, "forbidden", "Project access is unavailable");
  if (scope === "admin" && role !== "admin")
    fail(403, "forbidden", "Project administration permission is required");
  if ((scope === "write" || scope === "claim") && role === "reader")
    fail(403, "forbidden", "Project write permission is required");
  return {
    ...ctx,
    project: {
      ...row,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    },
    role,
  };
}
export async function getTicket(ctx: Context, identifier: string) {
  return requireRow(
    (
      await ctx.db
        .select()
        .from(tickets)
        .where(
          and(
            eq(tickets.projectId, project(ctx).id),
            or(eq(tickets.key, identifier.toUpperCase()), sql`${tickets.id}::text = ${identifier}`),
          ),
        )
        .limit(1)
    )[0],
  );
}
export async function publish(
  ctx: Context,
  type: string,
  ticketId: string | null,
  data: Record<string, unknown>,
) {
  const ticket = ticketId
    ? (
        await ctx.db
          .select({ key: tickets.key, title: tickets.title })
          .from(tickets)
          .where(eq(tickets.id, ticketId))
      )[0]
    : undefined;
  const clock = requireRow(
    (
      await ctx.db
        .update(eventClock)
        .set({ value: sql`${eventClock.value} + 1` })
        .where(eq(eventClock.id, 1))
        .returning()
    )[0],
  );
  const event = requireRow(
    (
      await ctx.db
        .insert(events)
        .values({
          id: clock.value,
          projectId: project(ctx).id,
          ticketId,
          actorId: ctx.actor.id,
          type,
          data: {
            ...data,
            ...ticket,
            source: { kind: ctx.actor.machine ? "credential" : "session", id: ctx.actor.ownerId },
          },
        })
        .returning()
    )[0],
  );
  if (ticketId) {
    const followers = await ctx.db
      .select({
        userId: subscriptions.userId,
        inApp: notificationPreferences.inApp,
        push: notificationPreferences.push,
      })
      .from(subscriptions)
      .innerJoin(user, eq(user.id, subscriptions.userId))
      .leftJoin(
        members,
        and(
          eq(members.projectId, subscriptions.projectId),
          eq(members.userId, subscriptions.userId),
        ),
      )
      .leftJoin(notificationPreferences, eq(notificationPreferences.userId, subscriptions.userId))
      .where(
        and(
          eq(subscriptions.ticketId, ticketId),
          or(isNotNull(members.userId), sql`'admin' = any(string_to_array(${user.role}, ','))`),
          sql`not coalesce(${user.banned}, false)`,
          ctx.actor.machine ? undefined : ne(subscriptions.userId, ctx.actor.id),
          or(
            sql`coalesce(${notificationPreferences.inApp}, true)`,
            eq(notificationPreferences.push, true),
          ),
        ),
      );
    for (const follower of followers) {
      const notification = requireRow(
        (
          await ctx.db
            .insert(notifications)
            .values({
              userId: follower.userId,
              projectId: project(ctx).id,
              eventId: event.id,
              inbox: follower.inApp ?? true,
            })
            .returning()
        )[0],
      );
      if (follower.push) {
        const devices = await ctx.db
          .select({ id: pushDevices.id })
          .from(pushDevices)
          .where(eq(pushDevices.userId, follower.userId));
        if (devices.length)
          await ctx.db
            .insert(pushDeliveries)
            .values(
              devices.map((device) => ({ notificationId: notification.id, deviceId: device.id })),
            );
      }
    }
  }
  await ctx.db.execute(sql`SELECT pg_notify('kanvil_events', ${event.id.toString()})`);
  return event;
}
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

export function createDomain(database: Database) {
  const handlers: Handlers = { ...projectHandlers, ...ticketHandlers, ...collaborationHandlers };
  async function execute<K extends Operation>(
    name: K,
    value: unknown,
    actor: Actor,
  ): Promise<Output<K>> {
    const spec = operations[name];
    const input = spec.input.parse(value);
    const projectId = "projectId" in input ? input.projectId : undefined;
    const invoke = async (ctx: Context) => {
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- The operation registry and mapped handler type enforce the same key/input pairing.
      const handler = handlers[name] as (ctx: Context, payload: typeof input) => Promise<unknown>;
      return parseOutput(name, json(await handler(ctx, input)));
    };
    if (spec.method === "GET")
      return invoke(await context(database.db, actor, spec.scope, projectId));
    return database.db.transaction(async (tx) => {
      // Serializing writes is deliberate for a small self-hosted install: it also gives replay cursors commit order.
      await tx.execute(sql`SELECT pg_advisory_xact_lock(7361080)`);
      const ctx = await context(tx, actor, spec.scope, projectId);
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
          return parseOutput(name, receipt.result);
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
    const row = requireRow(
      (await database.db.select().from(user).where(eq(user.id, id)).limit(1))[0],
    );
    if (row.banned) fail(403, "account_disabled", "This account is disabled");
    return {
      id,
      admin: row.role?.split(",").includes("admin") ?? false,
      machine: !!credential,
      ownerId: credential?.ownerId ?? id,
      scopes: credential?.scopes ?? scopes,
      ...(credential?.projectIds ? { projectIds: credential.projectIds } : {}),
    };
  }
  async function accessibleProjects(identity: Actor) {
    return execute("list_projects", {}, identity);
  }
  async function readEvents(identity: Actor, cursor: bigint, projectId?: string) {
    if (!hasScope(identity, "read")) fail(403, "insufficient_scope", "Read permission is required");
    const allowed = await accessibleProjects(identity);
    const ids = allowed
      .filter((row) => !projectId || row.id === projectId || row.key === projectId.toUpperCase())
      .map((row) => row.id);
    if (projectId && !ids.length) fail(404, "not_found", "Project was not found");
    const clock = requireRow(
      (await database.db.select().from(eventClock).where(eq(eventClock.id, 1)))[0],
    );
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
        const clock = requireRow(
          (await tx.select().from(eventClock).where(eq(eventClock.id, 1)))[0],
        );
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
