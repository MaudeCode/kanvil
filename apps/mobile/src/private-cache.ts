import { createAsyncStoragePersister } from "@tanstack/query-async-storage-persister";
import { ApiError } from "@kanvil/contracts";
import type { Query } from "@tanstack/react-query";

export function shouldPersistQuery(query: Query) {
  if (query.queryKey[0] !== "kanvil" || query.state.data === undefined) return false;
  const { status, error } = query.state;
  // A failed background read retains its last successful data in memory. Keep that
  // snapshot across offline relaunches too, but never retain rejected access.
  return (
    status === "success" ||
    (status === "error" && (!(error instanceof ApiError) || error.status >= 500))
  );
}

// Native counterpart of web's private persister: AsyncStorage writes can still be in flight
// when sign-out unmounts the account. Pause first and drain them before removing private data.
export function createPrivatePersister(
  storage: {
    getItem: (key: string) => Promise<string | null>;
    setItem: (key: string, value: string) => Promise<unknown>;
    removeItem: (key: string) => Promise<unknown>;
  },
  key: string,
) {
  let paused = false;
  let writes = Promise.resolve();
  const base = createAsyncStoragePersister({
    key,
    throttleTime: 0,
    storage: {
      getItem: storage.getItem,
      removeItem: async (itemKey) => {
        await storage.removeItem(itemKey);
      },
      setItem: (itemKey, value) => {
        const write = writes.then(async () => {
          if (paused) return;
          await storage.setItem(itemKey, value);
          if (paused) await storage.removeItem(itemKey);
        });
        writes = write.catch(() => {});
        return write;
      },
    },
  });
  return {
    pause: () => {
      paused = true;
    },
    clear: async () => {
      paused = true;
      await writes;
      await storage.removeItem(key);
    },
    persister: {
      persistClient: (client: Parameters<typeof base.persistClient>[0]) =>
        paused ? Promise.resolve() : base.persistClient(client),
      restoreClient: async () => {
        const client = await base.restoreClient();
        return paused ? undefined : client;
      },
      removeClient: base.removeClient,
    },
  };
}
