import { expect, it } from "vite-plus/test";
import { ticketWindow } from "./ticket-window.ts";

it("keeps a complete ID index while mounting only the viewport and interaction pins", () => {
  const ids = new Map(Array.from({ length: 10_000 }, (_, index) => [`ticket-${index}`, index]));
  const window = ticketWindow(
    { startIndex: 50, endIndex: 60, overscan: 3, count: 10_000 },
    ids,
    ["ticket-0", "ticket-8000", "ticket-8000", "deleted", null],
    9999,
  );
  expect(ids.size).toBe(10_000);
  expect(window).toEqual([0, ...Array.from({ length: 17 }, (_, index) => index + 47), 8000, 9999]);
  expect(
    ticketWindow({ startIndex: 0, endIndex: 1, overscan: 3, count: 2 }, new Map(), [], 9999),
  ).toEqual([0, 1]);
});
