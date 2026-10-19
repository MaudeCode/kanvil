import { closedStates } from "@kanvil/contracts";
import { and, eq, gt, isNotNull, notInArray, sql } from "drizzle-orm";
import { user } from "./auth-schema.ts";
import { appendEvents, notify, reachable, recipientColumns, type Recipient } from "./domain.ts";
import {
  events,
  notificationPreferences,
  notifications,
  subscriptions,
  tickets,
} from "./schema.ts";
import type { Database } from "./database.ts";

// ponytail: due dates more than a week past are skipped, so an upgrade or a long outage cannot flood
// Inboxes with long-overdue tickets; make the window configurable if teams need a longer catch-up.
const overdueWindow = 7 * 86_400_000;
const source = { kind: "system", id: "due-reminders" };

// Sends each follower one due-soon notice inside their lead time and one overdue notice per due date.
// Runs under the global write lock and skips notices already recorded; a unique reminder key per
// follower backs that up, so restarts, concurrent workers, and retries cannot repeat one. The clock is a parameter so tests own it.
export async function sendDueReminders(database: Database, now = new Date()) {
  return database.db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(7361080)`);
    const kind = sql<
      "due_soon" | "overdue"
    >`case when ${tickets.dueAt} <= ${now} then 'overdue' else 'due_soon' end`;
    const lead = sql`(coalesce(${notificationPreferences.reminderAmount}, 1) || ' ' || coalesce(${notificationPreferences.reminderUnit}, 'days'))::interval`;
    const due = await tx
      .select({
        kind,
        ticketId: tickets.id,
        projectId: tickets.projectId,
        key: tickets.key,
        title: tickets.title,
        dueAt: tickets.dueAt,
        ...recipientColumns,
      })
      .from(tickets)
      .innerJoin(subscriptions, eq(subscriptions.ticketId, tickets.id))
      .innerJoin(user, eq(user.id, subscriptions.userId))
      .leftJoin(notificationPreferences, eq(notificationPreferences.userId, user.id))
      .where(
        and(
          isNotNull(tickets.dueAt),
          eq(tickets.archived, false),
          sql`not exists (select 1 from projects p where p.id = ${tickets.projectId} and p.archived_at is not null)`,
          notInArray(tickets.status, [...closedStates]),
          gt(tickets.dueAt, new Date(now.getTime() - overdueWindow)),
          sql`${tickets.dueAt} - ${lead} <= ${now}`,
          sql`coalesce((${notificationPreferences.categories} ->> ${kind})::boolean, true)`,
          reachable(tickets.projectId),
          sql`not exists (
            select 1 from ${notifications} join ${events} on ${events.id} = ${notifications.eventId}
            where ${notifications.userId} = ${user.id} and ${events.ticketId} = ${tickets.id}
              and ${events.type} = 'ticket.' || ${kind}
              and (${events.data} ->> 'dueAt')::timestamptz = ${tickets.dueAt})`,
        ),
      );
    const groups = new Map<string, { row: (typeof due)[number]; recipients: Recipient[] }>();
    for (const row of due) {
      const group = groups.get(`${row.ticketId}:${row.kind}`) ?? { row, recipients: [] };
      group.recipients.push(row);
      groups.set(`${row.ticketId}:${row.kind}`, group);
    }
    const pending = [];
    for (const { row, recipients } of groups.values()) {
      const dueAt = row.dueAt?.toISOString();
      // Each run publishes its own event, so live clients of the followers it reminds refresh.
      const [event] = await appendEvents(tx, [
        {
          projectId: row.projectId,
          ticketId: row.ticketId,
          actorId: null,
          type: `ticket.${row.kind}`,
          data: { dueAt, key: row.key, title: row.title, source },
        },
      ]);
      const reminderKey = `${row.kind}:${row.ticketId}:${dueAt}`;
      if (event)
        pending.push(...recipients.map((recipient) => ({ event, recipient, reminderKey })));
    }
    await notify(tx, pending);
    return pending.length;
  });
}
