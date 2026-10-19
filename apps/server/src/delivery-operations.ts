import { and, count, eq, inArray, isNull, desc } from "drizzle-orm";
import {
  channelKinds,
  deliverySecretFields,
  deliverySettingsSchema,
  destinationKinds,
  type DeliveryKind,
  type DeliverySettings,
} from "@kanvil/contracts";
import { requireSession } from "./access.ts";
import { deliveries, notificationChannels, projectDestinations } from "./schema.ts";
import {
  assertVersion,
  fail,
  one,
  project,
  publish,
  type Context,
  type Handlers,
} from "./domain.ts";

type Target = typeof notificationChannels.$inferSelect | typeof projectDestinations.$inferSelect;

// Applies submitted fields over the saved settings: an omitted field keeps its value and an empty
// one clears it. Secrets therefore stay write-only, and the result is validated as a whole.
function mergeSettings(
  kinds: readonly DeliveryKind[],
  saved: DeliverySettings | undefined,
  input: { kind: string; [field: string]: string | number | null },
): DeliverySettings {
  const kind = kinds.find((item) => item === input.kind);
  if (!kind || (saved && saved.kind !== kind))
    fail(400, "validation_error", "Invalid request", [
      { path: "settings.kind", message: saved ? "The kind cannot change" : "Unsupported kind" },
    ]);
  const merged: Record<string, unknown> = { ...saved };
  for (const [field, value] of Object.entries(input))
    if (value === null || value === "") delete merged[field];
    else merged[field] = value;
  return deliverySettingsSchema.parse(merged);
}
export function readSettings(ctx: Pick<Context, "secrets">, sealed: string) {
  return deliverySettingsSchema.parse(ctx.secrets.unseal(sealed));
}
// The host, address, or chat a target sends to, without the secret part of its URL.
function endpointOf(settings: DeliverySettings) {
  switch (settings.kind) {
    case "email":
      return settings.address;
    case "telegram":
      return settings.chatId;
    case "ntfy":
      return `${new URL(settings.server).host}/${settings.topic}`;
    case "gotify":
      return new URL(settings.server).host;
    default:
      return new URL(settings.url).host;
  }
}
function present(ctx: Context, row: Target, pending: Map<string, number>) {
  const settings = readSettings(ctx, row.settings),
    secret = deliverySecretFields[settings.kind];
  const entries = Object.entries(settings).filter(([field]) => field !== "kind");
  return {
    ...row,
    kind: settings.kind,
    settings: Object.fromEntries(entries.filter(([field]) => !secret.includes(field))),
    secrets: entries.flatMap(([field]) => (secret.includes(field) ? [field] : [])),
    endpoint: endpointOf(settings),
    health: healthOf(row, pending),
  };
}
// The latest send's outcome for any outbox target, with its count of unfinished deliveries.
export function healthOf(
  row: {
    id: string;
    lastAttemptAt: Date | null;
    lastSuccessAt: Date | null;
    lastError: string | null;
  },
  pending: Map<string, number>,
) {
  return {
    status: !row.lastAttemptAt ? "idle" : row.lastError ? "failing" : "ok",
    error: row.lastError,
    lastAttemptAt: row.lastAttemptAt,
    lastSuccessAt: row.lastSuccessAt,
    pending: pending.get(row.id) ?? 0,
  };
}
export async function pendingFor(
  ctx: Context,
  column:
    | typeof deliveries.channelId
    | typeof deliveries.destinationId
    | typeof deliveries.connectionId,
  ids: string[],
) {
  if (!ids.length) return new Map<string, number>();
  const rows = await ctx.db
    .select({ id: column, total: count() })
    .from(deliveries)
    .where(and(inArray(column, ids), isNull(deliveries.finishedAt)))
    .groupBy(column);
  return new Map(rows.map((row) => [String(row.id), row.total]));
}
export const changedHealth = { lastAttemptAt: null, lastSuccessAt: null, lastError: null };

async function ownChannel(ctx: Context, channelId: string, expectedVersion?: number) {
  const row = one(
    await ctx.db
      .select()
      .from(notificationChannels)
      .where(
        and(
          eq(notificationChannels.id, channelId),
          eq(notificationChannels.userId, requireSession(ctx.actor).id),
        ),
      ),
  );
  if (expectedVersion !== undefined)
    assertVersion(row, expectedVersion, "notification channel", "changing it");
  return row;
}
async function projectDestination(ctx: Context, destinationId: string, expectedVersion?: number) {
  const row = one(
    await ctx.db
      .select()
      .from(projectDestinations)
      .where(
        and(
          eq(projectDestinations.id, destinationId),
          eq(projectDestinations.projectId, project(ctx).id),
        ),
      ),
  );
  if (expectedVersion !== undefined)
    assertVersion(row, expectedVersion, "destination", "changing it");
  return row;
}
const presentChannel = async (ctx: Context, row: typeof notificationChannels.$inferSelect) =>
  present(ctx, row, await pendingFor(ctx, deliveries.channelId, [row.id]));
const presentDestination = async (ctx: Context, row: typeof projectDestinations.$inferSelect) =>
  present(ctx, row, await pendingFor(ctx, deliveries.destinationId, [row.id]));
const destinationEvent = (row: typeof projectDestinations.$inferSelect) => ({
  destinationId: row.id,
  name: row.name,
  kind: row.kind,
  paused: row.paused,
  version: row.version,
});

// Channels are personal: only the account's own signed-in sessions see or change them.
export const deliveryHandlers: Pick<
  Handlers,
  | "list_notification_channels"
  | "create_notification_channel"
  | "update_notification_channel"
  | "delete_notification_channel"
  | "test_notification_channel"
  | "list_project_destinations"
  | "create_project_destination"
  | "update_project_destination"
  | "delete_project_destination"
  | "test_project_destination"
> = {
  async list_notification_channels(ctx) {
    const rows = await ctx.db
      .select()
      .from(notificationChannels)
      .where(eq(notificationChannels.userId, requireSession(ctx.actor).id))
      .orderBy(desc(notificationChannels.createdAt));
    const pending = await pendingFor(
      ctx,
      deliveries.channelId,
      rows.map((row) => row.id),
    );
    return rows.map((row) => present(ctx, row, pending));
  },
  async create_notification_channel(ctx, input) {
    const settings = mergeSettings(channelKinds, undefined, input.settings);
    const row = one(
      await ctx.db
        .insert(notificationChannels)
        .values({
          userId: requireSession(ctx.actor).id,
          kind: settings.kind,
          name: input.name,
          settings: ctx.secrets.seal(settings),
          routes: input.routes,
          paused: input.paused,
        })
        .returning(),
    );
    return presentChannel(ctx, row);
  },
  async update_notification_channel(ctx, input) {
    const current = await ownChannel(ctx, input.channelId, input.expectedVersion);
    const settings = input.settings
      ? mergeSettings(channelKinds, readSettings(ctx, current.settings), input.settings)
      : undefined;
    const row = one(
      await ctx.db
        .update(notificationChannels)
        .set({
          name: input.name,
          routes: input.routes,
          paused: input.paused,
          ...(settings && { settings: ctx.secrets.seal(settings), ...changedHealth }),
          version: current.version + 1,
          updatedAt: new Date(),
        })
        .where(eq(notificationChannels.id, current.id))
        .returning(),
    );
    return presentChannel(ctx, row);
  },
  async delete_notification_channel(ctx, input) {
    const current = await ownChannel(ctx, input.channelId, input.expectedVersion);
    await ctx.db.delete(notificationChannels).where(eq(notificationChannels.id, current.id));
    return { ok: true };
  },
  async test_notification_channel(ctx, input) {
    const current = await ownChannel(ctx, input.channelId);
    await ctx.db.insert(deliveries).values({ channelId: current.id });
    return { ok: true };
  },
  async list_project_destinations(ctx) {
    const rows = await ctx.db
      .select()
      .from(projectDestinations)
      .where(eq(projectDestinations.projectId, project(ctx).id))
      .orderBy(desc(projectDestinations.createdAt));
    const pending = await pendingFor(
      ctx,
      deliveries.destinationId,
      rows.map((row) => row.id),
    );
    return rows.map((row) => present(ctx, row, pending));
  },
  async create_project_destination(ctx, input) {
    const settings = mergeSettings(destinationKinds, undefined, input.settings);
    const row = one(
      await ctx.db
        .insert(projectDestinations)
        .values({
          projectId: project(ctx).id,
          kind: settings.kind,
          name: input.name,
          settings: ctx.secrets.seal(settings),
          events: [...new Set(input.events)],
          paused: input.paused,
          createdBy: ctx.actor.id,
        })
        .returning(),
    );
    await publish(ctx, "destination.created", null, destinationEvent(row));
    return presentDestination(ctx, row);
  },
  async update_project_destination(ctx, input) {
    const current = await projectDestination(ctx, input.destinationId, input.expectedVersion);
    const settings = input.settings
      ? mergeSettings(destinationKinds, readSettings(ctx, current.settings), input.settings)
      : undefined;
    const row = one(
      await ctx.db
        .update(projectDestinations)
        .set({
          name: input.name,
          events: input.events && [...new Set(input.events)],
          paused: input.paused,
          ...(settings && { settings: ctx.secrets.seal(settings), ...changedHealth }),
          version: current.version + 1,
          updatedAt: new Date(),
        })
        .where(eq(projectDestinations.id, current.id))
        .returning(),
    );
    await publish(ctx, "destination.updated", null, destinationEvent(row));
    return presentDestination(ctx, row);
  },
  async delete_project_destination(ctx, input) {
    const current = await projectDestination(ctx, input.destinationId, input.expectedVersion);
    await ctx.db.delete(projectDestinations).where(eq(projectDestinations.id, current.id));
    await publish(ctx, "destination.deleted", null, {
      destinationId: current.id,
      name: current.name,
      kind: current.kind,
    });
    return { ok: true };
  },
  async test_project_destination(ctx, input) {
    const current = await projectDestination(ctx, input.destinationId);
    await ctx.db.insert(deliveries).values({ destinationId: current.id });
    return { ok: true };
  },
};
