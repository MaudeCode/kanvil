import { useSyncExternalStore } from "react";

// One clock for every time-dependent view, so relative times and due states move on their own
// without refetching. It ticks once a second for the life of the page, and at once when the tab
// returns, so a view that mounts later never starts from a stale time. Readers select a primitive
// from the current time; React re-renders only those whose selection changed.
let now = Date.now();
const listeners = new Set<() => void>();
function tick() {
  now = Date.now();
  for (const listener of listeners) listener();
}
if (typeof window !== "undefined") {
  window.setInterval(tick, 1000);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") tick();
  });
}
function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
export function useClock<T extends string | number | boolean>(select: (now: number) => T): T {
  return useSyncExternalStore(subscribe, () => select(now));
}
