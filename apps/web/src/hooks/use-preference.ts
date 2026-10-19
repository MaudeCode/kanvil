import { useCallback, useMemo, useSyncExternalStore } from "react";
import { z } from "zod";
import { useIdentity } from "../data.tsx";
import {
  ticketDensitySchema,
  ticketGroupingSchema,
  ticketLabelDisplaySchema,
  ticketLayoutSchema,
  workGroupingSchema,
} from "../search.ts";

type Preference<T> = { name: string; schema: z.ZodType<T> };
const preference = <T>(name: string, schema: z.ZodType<T>): Preference<T> => ({ name, schema });
const defaultColumns: Record<string, boolean> = {
  kind: false,
  scopes: false,
  assigneeId: false,
  createdAt: false,
  updatedAt: false,
};
// Personal browser preferences. Keys live under the user's `kanvil:<id>:` prefix, so sign-out
// clears them, and every reader of one key updates together in this tab and in others.
export const preferences = {
  density: preference("ticket-density", ticketDensitySchema.catch("compact")),
  labelDisplay: preference("ticket-label-display", ticketLabelDisplaySchema.catch("compact")),
  grouping: preference("ticket-grouping", ticketGroupingSchema.catch("status")),
  layout: preference("ticket-layout", ticketLayoutSchema.catch("list")),
  backgrounds: preference("project-backgrounds", z.enum(["show", "hide"]).catch("show")),
  workGrouping: preference("work-grouping", workGroupingSchema.catch("due")),
  columns: preference(
    "ticket-columns",
    z
      .record(z.string(), z.boolean())
      .transform((saved) => ({ ...defaultColumns, ...saved }))
      .catch(defaultColumns),
  ),
  weekStart: preference("week-start", z.enum(["sunday", "monday", "saturday"]).catch("sunday")),
  sidebar: preference("sidebar", z.enum(["last", "expanded", "collapsed"]).catch("last")),
};
// Day-picker indexes for each week start choice.
export const weekStarts = { sunday: 0, monday: 1, saturday: 6 } as const;
export const ticketDisplayPreferences = [
  preferences.density,
  preferences.labelDisplay,
  preferences.grouping,
  preferences.layout,
  preferences.backgrounds,
  preferences.workGrouping,
  preferences.columns,
];

const listeners = new Set<() => void>();
function subscribe(listener: () => void) {
  listeners.add(listener);
  window.addEventListener("storage", listener);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", listener);
  };
}
function read(key: string) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
// Values written before this store held bare strings; read those as they are.
function decode(raw: string | null): unknown {
  if (raw === null) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}
function update(change: () => void) {
  try {
    change();
  } catch {
    /* Without storage, preferences keep their defaults. */
  }
  for (const listener of listeners) listener();
}
export function usePreference<T>({ name, schema }: Preference<T>) {
  const key = `kanvil:${useIdentity().id}:${name}`,
    raw = useSyncExternalStore(subscribe, () => read(key));
  const value = useMemo(() => schema.parse(decode(raw)), [schema, raw]);
  const set = useCallback(
    (next: T) => update(() => localStorage.setItem(key, JSON.stringify(next))),
    [key],
  );
  return [value, set] as const;
}
export function resetPreferences(userId: string, list: Preference<unknown>[]) {
  update(() => {
    for (const { name } of list) localStorage.removeItem(`kanvil:${userId}:${name}`);
  });
}
