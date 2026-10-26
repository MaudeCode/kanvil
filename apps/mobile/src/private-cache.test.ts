import { expect, it } from "vite-plus/test";
import { createPrivatePersister } from "./private-cache.ts";
import { shouldPersistQuery } from "./private-cache.ts";
import { ApiError } from "@kanvil/contracts";
import { dehydrate, hydrate, QueryClient } from "@tanstack/react-query";

it("restores cached pages after a network failure without retaining rejected access", async () => {
  for (const error of [
    new TypeError("Network request failed"),
    new Error("fetch failed: The Internet connection appears to be offline."),
    new ApiError(503, "unavailable", "Unavailable"),
    new ApiError(401, "unauthorized", "Sign in"),
    new ApiError(403, "forbidden", "Access removed"),
    new ApiError(404, "not_found", "Removed"),
  ]) {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const queryKey = ["kanvil", "list_projects"];
    client.setQueryData(queryKey, [{ id: "project-a" }]);
    client.setQueryData(["other-account-data"], ["private"]);
    await expect(
      client.fetchQuery({ queryKey, queryFn: () => Promise.reject(error) }),
    ).rejects.toBe(error);
    const restored = new QueryClient();
    hydrate(restored, dehydrate(client, { shouldDehydrateQuery: shouldPersistQuery }));
    expect(restored.getQueryData(queryKey)).toEqual(
      !(error instanceof ApiError) || error.status >= 500 ? [{ id: "project-a" }] : undefined,
    );
    expect(restored.getQueryData(["other-account-data"])).toBeUndefined();
    client.clear();
    restored.clear();
  }
});

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
