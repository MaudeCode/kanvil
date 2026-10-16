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
