import { and, asc, eq, getTableColumns, inArray, isNotNull, not, sql, type SQL } from "drizzle-orm";
import { epics, tickets } from "./schema.ts";
import { assertVersion, one, workspace, type Context, type Handlers } from "./domain.ts";
import { accessibleProjectRows } from "./project-access.ts";
import { labelOrder, openTicket, pageOf, summarize } from "./ticket-operations.ts";
import { publishWorkspace } from "./workspace-operations.ts";

// Tickets of the projects the caller can read in the context workspace.
async function inReadableProjects(ctx: Context) {
  const readable = await accessibleProjectRows(ctx.db, ctx.actor, workspace(ctx).id);
  return readable.length
    ? inArray(
        tickets.projectId,
        readable.map((row) => row.id),
      )
    : sql`false`;
}
const archivedFilter = (
  archived: "include" | "exclude" | "only",
  column: typeof epics.archived | typeof tickets.archived,
) => (archived === "include" ? undefined : eq(column, archived === "only"));
// Epics with rollups of their unarchived tickets in the projects the caller can read.
async function epicRollups(ctx: Context, where: SQL | undefined, limit = 1, offset = 0) {
  const rollup = ctx.db
    .select({
      epicId: tickets.epicId,
      open: sql<number>`count(*) FILTER (WHERE ${openTicket})`.as("open"),
      closed: sql<number>`count(*) FILTER (WHERE NOT (${openTicket}))`.as("closed"),
    })
    .from(tickets)
    .where(
      and(isNotNull(tickets.epicId), eq(tickets.archived, false), await inReadableProjects(ctx)),
    )
    .groupBy(tickets.epicId)
    .as("rollup");
  return ctx.db
    .select({
      ...getTableColumns(epics),
      openTickets: sql<number>`coalesce(${rollup.open}, 0)`.mapWith(Number),
      closedTickets: sql<number>`coalesce(${rollup.closed}, 0)`.mapWith(Number),
    })
    .from(epics)
    .leftJoin(rollup, eq(epics.id, rollup.epicId))
    .where(where)
    .orderBy(...labelOrder(epics.title), asc(epics.id))
    .limit(limit)
    .offset(offset);
}
const ownEpic = (ctx: Context, epicId: string) =>
  and(eq(epics.id, epicId), eq(epics.workspaceId, workspace(ctx).id));

export const epicHandlers: Pick<
  Handlers,
  "list_epics" | "get_epic" | "create_epic" | "update_epic" | "list_epic_tickets"
> = {
  async list_epics(ctx, input) {
    const where = and(
      eq(epics.workspaceId, workspace(ctx).id),
      archivedFilter(input.archived, epics.archived),
    );
    return {
      items: await epicRollups(ctx, where, input.limit, input.offset),
      total: await ctx.db.$count(epics, where),
    };
  },
  async get_epic(ctx, input) {
    return one(await epicRollups(ctx, ownEpic(ctx, input.epicId)));
  },
  async create_epic(ctx, input) {
    const epic = one(
      await ctx.db
        .insert(epics)
        .values({
          workspaceId: workspace(ctx).id,
          title: input.title,
          description: input.description,
          createdBy: ctx.actor.id,
        })
        .returning(),
    );
    // The title stays out of the feed, which direct project members read but Epics they cannot.
    await publishWorkspace(ctx, epic.workspaceId, "epic.created", {
      epicId: epic.id,
      version: epic.version,
    });
    return epic;
  },
  async update_epic(ctx, input) {
    const current = one(await ctx.db.select().from(epics).where(ownEpic(ctx, input.epicId)));
    assertVersion(current, input.expectedVersion, "Epic");
    const {
      workspaceId: _workspaceId,
      epicId: _epicId,
      expectedVersion: _version,
      requestId: _requestId,
      ...changes
    } = input;
    const epic = one(
      await ctx.db
        .update(epics)
        .set({ ...changes, version: current.version + 1, updatedAt: new Date() })
        .where(eq(epics.id, current.id))
        .returning(),
    );
    await publishWorkspace(ctx, epic.workspaceId, "epic.updated", {
      epicId: epic.id,
      version: epic.version,
      changedFields: Object.keys(changes),
    });
    return epic;
  },
  async list_epic_tickets(ctx, input) {
    const epic = one(await ctx.db.select().from(epics).where(ownEpic(ctx, input.epicId)));
    const members = and(
        eq(tickets.epicId, epic.id),
        archivedFilter(input.archived, tickets.archived),
      ),
      readable = await inReadableProjects(ctx);
    // Numbers repeat across projects, so creation order with the ID keeps pages stable.
    const page = await pageOf(
      ctx,
      and(members, readable),
      [asc(tickets.createdAt), asc(tickets.id)],
      input,
    );
    return {
      items: input.view === "summary" ? page.items.map(summarize) : page.items,
      total: page.total,
      restrictedCount: await ctx.db.$count(tickets, and(members, not(readable))),
    };
  },
};
