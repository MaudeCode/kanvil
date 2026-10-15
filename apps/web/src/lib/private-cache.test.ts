import { expect, it, vi } from "vite-plus/test";
import { createPrivatePersister } from "./private-cache.ts";
it("prevents queued writes from restoring an account cache after sign-out", async () => {
  vi.useFakeTimers();
  try {
    const entries = new Map<string, string>(),
      storage = {
        getItem: (key: string) => entries.get(key) ?? null,
        setItem: (key: string, value: string) => {
          entries.set(key, value);
        },
        removeItem: (key: string) => {
          entries.delete(key);
        },
      },
      client = { timestamp: 1, buster: "fixture", clientState: { queries: [], mutations: [] } },
      old = createPrivatePersister(storage, "account");
    old.persister.persistClient(client);
    old.pause();
    storage.removeItem("account");
    await vi.runAllTimersAsync();
    expect(entries.has("account")).toBe(false);
    const current = createPrivatePersister(storage, "account");
    current.persister.persistClient(client);
    await vi.runAllTimersAsync();
    expect(entries.has("account")).toBe(true);
    old.persister.removeClient();
    old.persister.persistClient({ ...client, buster: "old session" });
    await vi.runAllTimersAsync();
    expect(JSON.parse(entries.get("account") ?? "{}")).toMatchObject({ buster: "fixture" });
  } finally {
    vi.useRealTimers();
  }
});
