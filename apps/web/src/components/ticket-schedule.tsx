import {
  addDays,
  addMonths,
  differenceInCalendarDays,
  endOfMonth,
  endOfWeek,
  format,
  isSameDay,
  isSameMonth,
  startOfDay,
  startOfMonth,
  startOfToday,
  startOfWeek,
  type Day,
} from "date-fns";
import { useState } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import type { Ticket } from "@kanvil/contracts";
import { dateFormat, t } from "@kanvil/contracts/i18n";
import { Button, EmptyState, IconButton, statusColor } from "../ui.tsx";
import { TicketLink } from "./ticket-link.tsx";
import { Popover, PopoverContent, PopoverTitle, PopoverTrigger } from "@/components/ui/popover";
import type { TicketLayout } from "../search.ts";
import { cn } from "@/lib/utils";

export type ScheduleLayout = Exclude<TicketLayout, "list">;
// The timeline shows six weeks and moves two at a time, so each step keeps context on screen.
const timelineDays = 42,
  timelineStep = 14,
  visibleEntries = 3;
// The days a layout shows around the anchor day: [from, to), local midnights.
export function scheduleWindow(layout: ScheduleLayout, anchor: Date, weekStartsOn: Day) {
  if (layout === "calendar") {
    const from = startOfWeek(startOfMonth(anchor), { weekStartsOn });
    return { from, to: addDays(startOfDay(endOfWeek(endOfMonth(anchor), { weekStartsOn })), 1) };
  }
  const from = startOfWeek(anchor, { weekStartsOn });
  return { from, to: addDays(from, timelineDays) };
}
export const shiftAnchor = (layout: ScheduleLayout, anchor: Date, direction: 1 | -1) =>
  layout === "calendar" ? addMonths(anchor, direction) : addDays(anchor, direction * timelineStep);
// The one scheduled-date rule both views and the server share: a ticket runs from its start (or
// due) day through its due (or start) day; undated tickets have no span.
export function ticketSpan(ticket: Pick<Ticket, "startAt" | "dueAt">) {
  const first = ticket.startAt ?? ticket.dueAt,
    last = ticket.dueAt ?? ticket.startAt;
  return first && last
    ? { start: startOfDay(new Date(first)), end: startOfDay(new Date(last)) }
    : null;
}
// Read at render, so month and weekday names follow the interface language.
const longDay = () => dateFormat({ dateStyle: "full" }),
  mediumDay = () => dateFormat({ dateStyle: "medium" }),
  monthTitle = () => dateFormat({ month: "long", year: "numeric" }),
  weekdayLong = () => dateFormat({ weekday: "long" }),
  weekdayShort = () => dateFormat({ weekday: "short" }),
  weekdayNarrow = () => dateFormat({ weekday: "narrow" }),
  monthShort = () => dateFormat({ month: "short" });
type Span = { ticket: Ticket; start: Date; end: Date };
// The grid column of a day in the timeline; the ticket rail is column 1.
const column = (day: number) => day + 2;
const spanText = ({ start, end }: Span) =>
  start.getTime() === end.getTime()
    ? mediumDay().format(start)
    : t("ticket.schedule.range", { from: mediumDay().format(start), to: mediumDay().format(end) });

// A read-only month calendar or timeline of the list's tickets. Dates change in the ticket.
export function TicketSchedule({
  layout,
  tickets,
  anchor,
  range,
  onAnchor,
}: {
  layout: ScheduleLayout;
  tickets: Ticket[];
  anchor: Date;
  range: { from: Date; to: Date };
  // Null returns to today.
  onAnchor: (anchor: Date | null) => void;
}) {
  // Read once per mount, like the anchor's default, so rendering stays pure.
  const [today] = useState(startOfToday);
  const spans = tickets
    .flatMap((ticket) => {
      const span = ticketSpan(ticket);
      return span && span.end >= range.from && span.start < range.to ? [{ ticket, ...span }] : [];
    })
    .toSorted((a, b) => a.start.getTime() - b.start.getTime() || a.ticket.number - b.ticket.number);
  const last = addDays(range.to, -1),
    title =
      layout === "calendar"
        ? monthTitle().format(anchor)
        : t("ticket.schedule.range", {
            from: mediumDay().format(range.from),
            to: mediumDay().format(last),
          }),
    calendar = layout === "calendar";
  return (
    <section
      aria-label={calendar ? t("ticket.schedule.calendar") : t("ticket.schedule.timeline")}
      className="@container flex min-h-0 flex-1 flex-col animate-in fade-in-0"
    >
      <div className="flex min-h-11 items-center gap-1 py-1">
        <h2 className="m-0 mr-auto text-sm font-medium" aria-live="polite">
          {title}
        </h2>
        <Button variant="ghost" size="sm" onClick={() => onAnchor(null)}>
          {t("ticket.schedule.today")}
        </Button>
        <IconButton
          label={calendar ? t("ticket.schedule.previousMonth") : t("ticket.schedule.previousWeeks")}
          onClick={() => onAnchor(shiftAnchor(layout, anchor, -1))}
        >
          <ChevronLeft />
        </IconButton>
        <IconButton
          label={calendar ? t("ticket.schedule.nextMonth") : t("ticket.schedule.nextWeeks")}
          onClick={() => onAnchor(shiftAnchor(layout, anchor, 1))}
        >
          <ChevronRight />
        </IconButton>
      </div>
      {calendar ? (
        <MonthGrid spans={spans} anchor={anchor} range={range} title={title} today={today} />
      ) : spans.length ? (
        <Timeline spans={spans} range={range} today={today} />
      ) : (
        <EmptyState title={t("ticket.schedule.emptyWeeks")} />
      )}
    </section>
  );
}

function Entry({ ticket, wrap = false }: { ticket: Ticket; wrap?: boolean }) {
  return (
    <TicketLink
      projectId={ticket.projectId}
      ticketId={ticket.id}
      className={cn(
        "flex min-w-0 items-baseline gap-1.5 rounded-sm px-1 text-[11.5px] leading-5 hover:bg-muted",
        !wrap && "truncate",
      )}
    >
      <span
        aria-hidden="true"
        className={cn(
          "size-1.5 shrink-0 rounded-full bg-current",
          wrap ? "mt-[7px] self-start" : "self-center",
          statusColor(ticket.status),
        )}
      />
      <span className="shrink-0 font-mono text-[10.5px] text-muted-foreground">{ticket.key}</span>
      <span dir="auto" className={cn("min-w-0", wrap ? "wrap-anywhere" : "truncate")}>
        {ticket.title}
      </span>
    </TicketLink>
  );
}

function MonthGrid({
  spans,
  anchor,
  range,
  title,
  today,
}: {
  spans: Span[];
  anchor: Date;
  range: { from: Date; to: Date };
  title: string;
  today: Date;
}) {
  const days = Array.from({ length: differenceInCalendarDays(range.to, range.from) }, (_, index) =>
    addDays(range.from, index),
  );
  const weeks = Array.from({ length: days.length / 7 }, (_, index) =>
    days.slice(index * 7, index * 7 + 7),
  );
  return (
    <div className="min-h-0 flex-1 overflow-auto overscroll-contain pb-4">
      <table
        className="w-full table-fixed border-collapse"
        aria-label={t("ticket.schedule.monthTickets", { title })}
      >
        <thead className="sticky top-0 z-10 bg-background">
          <tr>
            {(weeks[0] ?? []).map((day) => (
              <th
                key={day.getDay()}
                scope="col"
                className="h-8 px-2 text-left text-[10.5px] font-medium tracking-[0.08em] text-muted-foreground uppercase"
              >
                <abbr title={weekdayLong().format(day)} className="no-underline">
                  <span className="@max-[600px]:hidden">{weekdayShort().format(day)}</span>
                  <span className="@min-[601px]:hidden">{weekdayNarrow().format(day)}</span>
                </abbr>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {weeks.map((week) => (
            <tr key={week[0]?.toISOString()}>
              {week.map((day) => (
                <CalendarDay
                  key={day.toISOString()}
                  day={day}
                  outside={!isSameMonth(day, anchor)}
                  today={isSameDay(day, today)}
                  spans={spans.filter((span) => span.start <= day && day <= span.end)}
                />
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function CalendarDay({
  day,
  outside,
  today,
  spans,
}: {
  day: Date;
  outside: boolean;
  today: boolean;
  spans: Span[];
}) {
  const hidden = spans.length - visibleEntries,
    label = longDay().format(day);
  return (
    <td
      className={cn(
        "h-28 border border-border p-1 align-top @max-[600px]:h-16",
        outside && "bg-muted/40 text-muted-foreground",
      )}
    >
      <time
        dateTime={format(day, "yyyy-MM-dd")}
        aria-label={label}
        aria-current={today ? "date" : undefined}
        className={cn(
          "mb-0.5 grid size-6 place-items-center rounded-full text-xs tabular-nums",
          today && "bg-primary font-medium text-primary-foreground",
        )}
      >
        {day.getDate()}
      </time>
      {spans.length > 0 && (
        <ul className="m-0 grid list-none gap-px p-0 @max-[600px]:hidden">
          {spans.slice(0, visibleEntries).map(({ ticket }) => (
            <li key={ticket.id} className="min-w-0">
              <Entry ticket={ticket} />
            </li>
          ))}
        </ul>
      )}
      {spans.length > 0 && (
        <Popover>
          <PopoverTrigger
            render={
              <Button
                variant="ghost"
                size="sm"
                aria-label={t("ticket.schedule.showDay", { count: spans.length, day: label })}
                className={cn(
                  "h-6 px-1 text-[11px] text-muted-foreground",
                  hidden <= 0 && "@min-[601px]:hidden",
                )}
              />
            }
          >
            <span className="@max-[600px]:hidden">
              {t("ticket.schedule.more", { count: hidden })}
            </span>
            <span className="@min-[601px]:hidden">{spans.length}</span>
          </PopoverTrigger>
          <PopoverContent align="start" className="w-[min(20rem,calc(100vw-2rem))] gap-2 p-3">
            <PopoverTitle className="text-xs font-medium">{label}</PopoverTitle>
            <ul className="m-0 grid list-none gap-1 p-0">
              {spans.map(({ ticket }) => (
                <li key={ticket.id}>
                  <Entry ticket={ticket} wrap />
                </li>
              ))}
            </ul>
          </PopoverContent>
        </Popover>
      )}
    </td>
  );
}

function Timeline({
  spans,
  range,
  today: todayDate,
}: {
  spans: Span[];
  range: { from: Date; to: Date };
  today: Date;
}) {
  const length = differenceInCalendarDays(range.to, range.from),
    days = Array.from({ length }, (_, index) => addDays(range.from, index)),
    today = differenceInCalendarDays(todayDate, range.from);
  return (
    <div className="min-h-0 flex-1 overflow-auto overscroll-contain pb-4">
      <div
        // The rail narrows on small screens so the days stay in view; titles wrap inside it.
        className="grid min-w-max [--rail:18rem] @max-[600px]:[--rail:9rem]"
        style={{ gridTemplateColumns: `var(--rail) repeat(${length}, 2rem)` }}
      >
        {/* The day scale repeats what each row's text says, so it stays out of the reading order. */}
        <div aria-hidden="true" className="sticky top-0 z-20 col-span-full grid grid-cols-subgrid">
          <div className="sticky left-0 z-10 flex items-end border-b bg-background px-3 pb-1 text-[10.5px] font-medium tracking-[0.08em] text-muted-foreground uppercase">
            {t("ticket.schedule.ticketColumn")}
          </div>
          {days.map((day, index) => (
            <div
              key={day.toISOString()}
              className={cn(
                "flex flex-col items-center border-b bg-background pt-1 pb-1 text-[10.5px] leading-4 tabular-nums text-muted-foreground",
                index === today && "text-primary",
              )}
            >
              <span className="h-4 font-medium text-foreground">
                {index === 0 || day.getDate() === 1 ? monthShort().format(day) : ""}
              </span>
              <span>{weekdayNarrow().format(day)}</span>
              <span
                className={cn(
                  "grid size-5 place-items-center rounded-full",
                  index === today && "bg-primary text-primary-foreground",
                )}
              >
                {day.getDate()}
              </span>
            </div>
          ))}
        </div>
        <ul
          aria-label={t("ticket.schedule.scheduledTickets")}
          className="col-span-full m-0 grid list-none grid-cols-subgrid p-0"
        >
          {spans.map((span) => {
            const first = Math.max(0, differenceInCalendarDays(span.start, range.from)),
              last = Math.min(length - 1, differenceInCalendarDays(span.end, range.from));
            return (
              <li key={span.ticket.id} className="col-span-full grid grid-cols-subgrid border-b">
                <div className="sticky left-0 z-10 row-start-1 bg-background px-2 py-1.5 [grid-column:1]">
                  <Entry ticket={span.ticket} wrap />
                  <span className="sr-only">, {spanText(span)}</span>
                </div>
                {today >= 0 && today < length && (
                  <div
                    aria-hidden="true"
                    className="row-start-1 bg-primary/8"
                    style={{ gridColumn: column(today) }}
                  />
                )}
                <div
                  aria-hidden="true"
                  title={spanText(span)}
                  className={cn(
                    "row-start-1 mx-0.5 h-5 self-center rounded-md border border-current/60 bg-current/25",
                    statusColor(span.ticket.status),
                    span.start < range.from && "ml-0 rounded-l-none border-l-0",
                    span.end >= range.to && "mr-0 rounded-r-none border-r-0",
                  )}
                  style={{ gridColumn: `${column(first)} / ${column(last) + 1}` }}
                />
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}
