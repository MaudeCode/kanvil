import { z } from "zod";

// The ticket list remembers the order it last showed per project, so the detail page can offer
// previous and next in that same order. Session-scoped: it belongs to this tab's reading.
const key = (projectId: string) => `kanvil:list-order:${projectId}`;
export function writeListOrder(projectId: string, ids: string[]) {
  try {
    sessionStorage.setItem(key(projectId), JSON.stringify(ids));
  } catch {
    /* Navigation works without storage. */
  }
}
export function readListOrder(projectId: string): string[] {
  try {
    return z.array(z.string()).parse(JSON.parse(sessionStorage.getItem(key(projectId)) ?? "[]"));
  } catch {
    return [];
  }
}
// Manual order on screen: tickets in a section and projects in the sidebar. The server keeps the
// order; these place an item the way a confirmed move will, so the list can show it at once.
export function placeNear<T extends { id: string }>(
  list: T[],
  id: string,
  anchor: string,
  below: boolean,
): T[] {
  const moved = list.find((item) => item.id === id),
    rest = list.filter((item) => item.id !== id),
    at = rest.findIndex((item) => item.id === anchor);
  return moved && at >= 0 ? rest.toSpliced(below ? at + 1 : at, 0, moved) : list;
}
// The neighbor a top, up, down, or bottom move places an item next to, among `ids` as displayed;
// nothing when the item is already there.
export function neighborFor(
  ids: string[],
  id: string,
  command: "top" | "up" | "down" | "bottom",
): { anchor: string; below: boolean } | undefined {
  const index = ids.indexOf(id);
  if (index < 0) return undefined;
  const below = command === "down" || command === "bottom",
    target = { top: 0, up: index - 1, down: index + 1, bottom: ids.length - 1 }[command],
    anchor = ids[target];
  return anchor !== undefined && target !== index ? { anchor, below } : undefined;
}
