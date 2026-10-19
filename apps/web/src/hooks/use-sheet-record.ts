import { useState } from "react";

// The record a sheet shows: the selected one, or the last one while the closing sheet plays its
// exit. The sheet's root must stay mounted across selections, or it skips its entry and exit;
// key the content by `key(shown)` instead so each record starts fresh. Pass `settled` to the
// root's onOpenChangeComplete to drop the record once the sheet has closed.
export function useSheetRecord<T>(selected: T | null | undefined, key: (record: T) => string) {
  const [shown, setShown] = useState(selected ?? null);
  if (selected != null && (shown == null || key(selected) !== key(shown))) setShown(selected);
  return {
    shown: selected ?? shown,
    settled: (open: boolean) => {
      if (!open) setShown(null);
    },
  };
}
