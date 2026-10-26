import { expect, it } from "vite-plus/test";
import { addCalendarDays, scheduleWindow, shiftAnchor, ticketSpan } from "./schedule.ts";
it("keeps month steps valid at month ends and across a leap year", () => {
  const shifted = shiftAnchor("calendar", new Date(2028, 0, 31), 1);
  expect([shifted.getFullYear(), shifted.getMonth(), shifted.getDate()]).toEqual([2028, 1, 29]);
  expect(shiftAnchor("calendar", new Date(2026, 2, 31), -1).getDate()).toBe(28);
  const ancient = new Date("0001-01-31T12:00:00");
  expect(shiftAnchor("calendar", ancient, 1).getFullYear()).toBe(1);
  expect(scheduleWindow("calendar", ancient, 1).to.getFullYear()).toBe(1);
});
it("uses local midnights and complete weeks for both schedule layouts", () => {
  const anchor = new Date(2026, 2, 8);
  const month = scheduleWindow("calendar", anchor, 1),
    timeline = scheduleWindow("timeline", anchor, 1);
  expect([
    month.from.getDay(),
    month.to.getDay(),
    month.from.getHours(),
    month.to.getHours(),
  ]).toEqual([1, 1, 0, 0]);
  expect(addCalendarDays(timeline.from, 42)).toEqual(timeline.to);
  expect(addCalendarDays(new Date(2026, 2, 7), 2).getDate()).toBe(9);
});
it("keeps a due-only ticket on one day and excludes undated tickets", () => {
  const span = ticketSpan({ startAt: null, dueAt: "2026-10-25T12:00:00Z" });
  expect(span?.start).toEqual(span?.end);
  expect(ticketSpan({ startAt: null, dueAt: null })).toBeNull();
});
