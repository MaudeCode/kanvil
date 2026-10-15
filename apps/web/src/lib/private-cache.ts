import { createSyncStoragePersister } from "@tanstack/query-sync-storage-persister";
// The library's queued writes cannot be cancelled, so session cleanup must also revoke their storage access.
export function createPrivatePersister(
  storage: Pick<Storage, "getItem" | "setItem" | "removeItem">,
  key: string,
) {
  let enabled = true;
  const persister = createSyncStoragePersister({
    key,
    storage: {
      getItem: (name) => storage.getItem(name),
      setItem: (name, value) => {
        if (enabled) storage.setItem(name, value);
      },
      removeItem: (name) => {
        if (enabled) storage.removeItem(name);
      },
    },
  });
  return {
    persister,
    pause: () => {
      enabled = false;
    },
    resume: () => {
      enabled = true;
    },
  };
}
