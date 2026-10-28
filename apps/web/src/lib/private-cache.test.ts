import { expect, it, vi } from "vite-plus/test";
import type { PersistedClient } from "@tanstack/react-query-persist-client";
import { QueryClient } from "@tanstack/react-query";
import {
  createPrivatePersister,
  subscribePrivateCache,
  type PrivateCacheStore,
} from "./private-cache.ts";

function fixture() {
  const entries = new Map<string, string>();
  let saved: PersistedClient | undefined;
  const store: PrivateCacheStore = {
    read: async () => saved,
    write: vi.fn(async (client, allowed) => {
      if (allowed()) saved = client;
    }),
    remove: async () => {
      saved = undefined;
    },
  };
  const storage = {
    getItem: (key: string) => entries.get(key) ?? null,
    setItem: (key: string, value: string) => {
      entries.set(key, value);
    },
    removeItem: (key: string) => {
      entries.delete(key);
    },
  };
  return { entries, store, storage };
}
const client = { timestamp: 1, buster: "fixture", clientState: { queries: [], mutations: [] } };
it("prevents queued writes and obsolete sessions from restoring an account cache after sign-out", async () => {
  vi.useFakeTimers();
  try {
    const { storage, store } = fixture();
    const old = createPrivatePersister(storage, "account", store);
    old.persister.persistClient(client);
    old.pause();
    await old.clear();
    await vi.runAllTimersAsync();
    expect(await store.read()).toBeUndefined();
    const current = createPrivatePersister(storage, "account", store);
    current.persister.persistClient(client);
    await vi.runAllTimersAsync();
    old.persister.removeClient();
    old.persister.persistClient({ ...client, buster: "old session" });
    await vi.runAllTimersAsync();
    expect(await store.read()).toMatchObject({ buster: "fixture" });
  } finally {
    vi.useRealTimers();
  }
});
it("coalesces cache updates without writing serialized lists to localStorage", async () => {
  vi.useFakeTimers();
  try {
    const { storage, store, entries } = fixture();
    const cache = createPrivatePersister(storage, "coalesce", store);
    for (let timestamp = 1; timestamp <= 50; timestamp++)
      cache.persister.persistClient({ ...client, timestamp });
    await vi.runAllTimersAsync();
    expect(store.write).toHaveBeenCalledTimes(1);
    expect(await store.read()).toMatchObject({ timestamp: 50 });
    expect(entries.size).toBe(0);
  } finally {
    vi.useRealTimers();
  }
});
it("migrates the previous account cache and tolerates unavailable storage", async () => {
  const { storage, store, entries } = fixture();
  entries.set("legacy", JSON.stringify(client));
  const cache = createPrivatePersister(storage, "legacy", store);
  expect(await cache.persister.restoreClient()).toEqual(client);
  expect(entries.has("legacy")).toBe(false);
  const broken = createPrivatePersister(storage, "unavailable", {
    ...store,
    read: async () => {
      throw new Error("unavailable");
    },
  });
  expect(await broken.persister.restoreClient()).toBeUndefined();
});
it("clearing waits for an in-flight write and removes its result", async () => {
  vi.useFakeTimers();
  try {
    const { storage, store } = fixture();
    let finish: (() => void) | undefined;
    const held = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const write = store.write;
    store.write = async (value, allowed) => {
      await held;
      await write(value, allowed);
    };
    const cache = createPrivatePersister(storage, "pending", store);
    cache.persister.persistClient(client);
    await vi.advanceTimersByTimeAsync(500);
    const cleared = cache.clear();
    finish?.();
    await cleared;
    expect(await store.read()).toBeUndefined();
  } finally {
    vi.useRealTimers();
  }
});
it("an obsolete session clear cannot remove a new session's snapshot", async () => {
  vi.useFakeTimers();
  try {
    const { storage, store } = fixture();
    const old = createPrivatePersister(storage, "replaced", store);
    old.pause();
    const current = createPrivatePersister(storage, "replaced", store);
    current.persister.persistClient({ ...client, buster: "new session" });
    await vi.runAllTimersAsync();
    await old.clear();
    expect(await store.read()).toMatchObject({ buster: "new session" });
  } finally {
    vi.useRealTimers();
  }
});
it("retains only the latest snapshot while a slow write is in flight", async () => {
  vi.useFakeTimers();
  try {
    const { storage, store } = fixture();
    let release: (() => void) | undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const write = store.write;
    store.write = vi.fn(async (value, allowed) => {
      await held;
      await write(value, allowed);
    });
    const cache = createPrivatePersister(storage, "slow", store);
    cache.persister.persistClient(client);
    await vi.advanceTimersByTimeAsync(500);
    for (let timestamp = 2; timestamp <= 10; timestamp++) {
      cache.persister.persistClient({ ...client, timestamp });
      await vi.advanceTimersByTimeAsync(500);
    }
    expect(store.write).toHaveBeenCalledTimes(1);
    release?.();
    await vi.runAllTimersAsync();
    expect(store.write).toHaveBeenCalledTimes(2);
    expect(await store.read()).toMatchObject({ timestamp: 10 });
  } finally {
    vi.useRealTimers();
  }
});
it("builds one snapshot for a burst of cache updates and cancels queued saves on unsubscribe", async () => {
  vi.useFakeTimers();
  const cacheClient = new QueryClient();
  try {
    const save = vi.fn(async () => {});
    const unsubscribe = subscribePrivateCache(cacheClient, save);
    for (let index = 0; index < 50; index++) cacheClient.setQueryData(["page", index], { index });
    expect(save).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(500);
    expect(save).toHaveBeenCalledTimes(1);
    cacheClient.setQueryData(["later"], {});
    unsubscribe();
    await vi.runAllTimersAsync();
    expect(save).toHaveBeenCalledTimes(1);
  } finally {
    cacheClient.clear();
    vi.useRealTimers();
  }
});
