import { and, desc, eq, inArray, isNotNull, isNull, lt, sql } from "drizzle-orm";
import { z } from "zod";
import {
  ApiError,
  repositoryProviderLabels,
  repositoryProviders,
  repositorySecretFields,
} from "@kanvil/contracts";
import {
  deliveries,
  receivedWebhooks,
  repositoryConnections,
  resources,
  tickets,
  workflowStates,
} from "./schema.ts";
import {
  appendEvents,
  assertVersion,
  fail,
  one,
  project,
  publish,
  type Context,
  type Domain,
  type Handlers,
} from "./domain.ts";
import { changedHealth, healthOf, pendingFor } from "./delivery-operations.ts";
import { updateTicketRow } from "./ticket-operations.ts";
import type { RepositoryChange, RepositoryDrivers } from "./adapters/ports.ts";
import type { Sealer } from "./sealing.ts";

type Connection = typeof repositoryConnections.$inferSelect;
const repositorySettings = z.object({ token: z.string(), webhookSecret: z.string() });
export const readRepositorySettings = (secrets: Pick<Sealer, "unseal">, sealed: string) =>
  repositorySettings.parse(secrets.unseal(sealed));
const sameRepository = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const providerOf = (row: Pick<Connection, "provider">) =>
  z.enum(repositoryProviders).parse(row.provider);
export const driverFor = (drivers: RepositoryDrivers, row: Pick<Connection, "provider">) =>
  drivers[providerOf(row)];
// Handled deliveries are kept this long; a redelivery inside the window applies nothing twice.
const replayWindowMs = 30 * 86_400_000;

function present(ctx: Context, row: Connection, pending: Map<string, number>) {
  const settings = readRepositorySettings(ctx.secrets, row.settings);
  return {
    ...row,
    webhookUrl: new URL(`/api/repository-hooks/${row.id}`, ctx.publicUrl).href,
    secrets: repositorySecretFields.filter((field) => settings[field]),
    health: healthOf(row, pending),
  };
}
const presentOne = async (ctx: Context, row: Connection) =>
  present(ctx, row, await pendingFor(ctx, deliveries.connectionId, [row.id]));
async function ownConnection(ctx: Context, connectionId: string, expectedVersion?: number) {
  const row = one(
    await ctx.db
      .select()
      .from(repositoryConnections)
      .where(
        and(
          eq(repositoryConnections.id, connectionId),
          eq(repositoryConnections.projectId, project(ctx).id),
        ),
      ),
  );
  if (expectedVersion !== undefined)
    assertVersion(row, expectedVersion, "repository connection", "changing it");
  return row;
}
async function assertTransitions(ctx: Context, transitions: Record<string, string> | undefined) {
  const ids = [...new Set(Object.values(transitions ?? {}))];
  if (!ids.length) return;
  const found = await ctx.db
    .select({ id: workflowStates.id })
    .from(workflowStates)
    .where(and(eq(workflowStates.projectId, project(ctx).id), inArray(workflowStates.id, ids)));
  for (const [trigger, stateId] of Object.entries(transitions ?? {}))
    if (!found.some((state) => state.id === stateId))
      fail(400, "validation_error", "Choose a workflow state of this project", [
        { path: `transitions.${trigger}`, message: "Choose a workflow state of this project" },
      ]);
}
async function assertAvailable(ctx: Context, repository: string, except?: string) {
  const taken = await ctx.db
    .select({ id: repositoryConnections.id })
    .from(repositoryConnections)
    .where(
      and(
        eq(repositoryConnections.projectId, project(ctx).id),
        sql`lower(${repositoryConnections.repository}) = lower(${repository})`,
      ),
    );
  if (taken.some((row) => row.id !== except))
    fail(409, "repository_connected", "This repository is already connected to the project");
}
const connectionEvent = (row: Connection) => ({
  connectionId: row.id,
  provider: row.provider,
  repository: row.repository,
  paused: row.paused,
  version: row.version,
});
// A deleted workflow state's transitions follow its tickets to the replacement state.
export async function reassignTransitions(ctx: Context, from: string, to: string) {
  const rows = await ctx.db
    .select()
    .from(repositoryConnections)
    .where(eq(repositoryConnections.projectId, project(ctx).id));
  for (const row of rows) {
    if (!Object.values(row.transitions).includes(from)) continue;
    await ctx.db
      .update(repositoryConnections)
      .set({
        transitions: Object.fromEntries(
          Object.entries(row.transitions).map(([trigger, id]) => [trigger, id === from ? to : id]),
        ),
        version: row.version + 1,
        updatedAt: new Date(),
      })
      .where(eq(repositoryConnections.id, row.id));
  }
}

export const repositoryHandlers: Pick<
  Handlers,
  | "list_repository_connections"
  | "create_repository_connection"
  | "update_repository_connection"
  | "delete_repository_connection"
  | "verify_repository_connection"
> = {
  async list_repository_connections(ctx) {
    const rows = await ctx.db
      .select()
      .from(repositoryConnections)
      .where(eq(repositoryConnections.projectId, project(ctx).id))
      .orderBy(desc(repositoryConnections.createdAt));
    const pending = await pendingFor(
      ctx,
      deliveries.connectionId,
      rows.map((row) => row.id),
    );
    return rows.map((row) => present(ctx, row, pending));
  },
  async create_repository_connection(ctx, input) {
    await assertTransitions(ctx, input.transitions);
    await assertAvailable(ctx, input.repository);
    const row = one(
      await ctx.db
        .insert(repositoryConnections)
        .values({
          projectId: project(ctx).id,
          provider: input.provider,
          repository: input.repository,
          settings: ctx.secrets.seal({ token: input.token, webhookSecret: input.webhookSecret }),
          paused: input.paused,
          commentOnLink: input.commentOnLink,
          transitions: input.transitions,
          createdBy: ctx.actor.id,
        })
        .returning(),
    );
    // The access check runs in the outbox, outside the write lock.
    await ctx.db.insert(deliveries).values({ connectionId: row.id });
    await publish(ctx, "repository.connected", null, connectionEvent(row));
    return presentOne(ctx, row);
  },
  async update_repository_connection(ctx, input) {
    const current = await ownConnection(ctx, input.connectionId, input.expectedVersion);
    await assertTransitions(ctx, input.transitions);
    if (input.repository) await assertAvailable(ctx, input.repository, current.id);
    const saved = readRepositorySettings(ctx.secrets, current.settings),
      recheck =
        (input.repository !== undefined && input.repository !== current.repository) ||
        (input.token !== undefined && input.token !== saved.token);
    const row = one(
      await ctx.db
        .update(repositoryConnections)
        .set({
          repository: input.repository,
          paused: input.paused,
          commentOnLink: input.commentOnLink,
          transitions: input.transitions,
          ...((input.token !== undefined || input.webhookSecret !== undefined) && {
            settings: ctx.secrets.seal({
              token: input.token ?? saved.token,
              webhookSecret: input.webhookSecret ?? saved.webhookSecret,
            }),
          }),
          // Reconnecting acts as the administrator who saved the new access.
          ...(recheck && { ...changedHealth, createdBy: ctx.actor.id }),
          version: current.version + 1,
          updatedAt: new Date(),
        })
        .where(eq(repositoryConnections.id, current.id))
        .returning(),
    );
    if (row.repository !== current.repository)
      // Queued comments name issues of the old repository; never send them to the new one.
      await ctx.db
        .update(deliveries)
        .set({ finishedAt: new Date(), error: "repository_changed" })
        .where(
          and(
            eq(deliveries.connectionId, row.id),
            isNotNull(deliveries.eventId),
            isNull(deliveries.finishedAt),
          ),
        );
    if (recheck) await ctx.db.insert(deliveries).values({ connectionId: row.id });
    await publish(ctx, "repository.updated", null, connectionEvent(row));
    return presentOne(ctx, row);
  },
  async delete_repository_connection(ctx, input) {
    const current = await ownConnection(ctx, input.connectionId, input.expectedVersion);
    await ctx.db.delete(repositoryConnections).where(eq(repositoryConnections.id, current.id));
    await publish(ctx, "repository.disconnected", null, connectionEvent(current));
    return { ok: true };
  },
  async verify_repository_connection(ctx, input) {
    const current = await ownConnection(ctx, input.connectionId);
    await ctx.db.insert(deliveries).values({ connectionId: current.id });
    return { ok: true };
  },
};

// Ticket keys of this project named in branch names and titles, such as `feat/kan-12-fix`.
function ticketKeys(projectKey: string, references: readonly string[]) {
  const pattern = new RegExp(`\\b${projectKey}-(\\d+)\\b`, "gi");
  return [
    ...new Set(
      references.flatMap((text) =>
        [...text.matchAll(pattern)].map((match) => `${projectKey}-${Number(match[1])}`),
      ),
    ),
  ].slice(0, 20);
}
// Records the change on the ticket's link to it, then applies the mapped transition. A change older
// than the state already recorded for that link applies nothing, so a late or replayed delivery
// cannot undo a newer one.
async function linkTicket(
  ctx: Context,
  connection: Connection,
  ticket: typeof tickets.$inferSelect,
  change: RepositoryChange,
  occurredAt: Date,
) {
  const existing = (
    await ctx.db
      .select()
      .from(resources)
      .where(and(eq(resources.ticketId, ticket.id), eq(resources.url, change.url)))
      .limit(1)
  )[0];
  if (existing?.remoteCheckedAt && existing.remoteCheckedAt > occurredAt) return "stale";
  if (!existing && !change.creates) return "not_linked";
  const remote = {
    provider: repositoryProviderLabels[providerOf(connection)],
    remoteKind: change.kind,
    remoteState: change.state,
    remoteCheckedAt: occurredAt,
  };
  const title = change.number ? `${change.title} #${change.number}` : change.title;
  if (!existing) {
    const row = one(
      await ctx.db
        .insert(resources)
        .values({
          projectId: ticket.projectId,
          ticketId: ticket.id,
          actorId: ctx.actor.id,
          url: change.url,
          title: title.slice(0, 200),
          ...remote,
        })
        .returning(),
    );
    const event = await publish(ctx, "resource.added", ticket.id, {
      resourceId: row.id,
      remote: { kind: change.kind, state: change.state, number: change.number },
    });
    if (connection.commentOnLink && change.number)
      await ctx.db.insert(deliveries).values({ connectionId: connection.id, eventId: event.id });
  } else if (existing.remoteState !== change.state || existing.remoteKind !== change.kind) {
    const row = one(
      await ctx.db
        .update(resources)
        .set({
          ...remote,
          title: existing.title || title.slice(0, 200),
          version: existing.version + 1,
          updatedAt: new Date(),
        })
        .where(eq(resources.id, existing.id))
        .returning(),
    );
    await publish(ctx, "resource.updated", ticket.id, {
      resourceId: row.id,
      version: row.version,
      remote: { kind: change.kind, state: change.state, number: change.number },
    });
  } else
    await ctx.db
      .update(resources)
      .set({ remoteCheckedAt: occurredAt })
      .where(eq(resources.id, existing.id));
  const stateId = change.trigger && connection.transitions[change.trigger];
  if (!stateId || stateId === ticket.stateId) return "linked";
  // The normal ticket update: version, claim, and workflow checks, and its event. The connection
  // writes as a worker without a claim, so a claimed ticket keeps its state.
  try {
    const { event } = await updateTicketRow(ctx, {
      projectId: ticket.projectId,
      ticketId: ticket.id,
      expectedVersion: ticket.version,
      changes: { stateId },
    });
    await publish(ctx, event.type, event.ticketId, event.data);
    return "moved";
  } catch (error) {
    if (error instanceof ApiError) return error.code;
    throw error;
  }
}

const gone = (): never =>
  fail(404, "not_found", "This repository webhook does not exist or was disconnected");
const done = (outcome: string) => ({ outcome, tickets: [] });
export type WebhookResult = {
  outcome: string;
  tickets: { key: string; result: string }[];
};
// Accepts one signed delivery for a connection. The signature is checked before the write lock, so
// unsigned traffic never waits on it; inside the lock the delivery ID is recorded first, so a
// redelivery or a concurrent duplicate applies nothing.
export async function receiveRepositoryWebhook(
  domain: Domain,
  drivers: RepositoryDrivers,
  secrets: Sealer,
  connectionId: string,
  headers: Headers,
  body: string,
): Promise<WebhookResult> {
  if (!z.uuid().safeParse(connectionId).success) gone();
  const found = (
    await domain.database.db
      .select()
      .from(repositoryConnections)
      .where(eq(repositoryConnections.id, connectionId))
  )[0];
  if (!found) return gone();
  const driver = driverFor(drivers, found),
    verify = (row: Connection) => {
      if (
        !driver.signed(readRepositorySettings(secrets, row.settings).webhookSecret, headers, body)
      )
        fail(401, "invalid_signature", "The webhook signature does not match the saved secret");
    };
  verify(found);
  let delivery: ReturnType<typeof driver.read>;
  try {
    delivery = driver.read(headers, body);
  } catch {
    return fail(400, "invalid_request", "The webhook payload could not be read");
  }
  return domain.transact(async (tx, as) => {
    const connection = (
      await tx.select().from(repositoryConnections).where(eq(repositoryConnections.id, found.id))
    )[0];
    if (!connection) return gone();
    if (connection.settings !== found.settings) verify(connection);
    const fresh = await tx
      .insert(receivedWebhooks)
      .values({
        connectionId: connection.id,
        deliveryId: delivery.id,
        event: delivery.event,
        outcome: "received",
      })
      .onConflictDoNothing()
      .returning();
    if (!fresh.length) return { outcome: "duplicate", tickets: [] };
    const result = await apply();
    await tx
      .update(receivedWebhooks)
      .set({
        outcome: result.tickets.length
          ? result.tickets.map((item) => `${item.key}:${item.result}`).join(" ")
          : result.outcome,
      })
      .where(
        and(
          eq(receivedWebhooks.connectionId, connection.id),
          eq(receivedWebhooks.deliveryId, delivery.id),
        ),
      );
    await tx
      .delete(receivedWebhooks)
      .where(
        and(
          eq(receivedWebhooks.connectionId, connection.id),
          lt(receivedWebhooks.receivedAt, new Date(Date.now() - replayWindowMs)),
        ),
      );
    // Connection-level refusals show on the connection; per-ticket skips are recorded above.
    const lastEventError =
      result.outcome === "access_revoked" || result.outcome === "repository_mismatch"
        ? result.outcome
        : null;
    await tx
      .update(repositoryConnections)
      .set({ lastEventAt: new Date(), lastEventError })
      .where(eq(repositoryConnections.id, connection.id));
    // Open settings screens learn of every delivery, including ones that changed no ticket.
    await appendEvents(tx, [
      {
        projectId: connection.projectId,
        ticketId: null,
        actorId: null,
        type: "repository.received",
        data: {
          connectionId: connection.id,
          event: delivery.event,
          outcome: result.outcome,
          lastEventError,
          source: { kind: "repository", id: connection.id },
        },
      },
    ]);
    return result;

    async function apply(): Promise<WebhookResult> {
      if (!connection) return gone();
      const { change } = delivery;
      if (connection.paused) return done("paused");
      if (!change) return done("ignored");
      if (!delivery.repository || !sameRepository(delivery.repository, connection.repository))
        return done("repository_mismatch");
      // Writes act as the administrator who connected the repository and stop with their access.
      let ctx: Context;
      try {
        if (!connection.createdBy) return done("access_revoked");
        const actor = await domain.actor(connection.createdBy, {
          ownerId: `repository:${connection.id}`,
          scopes: ["read", "write"],
          projectIds: [connection.projectId],
        });
        ctx = await as(actor, connection.projectId);
      } catch (error) {
        if (error instanceof ApiError)
          return done(error.code === "project_archived" ? error.code : "access_revoked");
        throw error;
      }
      const keys = ticketKeys(project(ctx).key, change.references);
      const linked = keys.length
        ? await tx
            .select()
            .from(tickets)
            .where(and(eq(tickets.projectId, connection.projectId), inArray(tickets.key, keys)))
        : [];
      if (!linked.length) return done("no_ticket");
      const occurredAt = change.occurredAt ?? new Date();
      const results = [];
      for (const ticket of linked)
        results.push({
          key: ticket.key,
          result: await linkTicket(ctx, connection, ticket, change, occurredAt),
        });
      return { outcome: "processed", tickets: results };
    }
  });
}
