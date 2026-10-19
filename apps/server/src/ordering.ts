import { and, asc, desc, eq, gt, lt, ne, sql, type AnyColumn, type SQL } from "drizzle-orm";
import type { PgTable } from "drizzle-orm/pg-core";
import { customFields, projects, tickets } from "./schema.ts";
import { fail, type Context } from "./domain.ts";

// Manual order: tickets and custom fields within a project and projects within a workspace each
// carry a `position`. Callers name a neighbor, never a number. A move takes the midpoint between
// the neighbor and the next item of the scope; only when no integer is left between them is the
// scope renumbered, which keeps every item's relative order and changes no version.
const gap = 1024;
interface Order {
  table: PgTable;
  id: AnyColumn;
  position: AnyColumn;
  // Breaks ties when renumbering.
  tiebreak: AnyColumn;
  // The items that share an order with the given one.
  scope: (id: string) => SQL;
}
export const ticketPositions: Order = {
  table: tickets,
  id: tickets.id,
  position: tickets.position,
  tiebreak: tickets.number,
  scope: (id) =>
    eq(tickets.projectId, sql`(SELECT project_id FROM tickets WHERE id = ${id}::uuid)`),
};
export const projectPositions: Order = {
  table: projects,
  id: projects.id,
  position: projects.position,
  tiebreak: projects.name,
  scope: (id) =>
    eq(projects.workspaceId, sql`(SELECT workspace_id FROM projects WHERE id = ${id}::uuid)`),
};
export const customFieldPositions: Order = {
  table: customFields,
  id: customFields.id,
  position: customFields.position,
  tiebreak: customFields.name,
  scope: (id) =>
    eq(customFields.projectId, sql`(SELECT project_id FROM custom_fields WHERE id = ${id}::uuid)`),
};
// The position after every item matching `scope`, for a new item.
export const endPosition = (order: Order, scope: SQL) =>
  sql<number>`(SELECT coalesce(max(${order.position}), 0) + ${gap} FROM ${order.table} WHERE ${scope})`;
async function edge(ctx: Context, order: Order, where: SQL | undefined, last: boolean) {
  const [row] = await ctx.db
    .select({ position: sql<number>`${order.position}`.mapWith(Number) })
    .from(order.table)
    .where(where)
    .orderBy(last ? desc(order.position) : asc(order.position))
    .limit(1);
  return row?.position;
}
// The position that puts `itemId` directly before or after `anchorId` in their shared order.
export async function positionNear(
  ctx: Context,
  order: Order,
  itemId: string,
  anchorId: string,
  side: "before" | "after",
) {
  for (let attempt = 0; attempt < 2; attempt++) {
    // Zero is a valid position, so this cannot use requireRow.
    const anchor = await edge(ctx, order, eq(order.id, anchorId), false);
    if (anchor === undefined) fail(404, "not_found", "The requested record was not found");
    const neighbor = await edge(
      ctx,
      order,
      and(
        order.scope(anchorId),
        ne(order.id, itemId),
        side === "before" ? lt(order.position, anchor) : gt(order.position, anchor),
      ),
      side === "before",
    );
    if (neighbor === undefined) return side === "before" ? anchor - gap : anchor + gap;
    if (Math.abs(anchor - neighbor) >= 2) return Math.floor((anchor + neighbor) / 2);
    await ctx.db.execute(sql`UPDATE ${order.table} SET position = ordered.rank * ${gap}
      FROM (SELECT id, row_number() OVER (ORDER BY position, ${sql.identifier(order.tiebreak.name)}) AS rank
        FROM ${order.table} WHERE ${order.scope(anchorId)}) AS ordered
      WHERE ${order.table}.id = ordered.id`);
  }
  throw new Error("Renumbering left no room between neighbors");
}
