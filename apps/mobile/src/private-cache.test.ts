import { expect, it } from "vite-plus/test";
import { createPrivatePersister } from "./private-cache.ts";

it("removes an in-flight account write and refuses later writes after sign-out", async () => {
  const values = new Map<string, string>();
  let release: (() => void) | undefined;
  let entered: (() => void) | undefined;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const persistence = createPrivatePersister(
    {
      getItem: async (key) => values.get(key) ?? null,
      setItem: async (key, value) => {
        entered?.();
        await held;
        values.set(key, value);
      },
      removeItem: async (key) => {
        values.delete(key);
      },
    },
    "account-a",
  );
  const client = { timestamp: 1, buster: "test", clientState: { queries: [], mutations: [] } };
  const writing = persistence.persister.persistClient(client);
  await started;
  const clearing = persistence.clear();
  release?.();
  await Promise.all([writing, clearing]);
  await persistence.persister.persistClient(client);
  expect(values.has("account-a")).toBe(false);
  expect(await persistence.persister.restoreClient()).toBeUndefined();
});
