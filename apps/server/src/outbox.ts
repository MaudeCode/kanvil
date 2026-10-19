import {
  channelRouteAllows,
  closedStates,
  destinationEventKeys,
  eventSchema,
  formatEvent,
  hasAdminRole,
  type DeliverySettings,
} from "@kanvil/contracts";
import { createHmac } from "node:crypto";
import { projectRoleSQL } from "./project-access.ts";
import { and, asc, eq, isNull, lte, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { Expo, type ExpoPushTicket, type ExpoPushReceipt } from "expo-server-sdk";
import { session, user } from "./auth-schema.ts";
import {
  deliveries,
  events,
  notificationChannels,
  notificationPreferences,
  notifications,
  projectDestinations,
  projects,
  pushDevices,
  repositoryConnections,
  resources,
  subscriptions,
  tickets,
} from "./schema.ts";
import { json } from "./domain.ts";
import { readSettings } from "./delivery-operations.ts";
import { driverFor, readRepositorySettings } from "./repository-operations.ts";
import { createHttpSender, createMailSender, DeliveryError } from "./adapters/outbound.ts";
import type {
  MailMessage,
  OutboundRequest,
  OutboundSenders,
  RepositoryDrivers,
} from "./adapters/ports.ts";
import type { Database } from "./database.ts";
import type { Config } from "./config.ts";
import type { Sealer } from "./sealing.ts";

const delay = (attempt: number) => Math.min(60_000 * 2 ** attempt, 3_600_000);
const eventActor = alias(user, "event_actor");
type Job = typeof deliveries.$inferSelect;
type Row = NonNullable<Awaited<ReturnType<typeof load>>>;

// Everything one send needs, read fresh so access, routing, and pauses apply at send time.
async function load(database: Database, id: string) {
  return (
    await database.db
      .select({
        job: deliveries,
        device: pushDevices,
        session: session,
        channel: notificationChannels,
        destination: projectDestinations,
        connection: repositoryConnections,
        notification: notifications,
        event: events,
        project: { id: projects.id, key: projects.key, name: projects.name },
        workspaceId: projects.workspaceId,
        projectArchivedAt: projects.archivedAt,
        // Whether the link a repository comment announces is still on its ticket.
        linkLive: sql<boolean>`exists (SELECT 1 FROM ${resources} r
          WHERE r.id::text = ${events.data}->>'resourceId' AND r.ticket_id = ${tickets.id})`,
        account: user,
        preference: notificationPreferences,
        projectRole: projectRoleSQL(user.id, notifications.projectId),
        // Whether the administrator a repository connection acts as can still write to its project.
        connectionWriter: sql<boolean>`coalesce((SELECT true FROM "user" cu
          WHERE cu.id = ${repositoryConnections.createdBy} AND NOT coalesce(cu.banned, false)
          AND ('admin' = any(string_to_array(cu.role, ','))
            OR ${projectRoleSQL(repositoryConnections.createdBy, repositoryConnections.projectId)} IN ('writer', 'admin'))), false)`,
        subscription: subscriptions,
        actorName: eventActor.name,
        ticket: {
          id: tickets.id,
          dueAt: tickets.dueAt,
          status: tickets.status,
          archived: tickets.archived,
        },
      })
      .from(deliveries)
      .leftJoin(pushDevices, eq(pushDevices.id, deliveries.deviceId))
      .leftJoin(session, eq(session.id, pushDevices.sessionId))
      .leftJoin(notificationChannels, eq(notificationChannels.id, deliveries.channelId))
      .leftJoin(projectDestinations, eq(projectDestinations.id, deliveries.destinationId))
      .leftJoin(repositoryConnections, eq(repositoryConnections.id, deliveries.connectionId))
      .leftJoin(notifications, eq(notifications.id, deliveries.notificationId))
      .leftJoin(
        events,
        eq(events.id, sql`coalesce(${notifications.eventId}, ${deliveries.eventId})`),
      )
      .leftJoin(projects, eq(projects.id, events.projectId))
      // A ticket that moved away is no longer the subject of its old project's events.
      .leftJoin(
        tickets,
        and(eq(tickets.id, events.ticketId), eq(tickets.projectId, events.projectId)),
      )
      .leftJoin(
        user,
        eq(user.id, sql`coalesce(${pushDevices.userId}, ${notificationChannels.userId})`),
      )
      .leftJoin(notificationPreferences, eq(notificationPreferences.userId, user.id))
      .leftJoin(
        subscriptions,
        and(eq(subscriptions.ticketId, events.ticketId), eq(subscriptions.userId, user.id)),
      )
      .leftJoin(eventActor, eq(eventActor.id, events.actorId))
      .where(and(eq(deliveries.id, id), isNull(deliveries.finishedAt)))
  )[0];
}
// Why a queued personal notification must not be sent now, or null when it may be.
function notificationSkip(row: Row, ownerId: string | undefined): string | null {
  const { notification, account, event, ticket } = row;
  if (!notification || !account || !event) return "access_revoked";
  if (
    ownerId !== notification.userId ||
    account.banned ||
    // A mention reaches its member without a subscription; anything else needs one.
    (!row.subscription && ticket !== null && notification.category !== "mention") ||
    (!row.projectRole && !hasAdminRole(account.role))
  )
    return "access_revoked";
  if (row.preference?.categories[notification.category] === false) return "category_disabled";
  // A reminder is stale once its ticket closes, it or its project is archived, it is deleted, or
  // its due date moves.
  if (
    (event.type === "ticket.due_soon" || event.type === "ticket.overdue") &&
    (!ticket ||
      ticket.archived ||
      row.projectArchivedAt ||
      closedStates.some((state) => state === ticket.status) ||
      ticket.dueAt?.getTime() !== new Date(String(event.data.dueAt)).getTime())
  )
    return "reminder_stale";
  if (notification.createdAt.getTime() < Date.now() - 86_400_000) return "expired";
  return null;
}
function skipReason(row: Row, config: Config): string | null {
  const { job, device, channel, destination, connection, event } = row;
  // Turning push off stops sends to devices that registered while it was on.
  if (device && !config.KANVIL_PUSH_ENABLED) return "push_disabled";
  if (device)
    return !row.session || row.session.expiresAt <= new Date() || !row.preference?.push
      ? "access_revoked"
      : notificationSkip(row, device.userId);
  if (channel) {
    if (!job.notificationId) return null;
    if (channel.paused) return "paused";
    const skip = notificationSkip(row, channel.userId);
    if (skip) return skip;
    return event &&
      channelRouteAllows(channel.routes, row.workspaceId ?? undefined, event.projectId)
      ? null
      : "route_disabled";
  }
  // A connection's access check always runs; its link comments follow the current preferences.
  if (connection) {
    if (!job.eventId) return null;
    if (connection.paused) return "paused";
    if (!connection.commentOnLink) return "comments_disabled";
    // Comments act for the connecting administrator, so they stop with that person's write access.
    if (!row.connectionWriter || event?.projectId !== connection.projectId) return "access_revoked";
    // A ticket that moved or was deleted, or a removed link, has nothing left to point at.
    if (!row.ticket || !row.linkLive) return "link_removed";
    return row.projectArchivedAt ? "project_archived" : null;
  }
  if (!destination) return "access_revoked";
  if (!job.eventId) return null;
  if (destination.paused) return "paused";
  if (!event || event.projectId !== destination.projectId) return "access_revoked";
  if (!destinationEventKeys(event).some((key) => destination.events.includes(key)))
    return "event_disabled";
  return event.createdAt.getTime() < Date.now() - 86_400_000 ? "expired" : null;
}

type Message = { title: string; text: string; url: string };
function compose(config: Config, row: Row): Message {
  const { event } = row;
  if (!event)
    return {
      title: "Kanvil test",
      text: "Kanvil can deliver notifications here.",
      url: config.KANVIL_URL,
    };
  const key = typeof event.data.key === "string" ? event.data.key : "",
    title = typeof event.data.title === "string" ? event.data.title : "";
  const label = formatEvent(eventSchema.parse(json(event)));
  return {
    title: `${key} ${title}`.trim() || row.project?.name || "Kanvil",
    text:
      row.notification?.category === "mention"
        ? `${row.actorName ?? "Someone"} mentioned you in a comment`
        : row.actorName
          ? `${label} by ${row.actorName}`
          : label,
    url: new URL(
      `/projects/${event.projectId}${event.ticketId ? `/tickets/${event.ticketId}` : ""}`,
      config.KANVIL_URL,
    ).href,
  };
}
// Chat formats render mentions; a zero-width space keeps ticket text from pinging anyone.
const quiet = (value: string) => value.replaceAll("@", "@​");
const markdownText = (value: string) => quiet(value).replaceAll(/[[\]\\]/g, "\\$&");
const slackText = (value: string) =>
  quiet(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
const post = (url: string, body: unknown, headers?: Record<string, string>): OutboundRequest => ({
  url,
  body: JSON.stringify(body),
  headers,
});
// The request or message for one target kind. Webhooks carry the event and an HMAC signature.
export function outbound(
  settings: DeliverySettings,
  message: Message,
  row: { deliveryId: string; event: Row["event"]; project: Row["project"] },
): { mail: MailMessage } | { http: OutboundRequest } {
  const line = `${message.title}: ${message.text}`;
  switch (settings.kind) {
    case "email":
      return {
        mail: {
          to: settings.address,
          subject: message.title,
          text: `${message.text}\n\n${message.url}`,
        },
      };
    case "ntfy":
      return {
        http: post(
          settings.server,
          {
            topic: settings.topic,
            title: message.title,
            message: message.text,
            click: message.url,
          },
          settings.token ? { Authorization: `Bearer ${settings.token}` } : undefined,
        ),
      };
    case "gotify":
      return {
        http: post(
          new URL(
            "message",
            settings.server.endsWith("/") ? settings.server : `${settings.server}/`,
          ).href,
          {
            title: message.title,
            message: `${message.text}\n${message.url}`,
            priority: 5,
            extras: { "client::notification": { click: { url: message.url } } },
          },
          { "X-Gotify-Key": settings.token },
        ),
      };
    case "webhook": {
      const body = JSON.stringify({
        id: row.deliveryId,
        type: row.event?.type ?? "test",
        title: message.title,
        text: message.text,
        url: message.url,
        project: row.project,
        event: row.event ? json(row.event) : null,
      });
      const timestamp = String(Math.floor(Date.now() / 1000));
      const headers: Record<string, string> = {
        "Kanvil-Delivery": row.deliveryId,
        "Kanvil-Event": row.event?.type ?? "test",
        "Kanvil-Timestamp": timestamp,
      };
      if (settings.secret)
        headers["Kanvil-Signature"] =
          `v1=${createHmac("sha256", settings.secret).update(`${timestamp}.${body}`).digest("hex")}`;
      return { http: { url: settings.url, body, headers } };
    }
    case "slack":
      return { http: post(settings.url, { text: `${slackText(line)} <${message.url}|Open>` }) };
    case "discord":
      return {
        http: post(settings.url, {
          content: `${quiet(line)}\n${message.url}`,
          allowed_mentions: { parse: [] },
        }),
      };
    case "mattermost":
      return {
        http: post(settings.url, {
          text: `${quiet(line)} ${message.url}`,
          ...(settings.channel && { channel: settings.channel }),
        }),
      };
    default:
      return {
        http: post(`https://api.telegram.org/bot${settings.token}/sendMessage`, {
          chat_id: settings.chatId,
          ...(settings.topicId && { message_thread_id: settings.topicId }),
          text: `${quiet(line)}\n${message.url}`,
          link_preview_options: { is_disabled: true },
        }),
      };
  }
}

// The database outbox survives restarts. A crash after sending may repeat a message, so webhooks
// carry the delivery ID for receivers to deduplicate.
// ponytail: one worker sends rows in order, each bounded by the transport timeout; send per target
// concurrently if a busy instance queues faster than that.
export async function deliverBatch(
  database: Database,
  config: Config,
  senders: OutboundSenders,
  secrets: Sealer,
  repositories: RepositoryDrivers,
) {
  const lock = await database.pool.connect();
  let ownsLock = false;
  try {
    const acquired = await lock.query<{ acquired: boolean }>(
      "SELECT pg_try_advisory_lock(7361082) AS acquired",
    );
    if (!acquired.rows[0]?.acquired) return;
    ownsLock = true;
    const jobs = await database.db
      .select({ id: deliveries.id })
      .from(deliveries)
      .where(and(isNull(deliveries.finishedAt), lte(deliveries.availableAt, new Date())))
      .orderBy(asc(deliveries.availableAt))
      .limit(100);
    for (const pending of jobs) {
      const row = await load(database, pending.id);
      if (!row) continue;
      const skip = skipReason(row, config);
      if (skip) await finish(database, row.job, skip);
      else if (row.device) await sendPush(database, config, senders, row);
      else await send(database, config, senders, secrets, repositories, row);
    }
  } finally {
    try {
      if (ownsLock) await lock.query("SELECT pg_advisory_unlock(7361082)");
    } finally {
      lock.release();
    }
  }
}
const finish = (database: Database, job: Job, error: string | null) =>
  database.db
    .update(deliveries)
    .set({ finishedAt: new Date(), error })
    .where(eq(deliveries.id, job.id));
// Five attempts with exponential backoff; Expo receipts are polled without using attempts up.
const retry = (database: Database, job: Job, error: string) =>
  database.db
    .update(deliveries)
    .set({
      attempts: job.attempts + 1,
      error,
      availableAt: new Date(Date.now() + (job.receiptId ? 900_000 : delay(job.attempts))),
      finishedAt: job.attempts >= 4 && error !== "receipt_pending" ? new Date() : null,
    })
    .where(eq(deliveries.id, job.id));
// The latest attempt's outcome, shown as the channel's or destination's health.
async function recordHealth(database: Database, job: Job, error: string | null) {
  const now = new Date(),
    values = { lastAttemptAt: now, lastError: error, ...(error ? {} : { lastSuccessAt: now }) };
  if (job.channelId)
    await database.db
      .update(notificationChannels)
      .set(values)
      .where(eq(notificationChannels.id, job.channelId));
  if (job.destinationId)
    await database.db
      .update(projectDestinations)
      .set(values)
      .where(eq(projectDestinations.id, job.destinationId));
  if (job.connectionId)
    await database.db
      .update(repositoryConnections)
      .set(values)
      .where(eq(repositoryConnections.id, job.connectionId));
}
// A connection's access check, or its comment linking an issue or pull request to the ticket.
function repositoryRequest(
  config: Config,
  secrets: Sealer,
  repositories: RepositoryDrivers,
  row: Row & { connection: NonNullable<Row["connection"]> },
): OutboundRequest {
  const { connection, event } = row,
    { token } = readRepositorySettings(secrets, connection.settings),
    driver = driverFor(repositories, connection);
  if (!event) return driver.access(connection.repository, token);
  const remote = event.data.remote,
    number =
      remote && typeof remote === "object" && "number" in remote ? Number(remote.number) : NaN;
  if (!Number.isInteger(number)) throw new DeliveryError("invalid_event", false);
  const message = compose(config, row);
  return driver.comment(
    connection.repository,
    token,
    number,
    `Linked to [${markdownText(message.title)}](${message.url}) in Kanvil.`,
  );
}
async function send(
  database: Database,
  config: Config,
  senders: OutboundSenders,
  secrets: Sealer,
  repositories: RepositoryDrivers,
  row: Row,
) {
  const { connection } = row,
    target = row.channel ?? row.destination;
  let failure: DeliveryError | undefined;
  try {
    let request: ReturnType<typeof outbound>;
    if (connection)
      request = { http: repositoryRequest(config, secrets, repositories, { ...row, connection }) };
    else if (target)
      request = outbound(readSettings({ secrets }, target.settings), compose(config, row), {
        deliveryId: row.job.id,
        event: row.event,
        project: row.project,
      });
    else return;
    if ("mail" in request) {
      if (!senders.mail) throw new DeliveryError("email_unavailable", false);
      await senders.mail(request.mail);
    } else {
      const { status } = await senders.http(request.http);
      if (status >= 300 && status < 400) throw new DeliveryError("redirect_blocked", false);
      if (status >= 400)
        throw new DeliveryError(
          `http_${status}`,
          status === 408 || status === 429 || status >= 500,
        );
    }
  } catch (error) {
    failure = error instanceof DeliveryError ? error : new DeliveryError("delivery_failed", true);
  }
  if (!failure) await finish(database, row.job, null);
  else if (failure.retry) await retry(database, row.job, failure.code);
  else await finish(database, row.job, failure.code);
  await recordHealth(database, row.job, failure?.code ?? null);
}
async function sendPush(database: Database, config: Config, senders: OutboundSenders, row: Row) {
  const { job, device, event, notification } = row;
  if (!device || !event || !notification) return;
  try {
    let result: ExpoPushTicket | ExpoPushReceipt | undefined;
    if (job.receiptId)
      result = (await senders.push.getPushNotificationReceiptsAsync([job.receiptId]))[
        job.receiptId
      ];
    else
      result = (
        await senders.push.sendPushNotificationsAsync([
          {
            to: device.token,
            title: "Kanvil",
            body:
              notification.category === "mention"
                ? "You were mentioned in a comment."
                : "A subscribed ticket has an update.",
            sound: "default",
            channelId: "tickets",
            ttl: 3600,
            data: {
              server: config.KANVIL_URL,
              projectId: event.projectId,
              ticketId: event.ticketId,
              notificationId: notification.id,
            },
          },
        ])
      )[0];
    if (result?.status === "ok") {
      if (!job.receiptId && "id" in result) {
        await database.db
          .update(deliveries)
          .set({
            receiptId: result.id,
            availableAt: new Date(Date.now() + 900_000),
            attempts: 0,
            error: null,
          })
          .where(eq(deliveries.id, job.id));
      } else await finish(database, job, null);
    } else if (result?.status === "error" && result.details?.error !== "MessageRateExceeded") {
      if (result.details?.error === "DeviceNotRegistered")
        await database.db.delete(pushDevices).where(eq(pushDevices.id, device.id));
      else await finish(database, job, result.details?.error ?? "delivery_rejected");
    } else {
      await retry(database, job, result ? "rate_limited" : "receipt_pending");
    }
  } catch {
    await retry(database, job, "transport_error");
  }
}

export function defaultSenders(config: Config): OutboundSenders {
  return {
    push: new Expo(config.EXPO_ACCESS_TOKEN ? { accessToken: config.EXPO_ACCESS_TOKEN } : {}),
    http: createHttpSender({ allowPrivate: config.KANVIL_DELIVERY_ALLOW_PRIVATE }),
    ...(config.SMTP_URL &&
      config.SMTP_FROM && { mail: createMailSender(config.SMTP_URL, config.SMTP_FROM) }),
  };
}
