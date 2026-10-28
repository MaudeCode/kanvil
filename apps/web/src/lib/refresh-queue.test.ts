import { expect, it } from "vite-plus/test";
import { eventSchema } from "@kanvil/contracts";
import { createClient } from "@kanvil/client";
import { QueryClient, QueryObserver } from "@tanstack/react-query";
import { affectedBy, createRefreshQueue } from "./refresh-queue.ts";

const event = eventSchema.parse({
  id: "1",
  projectId: "00000000-0000-4000-8000-000000000001",
  ticketId: null,
  actorId: "actor",
  type: "ticket.updated",
  data: {},
  createdAt: "2026-01-01T00:00:00.000Z",
});
it("merges a burst into one follow-up and retains the full reset barrier", async () => {
  const controller = new AbortController();
  const batches: ((typeof event)[] | undefined)[] = [];
  let release: (() => void) | undefined;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const queue = createRefreshQueue(async (events) => {
    batches.push(events);
    if (batches.length === 1) await held;
  }, controller.signal);
  queue.push(event);
  await Promise.resolve();
  for (let i = 0; i < 50; i++) queue.push({ ...event, id: String(i + 2) });
  expect(batches).toHaveLength(1);
  release?.();
  await Promise.resolve();
  await Promise.resolve();
  expect(batches).toHaveLength(2);
  expect(batches[1]).toHaveLength(50);
  await queue.flush();
  expect(batches.at(-1)).toBeUndefined();
});
it("does not start queued refreshes after the subscription aborts", async () => {
  const controller = new AbortController();
  let count = 0;
  const queue = createRefreshQueue(async () => {
    count++;
  }, controller.signal);
  queue.push(event);
  controller.abort();
  await queue.flush();
  expect(count).toBe(0);
});

function deferred() {
  let release: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release: () => release() };
}
it("consumes 50 streamed changes while a 100-page refresh is held, with one follow-up", async () => {
  const controller = new AbortController();
  const cache = new QueryClient();
  const first = deferred(),
    held = deferred(),
    delivered = deferred(),
    finished = deferred();
  let rounds = 0,
    requests = 0,
    events = 0;
  const unsubscribes = Array.from({ length: 100 }, (_page, offset) =>
    new QueryObserver(cache, {
      queryKey: [
        "kanvil",
        "https://fixture.invalid",
        "list_tickets",
        { projectId: event.projectId, offset },
      ],
      initialData: Array.from({ length: 100 }, (_ticket, index) => ({ id: `${offset}-${index}` })),
      staleTime: Infinity,
      queryFn: async () => {
        requests++;
        await held.promise;
        return [];
      },
    }).subscribe(() => {}),
  );
  const queue = createRefreshQueue(async (batch) => {
    rounds++;
    first.release();
    await cache.invalidateQueries({
      predicate: (query) => !!batch?.some((change) => affectedBy(change)(query)),
    });
    if (rounds === 2) finished.release();
  }, controller.signal);
  const changes = Array.from({ length: 51 }, (_, index) => ({ ...event, id: String(index + 1) }));
  const body = changes
    .map((change) => `event: change\nid: ${change.id}\ndata: ${JSON.stringify(change)}\n\n`)
    .join("");
  const api = createClient({
    baseUrl: "https://fixture.invalid",
    fetch: async () => new Response(body, { headers: { "Content-Type": "text/event-stream" } }),
  });
  const watching = api.subscribe({
    signal: controller.signal,
    onEvent: (change) => {
      queue.push(change);
      if (++events === changes.length) delivered.release();
    },
  });
  await first.promise;
  await delivered.promise;
  expect(rounds).toBe(1);
  expect(requests).toBe(100);
  held.release();
  await finished.promise;
  expect(rounds).toBe(2);
  expect(requests).toBe(200);
  controller.abort();
  await watching;
  for (const unsubscribe of unsubscribes) unsubscribe();
  cache.clear();
});
it("retains every affected scope while excluding unrelated queries", () => {
  const cache = new QueryClient();
  const inputs = [
    ["list_tickets", { projectId: event.projectId }],
    ["list_tickets", { projectId: "other" }],
    ["list_members", { projectId: event.projectId }],
    ["get_ticket", { projectId: event.projectId, ticketId: "changed" }],
    ["get_ticket", { projectId: event.projectId, ticketId: "other" }],
  ];
  for (const [name, input] of inputs) cache.setQueryData(["kanvil", "fixture", name, input], {});
  const changed = { ...event, ticketId: "changed" };
  expect(cache.getQueryCache().findAll().map(affectedBy(changed))).toEqual([
    true,
    false,
    false,
    true,
    false,
  ]);
  cache.clear();
});
it("drains an event arriving between the final empty check and refresh cleanup", async () => {
  const controller = new AbortController();
  const batches: ((typeof event)[] | undefined)[] = [];
  const queue = createRefreshQueue((batch) => {
    batches.push(batch);
    return batches.length === 1
      ? Promise.resolve().then(() => {
          queueMicrotask(() => queueMicrotask(() => queue.push({ ...event, id: "2" })));
        })
      : Promise.resolve();
  }, controller.signal);
  queue.push(event);
  for (let i = 0; i < 12; i++) await Promise.resolve();
  expect(batches).toHaveLength(2);
  expect(batches[1]?.[0]?.id).toBe("2");
});
