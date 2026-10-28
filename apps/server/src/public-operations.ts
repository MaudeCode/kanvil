import { and, eq, inArray } from "drizzle-orm";
import {
  operations,
  parseOutput,
  type PublicOperation,
  type publicOperations,
} from "@kanvil/contracts";
import type { z } from "zod";
import { tickets } from "./schema.ts";
import { fail, getTicket, json, one, project, type Context } from "./domain.ts";
import { ticketHandlers } from "./ticket-operations.ts";
import { collaborationHandlers } from "./collaboration-operations.ts";
import { workflowHandlers } from "./workflow-operations.ts";
import { labelHandlers } from "./label-operations.ts";

type PublicHandlers = {
  [K in PublicOperation]: (
    ctx: Context,
    input: z.output<(typeof publicOperations)[K]["input"]>,
  ) => Promise<unknown>;
};
// Each public read runs the member read it projects, with input that passed the member
// operation's own schema; the public output schema then drops every field it does not name.
const listTickets = async (
  ctx: Context,
  input: Partial<z.input<typeof operations.list_tickets.input>>,
) =>
  parseOutput<"list_tickets", { view: "full" }>(
    "list_tickets",
    json(
      await ticketHandlers.list_tickets(
        ctx,
        operations.list_tickets.input.parse({ ...input, projectId: project(ctx).id, view: "full" }),
      ),
    ),
  );
// The IDs among `ids` that are published: tickets of the project that are not archived.
async function published(ctx: Context, ids: string[]) {
  if (!ids.length) return new Set<string>();
  const rows = await ctx.db
    .select({ id: tickets.id })
    .from(tickets)
    .where(
      and(
        eq(tickets.projectId, project(ctx).id),
        eq(tickets.archived, false),
        inArray(tickets.id, ids),
      ),
    );
  return new Set(rows.map((row) => row.id));
}
// A parent reference survives only while the parent itself is published.
async function withPublishedParents<T extends { parentId: string | null }>(
  ctx: Context,
  rows: T[],
) {
  const visible = await published(
    ctx,
    rows.flatMap((row) => (row.parentId ? [row.parentId] : [])),
  );
  return rows.map((row) =>
    row.parentId && !visible.has(row.parentId) ? { ...row, parentId: null } : row,
  );
}
export const publicHandlers: PublicHandlers = {
  async get_public_project(ctx) {
    const projectId = project(ctx).id;
    // The catalog includes workspace labels; publish only those the published tickets carry.
    const used = new Set(
      parseOutput(
        "list_ticket_labels",
        await ticketHandlers.list_ticket_labels(ctx, { projectId, archived: "exclude" }),
      ).map((label) => label.name),
    );
    return {
      ...project(ctx),
      states: await workflowHandlers.list_workflow_states(ctx, { projectId }),
      labels: parseOutput(
        "list_project_labels",
        await labelHandlers.list_project_labels(ctx, { projectId }),
      ).filter((label) => used.has(label.name)),
    };
  },
  async list_public_tickets(ctx, input) {
    const page = await listTickets(ctx, {
      sort: "status",
      order: "asc",
      limit: input.limit,
      offset: input.offset,
    });
    return { ...page, items: await withPublishedParents(ctx, page.items) };
  },
  async get_public_ticket(ctx, input) {
    const ticket = await getTicket(ctx, input.ticketId);
    if (ticket.archived) fail(404, "not_found", "The requested record was not found");
    // Every unarchived child, read in bounded pages.
    const children = [];
    for (let total = Infinity; children.length < total;) {
      const page = await listTickets(ctx, {
        parentId: ticket.id,
        sort: "number",
        limit: 100,
        offset: children.length,
      });
      children.push(...page.items);
      total = page.items.length ? page.total : children.length;
    }
    const relations = parseOutput(
      "list_relations",
      json(
        await collaborationHandlers.list_relations(ctx, {
          projectId: ticket.projectId,
          ticketId: ticket.id,
        }),
      ),
    );
    const visible = await published(ctx, [
      ...(ticket.parentId ? [ticket.parentId] : []),
      ...relations.map((relation) =>
        relation.sourceId === ticket.id ? relation.targetId : relation.sourceId,
      ),
    ]);
    const parent =
      ticket.parentId && visible.has(ticket.parentId)
        ? one(await ctx.db.select().from(tickets).where(eq(tickets.id, ticket.parentId)))
        : null;
    return {
      ticket: parent ? ticket : { ...ticket, parentId: null },
      parent,
      children,
      relations: relations.filter((relation) =>
        visible.has(relation.sourceId === ticket.id ? relation.targetId : relation.sourceId),
      ),
    };
  },
};
