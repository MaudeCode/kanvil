import {
  and,
  asc,
  eq,
  getTableColumns,
  inArray,
  isNotNull,
  isNull,
  not,
  sql,
  type SQL,
} from "drizzle-orm";
import { epics, epicComments, tickets, workspaceMembers } from "./schema.ts";
import { assertVersion, can, fail, one, workspace, type Context, type Handlers } from "./domain.ts";
import { accessibleProjectRows } from "./project-access.ts";
import { labelOrder, openTicket, pageOf, summarize } from "./ticket-operations.ts";
import { user } from "./auth-schema.ts";
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

async function validateAssignee(ctx: Context, assigneeId: string | null | undefined) {
  if (!assigneeId) return;
  const member = (
    await ctx.db
      .select({ id: user.id })
      .from(workspaceMembers)
      .innerJoin(user, eq(user.id, workspaceMembers.userId))
      .where(
        and(
          eq(workspaceMembers.workspaceId, workspace(ctx).id),
          eq(user.id, assigneeId),
          isNull(user.deletedAt),
          sql`NOT coalesce(${user.banned}, false)`,
        ),
      )
  )[0];
  if (!member) fail(400, "invalid_assignee", "Assign an active workspace member");
}
async function editableComment(
  ctx: Context,
  input: { epicId: string; commentId: string; expectedVersion: number },
) {
  const row = one(
    await ctx.db
      .select()
      .from(epicComments)
      .where(
        and(
          eq(epicComments.workspaceId, workspace(ctx).id),
          eq(epicComments.epicId, input.epicId),
          eq(epicComments.id, input.commentId),
        ),
      ),
  );
  if (row.actorId !== ctx.actor.id && !can(ctx, "workspace.manage"))
    fail(403, "forbidden", "Only the author or a workspace administrator can edit this comment");
  assertVersion(row, input.expectedVersion, "comment");
  return row;
}
async function commentEvent(ctx: Context, row: { id: string; epicId: string }, change: string) {
  await publishWorkspace(ctx, workspace(ctx).id, "epic.updated", {
    epicId: row.epicId,
    commentId: row.id,
    changedFields: ["comments"],
    change,
  });
}

export const epicHandlers: Pick<
  Handlers,
  | "list_epics"
  | "get_epic"
  | "create_epic"
  | "update_epic"
  | "list_epic_tickets"
  | "list_epic_comments"
  | "add_epic_comment"
  | "update_epic_comment"
  | "delete_epic_comment"
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
    await validateAssignee(ctx, input.assigneeId);
    const epic = one(
      await ctx.db
        .insert(epics)
        .values({
          workspaceId: workspace(ctx).id,
          title: input.title,
          description: input.description,
          acceptanceCriteria: input.acceptanceCriteria,
          status: input.status,
          priority: input.priority,
          assigneeId: input.assigneeId,
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
    await validateAssignee(ctx, input.assigneeId);
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
  async list_epic_comments(ctx, input) {
    one(await ctx.db.select({ id: epics.id }).from(epics).where(ownEpic(ctx, input.epicId)));
    const where = and(
      eq(epicComments.workspaceId, workspace(ctx).id),
      eq(epicComments.epicId, input.epicId),
    );
    return {
      items: await ctx.db
        .select()
        .from(epicComments)
        .where(where)
        .orderBy(asc(epicComments.createdAt), asc(epicComments.id))
        .limit(input.limit)
        .offset(input.offset),
      total: await ctx.db.$count(epicComments, where),
    };
  },
  async add_epic_comment(ctx, input) {
    one(await ctx.db.select({ id: epics.id }).from(epics).where(ownEpic(ctx, input.epicId)));
    const row = one(
      await ctx.db
        .insert(epicComments)
        .values({
          workspaceId: workspace(ctx).id,
          epicId: input.epicId,
          actorId: ctx.actor.id,
          body: input.body,
        })
        .returning(),
    );
    await commentEvent(ctx, row, "created");
    return row;
  },
  async update_epic_comment(ctx, input) {
    const current = await editableComment(ctx, input);
    const row = one(
      await ctx.db
        .update(epicComments)
        .set({ body: input.body, version: current.version + 1, updatedAt: new Date() })
        .where(eq(epicComments.id, current.id))
        .returning(),
    );
    await commentEvent(ctx, row, "updated");
    return row;
  },
  async delete_epic_comment(ctx, input) {
    const current = await editableComment(ctx, input);
    await ctx.db.delete(epicComments).where(eq(epicComments.id, current.id));
    await commentEvent(ctx, current, "deleted");
    return { ok: true };
  },
};
