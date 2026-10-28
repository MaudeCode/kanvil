import type { QueryClient } from "@tanstack/react-query";
import type { PersistedClient, Persister } from "@tanstack/react-query-persist-client";

export interface PrivateCacheStore {
  read: () => Promise<PersistedClient | undefined>;
  write: (client: PersistedClient, allowed: () => boolean) => Promise<void>;
  remove: () => Promise<void>;
}
let database: Promise<IDBDatabase> | undefined;
const open = () =>
  (database ??= new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open("kanvil-private-cache", 1);
    request.addEventListener("upgradeneeded", () => request.result.createObjectStore("clients"));
    request.addEventListener("success", () => resolve(request.result));
    request.addEventListener("error", () => {
      database = undefined;
      reject(request.error);
    });
  }));
async function transact<T>(
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore) => IDBRequest<T>,
  allowed = () => true,
): Promise<T | undefined> {
  const db = await open();
  if (!allowed()) return undefined;
  return new Promise((resolve, reject) => {
    const tx = db.transaction("clients", mode);
    const request = run(tx.objectStore("clients"));
    tx.addEventListener("complete", () => resolve(request.result));
    tx.addEventListener("abort", () => reject(tx.error));
    tx.addEventListener("error", () => reject(tx.error));
  });
}
function indexedCache(key: string): PrivateCacheStore {
  return {
    read: () => transact<PersistedClient | undefined>("readonly", (store) => store.get(key)),
    write: async (client, allowed) => {
      await transact("readwrite", (store) => store.put(client, key), allowed);
    },
    remove: async () => {
      await transact("readwrite", (store) => store.delete(key));
    },
  };
}
const generations = new Map<string, symbol>();
// Extends the account persister with structured-clone storage and fenced, coalesced writes.
export function createPrivatePersister(
  storage: Pick<Storage, "getItem" | "setItem" | "removeItem">,
  key: string,
  store: PrivateCacheStore = indexedCache(key),
) {
  let enabled = true;
  let token = Symbol(key);
  generations.set(key, token);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let pending: PersistedClient | undefined;
  let writing = Promise.resolve();
  let busy = false;
  const allowed = () => enabled && generations.get(key) === token;
  const cancel = () => {
    clearTimeout(timer);
    timer = undefined;
    pending = undefined;
  };
  const persister: Persister = {
    persistClient: (client) => {
      if (!allowed()) return;
      pending = client;
      if (timer || busy) return;
      timer = setTimeout(() => {
        timer = undefined;
        const next = pending;
        const writeToken = token;
        const canWrite = () => allowed() && token === writeToken;
        pending = undefined;
        if (!next) return;
        busy = true;
        writing = writing
          .then(async () => {
            if (canWrite()) await store.write(next, canWrite);
          })
          .catch(() => {}) // An unavailable cache must not prevent live reading.
          .finally(() => {
            busy = false;
            if (pending && allowed()) persister.persistClient(pending);
          });
      }, 500);
    },
    restoreClient: async () => {
      try {
        const saved = await store.read();
        if (saved || !allowed()) return allowed() ? saved : undefined;
        // One-time migration of the previous account cache; new writes never serialize JSON.
        const legacy = storage.getItem(key);
        if (!legacy) return undefined;
        const client: PersistedClient = JSON.parse(legacy);
        await store.write(client, allowed);
        if (!allowed()) return undefined;
        storage.removeItem(key);
        return client;
      } catch {
        return undefined;
      }
    },
    removeClient: async () => {
      if (!allowed()) return;
      cancel();
      await writing;
      if (!allowed()) return;
      storage.removeItem(key);
      await store.remove().catch(() => {});
    },
  };
  return {
    persister,
    pause: () => {
      enabled = false;
      cancel();
    },
    resume: () => {
      enabled = true;
      token = Symbol(key);
      generations.set(key, token);
    },
    clear: async () => {
      const clearing = token;
      enabled = false;
      cancel();
      await writing;
      if (generations.get(key) !== clearing) return;
      storage.removeItem(key);
      await store.remove().catch(() => {});
    },
  };
}

// Coalesce before dehydrate, rather than merely delaying already-built whole-cache snapshots.
export function subscribePrivateCache(client: QueryClient, save: () => void | Promise<void>) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const unsubscribe = client.getQueryCache().subscribe((event) => {
    if (event.type !== "added" && event.type !== "removed" && event.type !== "updated") return;
    if (timer) return;
    timer = setTimeout(() => {
      timer = undefined;
      void Promise.resolve()
        .then(save)
        .catch(() => {});
    }, 500);
  });
  return () => {
    unsubscribe();
    clearTimeout(timer);
  };
}
