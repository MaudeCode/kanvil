import { dueFilterLabels } from "./index.ts";
import { t } from "./i18n/index.ts";
import type { Ticket } from "./index.ts";
import type { TicketLayout } from "./navigation.ts";
export type ScheduleLayout = Exclude<TicketLayout, "list">;
export function calendarDay(value: Date | string) {
  const date = new Date(value);
  date.setHours(0, 0, 0, 0);
  return date;
}
export function addCalendarDays(value: Date, count: number) {
  const date = new Date(value);
  date.setDate(date.getDate() + count);
  return date;
}
function startOfWeek(value: Date, weekStartsOn: number) {
  const date = calendarDay(value);
  return addCalendarDays(date, -((date.getDay() - weekStartsOn + 7) % 7));
}
// Shared local-calendar boundaries; adding days retains midnight across daylight-saving changes.
export function scheduleWindow(layout: ScheduleLayout, anchor: Date, weekStartsOn: number) {
  if (layout === "calendar") {
    const month = calendarDay(anchor);
    month.setDate(1);
    const last = calendarDay(anchor);
    last.setMonth(last.getMonth() + 1, 0);
    return {
      from: startOfWeek(month, weekStartsOn),
      to: addCalendarDays(startOfWeek(last, weekStartsOn), 7),
    };
  }
  const from = startOfWeek(anchor, weekStartsOn);
  return { from, to: addCalendarDays(from, 42) };
}
export function shiftAnchor(layout: ScheduleLayout, anchor: Date, direction: 1 | -1) {
  if (layout !== "calendar") return addCalendarDays(anchor, direction * 14);
  const date = new Date(anchor),
    day = date.getDate();
  date.setDate(1);
  date.setMonth(date.getMonth() + direction);
  const last = calendarDay(date);
  last.setMonth(last.getMonth() + 1, 0);
  date.setDate(Math.min(day, last.getDate()));
  return date;
}
export function calendarDistance(from: Date, to: Date) {
  return calendarOrdinal(to) - calendarOrdinal(from);
}
// A ticket spans its start (or due) day through its due (or start) day, inclusive.
export function ticketSpan(ticket: Pick<Ticket, "startAt" | "dueAt">) {
  const first = ticket.startAt ?? ticket.dueAt,
    last = ticket.dueAt ?? ticket.startAt;
  return first && last ? { start: calendarDay(first), end: calendarDay(last) } : null;
}

function calendarOrdinal(value: Date) {
  const date = new Date(0);
  date.setUTCFullYear(value.getFullYear(), value.getMonth(), value.getDate());
  date.setUTCHours(0, 0, 0, 0);
  return date.getTime() / 86400000;
}

// The work queue uses the same rolling due windows on both platforms.
export const dueWindows = [
  ["overdue", 0],
  ["today", 86400000],
  ["week", 7 * 86400000],
  ["later", Infinity],
] as const;
export function dueWindow(ticket: Pick<Ticket, "dueAt">, now: number) {
  if (!ticket.dueAt) return "none";
  const left = new Date(ticket.dueAt).getTime() - now;
  return dueWindows.find(([, within]) => left < within)?.[0] ?? "later";
}
export const dueWindowLabel = (id: (typeof dueWindows)[number][0] | "none") =>
  id === "later" ? t("ticket.list.later") : dueFilterLabels[id];
