import { and, asc, desc, eq, getTableColumns, isNotNull, or, sql } from "drizzle-orm";
import { createHash, randomBytes } from "node:crypto";
import { priorityLabels, stateLabels, type ParsedInput } from "@kanvil/contracts";
import { user } from "./auth-schema.ts";
import { calendarFeeds, projects, tickets } from "./schema.ts";
import { fail, one, project, publish, type Context, type Handlers } from "./domain.ts";
import { readsProject } from "./project-access.ts";
import { openTicket, predicateWhere, scheduleStart } from "./ticket-operations.ts";

const tokenPattern = /^kvcal_[A-Za-z0-9_-]{43}$/;
const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");
// A feed works while its creator can still read the project.
const active = and(eq(user.id, calendarFeeds.createdBy), readsProject(calendarFeeds.projectId));
const feedColumns = {
  ...getTableColumns(calendarFeeds),
  active: sql<boolean>`coalesce((SELECT true FROM "user" WHERE ${active}), false)`,
};
function canonicalZone(timeZone: string) {
  try {
    return new Intl.DateTimeFormat("en-US", { timeZone }).resolvedOptions().timeZone;
  } catch {
    return fail(400, "validation_error", "Use an IANA time zone such as Europe/Berlin", [
      { path: "timeZone", message: "Use an IANA time zone such as Europe/Berlin" },
    ]);
  }
}
// Label renames carry over to feed filters. A deleted label stays in the filter and matches
// nothing, so deleting it never widens what a feed shares.
export async function renameFeedLabel(ctx: Context, from: string, to: string) {
  await ctx.db
    .update(calendarFeeds)
    .set({ labels: sql`array_replace(${calendarFeeds.labels}, ${from}, ${to})` })
    .where(
      and(
        eq(calendarFeeds.projectId, project(ctx).id),
        sql`${from} = any(${calendarFeeds.labels})`,
      ),
    );
}
export const calendarHandlers: Pick<
  Handlers,
  "list_calendar_feeds" | "create_calendar_feed" | "revoke_calendar_feed"
> = {
  async list_calendar_feeds(ctx) {
    return ctx.db
      .select(feedColumns)
      .from(calendarFeeds)
      .where(eq(calendarFeeds.projectId, project(ctx).id))
      .orderBy(desc(calendarFeeds.createdAt), asc(calendarFeeds.id));
  },
  async create_calendar_feed(ctx, input: ParsedInput<"create_calendar_feed">) {
    const token = `kvcal_${randomBytes(32).toString("base64url")}`;
    const row = one(
      await ctx.db
        .insert(calendarFeeds)
        .values({
          projectId: project(ctx).id,
          createdBy: ctx.actor.id,
          name: input.name,
          labels: input.labels,
          timeZone: canonicalZone(input.timeZone),
          tokenHash: hashToken(token),
        })
        .returning(),
    );
    await publish(ctx, "calendar_feed.created", null, {
      feedId: row.id,
      name: row.name,
      labels: row.labels,
    });
    const { tokenHash: _tokenHash, ...feed } = row;
    return { ...feed, active: true, token, path: `/api/calendar/${token}.ics` };
  },
  async revoke_calendar_feed(ctx, input) {
    const row = one(
      await ctx.db
        .delete(calendarFeeds)
        .where(
          and(eq(calendarFeeds.id, input.feedId), eq(calendarFeeds.projectId, project(ctx).id)),
        )
        .returning(),
    );
    await publish(ctx, "calendar_feed.revoked", null, { feedId: row.id, name: row.name });
    return { ok: true };
  },
};

// iCalendar text values escape backslashes, separators, and line breaks (RFC 5545 3.3.11).
const escapeText = (value: string) =>
  value.replaceAll(/[\\;,]/g, (match) => `\\${match}`).replaceAll(/\r\n|\r|\n/g, "\\n");
// Lines longer than 75 octets continue on lines that start with a space, never inside a character.
function fold(line: string) {
  const lines: string[] = [];
  let current = "",
    size = 0;
  for (const character of line) {
    const length = Buffer.byteLength(character);
    if (size + length > (lines.length ? 74 : 75)) {
      lines.push(current);
      current = "";
      size = 0;
    }
    current += character;
    size += length;
  }
  return [...lines, current].join("\r\n ");
}
// The calendar day an instant falls on in the zone, as YYYYMMDD, optionally a day later.
function day(instant: Date, timeZone: string, offset = 0) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "numeric",
    day: "numeric",
  }).formatToParts(instant);
  const part = (type: string) => Number(parts.find((item) => item.type === type)?.value);
  const date = new Date(0);
  date.setUTCFullYear(part("year"), part("month") - 1, part("day") + offset);
  return date.toISOString().slice(0, 10).replaceAll("-", "");
}
const label = (labels: Record<string, string>, value: string) => labels[value] ?? value;
const stamp = (instant: Date) => `${instant.toISOString().slice(0, 19).replaceAll(/[-:]/g, "")}Z`;

// Renders a feed for its token, or null when no live feed has it. Each ticket becomes one all-day
// event from its start (or due) day through its due (or start) day in the feed's zone.
export async function readCalendarFeed(db: Context["db"], token: string, baseUrl: string) {
  if (!tokenPattern.test(token)) return null;
  const found = (
    await db
      .select({ feed: calendarFeeds, project: projects })
      .from(calendarFeeds)
      .innerJoin(projects, eq(projects.id, calendarFeeds.projectId))
      .innerJoin(user, active)
      .where(eq(calendarFeeds.tokenHash, hashToken(token)))
      .limit(1)
  )[0];
  if (!found) return null;
  const { feed, project: owner } = found;
  // An archived project's feed stays subscribed but empty until the project is restored.
  // ponytail: one feed renders at most 2000 tickets per fetch; page or cache if projects outgrow it.
  const rows = await db
    .select()
    .from(tickets)
    .where(
      and(
        eq(tickets.projectId, owner.id),
        owner.archivedAt ? sql`false` : undefined,
        eq(tickets.archived, false),
        openTicket,
        or(isNotNull(tickets.startAt), isNotNull(tickets.dueAt)),
        predicateWhere({ label: feed.labels.length ? feed.labels : undefined }),
      ),
    )
    .orderBy(asc(scheduleStart), asc(tickets.number))
    .limit(2000);
  const now = stamp(new Date());
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Kanvil//Calendar feed//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    `NAME:${escapeText(`${owner.name} · ${feed.name}`)}`,
    `X-WR-CALNAME:${escapeText(`${owner.name} · ${feed.name}`)}`,
    `X-WR-TIMEZONE:${feed.timeZone}`,
    "REFRESH-INTERVAL;VALUE=DURATION:PT1H",
    "X-PUBLISHED-TTL:PT1H",
  ];
  for (const ticket of rows) {
    const first = ticket.startAt ?? ticket.dueAt,
      last = ticket.dueAt ?? ticket.startAt;
    if (!first || !last) continue;
    lines.push(
      "BEGIN:VEVENT",
      `UID:${ticket.id}@kanvil`,
      `DTSTAMP:${now}`,
      `LAST-MODIFIED:${stamp(ticket.updatedAt)}`,
      `SEQUENCE:${ticket.version}`,
      `DTSTART;VALUE=DATE:${day(first, feed.timeZone)}`,
      // The end of an all-day event is exclusive.
      `DTEND;VALUE=DATE:${day(last, feed.timeZone, 1)}`,
      "TRANSP:TRANSPARENT",
      `SUMMARY:${escapeText(`${ticket.key} · ${ticket.title}`)}`,
      `DESCRIPTION:${escapeText(`${label(stateLabels, ticket.status)} · ${label(priorityLabels, ticket.priority)}`)}`,
      `URL:${new URL(`/projects/${owner.id}/tickets/${ticket.id}`, baseUrl).href}`,
      "END:VEVENT",
    );
  }
  lines.push("END:VCALENDAR");
  return `${lines.map(fold).join("\r\n")}\r\n`;
}
