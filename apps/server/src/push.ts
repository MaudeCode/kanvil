import { closedStates, hasAdminRole } from "@kanvil/contracts";
import { projectRoleSQL } from "./project-access.ts";
import { and, asc, eq, isNull, lte } from "drizzle-orm";
import { Expo, type ExpoPushTicket, type ExpoPushReceipt } from "expo-server-sdk";
import { session, user } from "./auth-schema.ts";
import {
  events,
  notificationPreferences,
  notifications,
  pushDeliveries,
  pushDevices,
  subscriptions,
  tickets,
} from "./schema.ts";
import type { Database } from "./database.ts";
import type { Config } from "./config.ts";

type Transport = Pick<Expo, "sendPushNotificationsAsync" | "getPushNotificationReceiptsAsync">;
const delay = (attempt: number) => Math.min(60_000 * 2 ** attempt, 3_600_000);

// The database outbox survives restarts. A crash after sending may produce a duplicate notification.
export async function deliverPushBatch(database: Database, config: Config, transport: Transport) {
  const lock = await database.pool.connect();
  let ownsLock = false;
  try {
    const acquired = await lock.query<{ acquired: boolean }>(
      "SELECT pg_try_advisory_lock(7361082) AS acquired",
    );
    if (!acquired.rows[0]?.acquired) return;
    ownsLock = true;
    const jobs = await database.db
      .select({ id: pushDeliveries.id })
      .from(pushDeliveries)
      .where(and(isNull(pushDeliveries.finishedAt), lte(pushDeliveries.availableAt, new Date())))
      .orderBy(asc(pushDeliveries.availableAt))
      .limit(100);
    for (const pending of jobs) {
      const row = (
        await database.db
          .select({
            job: pushDeliveries,
            device: pushDevices,
            notification: notifications,
            event: events,
            preference: notificationPreferences,
            account: user,
            session: session,
            projectRole: projectRoleSQL(user.id, notifications.projectId),
            subscription: subscriptions,
            ticket: {
              id: tickets.id,
              dueAt: tickets.dueAt,
              status: tickets.status,
              archived: tickets.archived,
            },
          })
          .from(pushDeliveries)
          .innerJoin(pushDevices, eq(pushDevices.id, pushDeliveries.deviceId))
          .innerJoin(notifications, eq(notifications.id, pushDeliveries.notificationId))
          .innerJoin(events, eq(events.id, notifications.eventId))
          .leftJoin(tickets, eq(tickets.id, events.ticketId))
          .innerJoin(user, eq(user.id, pushDevices.userId))
          .innerJoin(session, eq(session.id, pushDevices.sessionId))
          .leftJoin(notificationPreferences, eq(notificationPreferences.userId, user.id))
          .leftJoin(
            subscriptions,
            and(eq(subscriptions.ticketId, events.ticketId), eq(subscriptions.userId, user.id)),
          )
          .where(and(eq(pushDeliveries.id, pending.id), isNull(pushDeliveries.finishedAt)))
      )[0];
      if (!row) continue;
      const { job, device, event } = row;
      const finish = async (error: string | null) =>
        database.db
          .update(pushDeliveries)
          .set({ finishedAt: new Date(), error })
          .where(eq(pushDeliveries.id, job.id));
      if (
        device.userId !== row.notification.userId ||
        row.account.banned ||
        row.session.expiresAt <= new Date() ||
        !row.preference?.push ||
        // A mention reaches its member without a subscription; anything else needs one.
        (!row.subscription && row.ticket !== null && row.notification.category !== "mention") ||
        (!row.projectRole && !hasAdminRole(row.account.role))
      ) {
        await finish("access_revoked");
        continue;
      }
      if (row.preference.categories[row.notification.category] === false) {
        await finish("category_disabled");
        continue;
      }
      // A reminder is stale once its ticket closes, is archived or deleted, or moves its due date.
      if (
        (event.type === "ticket.due_soon" || event.type === "ticket.overdue") &&
        (!row.ticket ||
          row.ticket.archived ||
          closedStates.some((state) => state === row.ticket?.status) ||
          row.ticket.dueAt?.getTime() !== new Date(String(event.data.dueAt)).getTime())
      ) {
        await finish("reminder_stale");
        continue;
      }
      if (row.notification.createdAt.getTime() < Date.now() - 86_400_000) {
        await finish("expired");
        continue;
      }
      try {
        let result: ExpoPushTicket | ExpoPushReceipt | undefined;
        if (job.receiptId)
          result = (await transport.getPushNotificationReceiptsAsync([job.receiptId]))[
            job.receiptId
          ];
        else
          result = (
            await transport.sendPushNotificationsAsync([
              {
                to: device.token,
                title: "Kanvil",
                body:
                  row.notification.category === "mention"
                    ? "You were mentioned in a comment."
                    : "A subscribed ticket has an update.",
                sound: "default",
                channelId: "tickets",
                ttl: 3600,
                data: {
                  server: config.KANVIL_URL,
                  projectId: event.projectId,
                  ticketId: event.ticketId,
                  notificationId: row.notification.id,
                },
              },
            ])
          )[0];
        if (result?.status === "ok") {
          if (!job.receiptId && "id" in result) {
            await database.db
              .update(pushDeliveries)
              .set({
                receiptId: result.id,
                availableAt: new Date(Date.now() + 900_000),
                attempts: 0,
                error: null,
              })
              .where(eq(pushDeliveries.id, job.id));
          } else await finish(null);
        } else if (result?.status === "error" && result.details?.error !== "MessageRateExceeded") {
          if (result.details?.error === "DeviceNotRegistered")
            await database.db.delete(pushDevices).where(eq(pushDevices.id, device.id));
          else await finish(result.details?.error ?? "delivery_rejected");
        } else {
          await retry(result ? "rate_limited" : "receipt_pending");
        }
      } catch {
        await retry("transport_error");
      }
      async function retry(error: string) {
        await database.db
          .update(pushDeliveries)
          .set({
            attempts: job.attempts + 1,
            error,
            availableAt: new Date(Date.now() + (job.receiptId ? 900_000 : delay(job.attempts))),
            finishedAt: job.attempts >= 4 && error !== "receipt_pending" ? new Date() : null,
          })
          .where(eq(pushDeliveries.id, job.id));
      }
    }
  } finally {
    try {
      if (ownsLock) await lock.query("SELECT pg_advisory_unlock(7361082)");
    } finally {
      lock.release();
    }
  }
}

export function createPushDelivery(database: Database, config: Config) {
  let running: Promise<void> | undefined;
  const transport = new Expo(
    config.EXPO_ACCESS_TOKEN ? { accessToken: config.EXPO_ACCESS_TOKEN } : {},
  );
  const tick = () => {
    if (!running)
      running = deliverPushBatch(database, config, transport)
        .catch(() => {
          console.error("Push delivery failed; queued notifications will be retried.");
        })
        .finally(() => {
          running = undefined;
        });
  };
  const timer = config.KANVIL_PUSH_ENABLED ? setInterval(tick, 30_000) : undefined;
  timer?.unref();
  return {
    async close() {
      clearInterval(timer);
      await running;
    },
  };
}
