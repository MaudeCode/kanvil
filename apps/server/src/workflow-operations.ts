import { and, asc, eq, getTableColumns, ne, sql } from "drizzle-orm";
import { defaultWorkflow, stateLabels, states, workflowOrder } from "@kanvil/contracts";
import { z } from "zod";
import { tickets, workflowStates } from "./schema.ts";
import {
  assertVersion,
  assertDefinitionMigration,
  fail,
  one,
  project,
  publish,
  publishMany,
  type Context,
  type Handlers,
} from "./domain.ts";
import { migrateTicketRow } from "./ticket-operations.ts";
import { reassignTransitions } from "./repository-operations.ts";

type Category = (typeof states)[number];
type State = typeof workflowStates.$inferSelect;
const category = z.enum(states);
// ponytail: a fixed cap keeps pickers short and the status sort's `rank * 1000 + position`
// unambiguous; raise both together if projects need more.
const stateLimit = 50;

function invalid(path: string, message: string): never {
  fail(400, "validation_error", message, [{ path, message }]);
}
export async function seedWorkflow(ctx: Context, projectId: string) {
  await ctx.db
    .insert(workflowStates)
    .values(defaultWorkflow.map((state) => ({ ...state, projectId, position: 0 })));
}
export async function projectStates(ctx: Context) {
  return (
    await ctx.db
      .select()
      .from(workflowStates)
      .where(eq(workflowStates.projectId, project(ctx).id))
  ).toSorted(workflowOrder);
}
async function findState(ctx: Context, stateId: string) {
  return (
    await ctx.db
      .select()
      .from(workflowStates)
      .where(and(eq(workflowStates.projectId, project(ctx).id), eq(workflowStates.id, stateId)))
  )[0];
}
// The one place a ticket write's `status` and `stateId` become a workflow state. A state names
// itself and must match a status written with it; a status alone keeps the ticket's state when the
// category is unchanged and otherwise takes the category's first state.
export async function resolveState(
  ctx: Context,
  write: { status?: Category | undefined; stateId?: string | undefined },
  current?: { status: string; stateId: string },
): Promise<{ status: Category; stateId: string } | undefined> {
  if (write.stateId !== undefined) {
    const state =
      (await findState(ctx, write.stateId)) ??
      invalid("stateId", "Choose a workflow state of this project");
    const status = category.parse(state.category);
    if (write.status !== undefined && write.status !== status)
      invalid(
        "status",
        `${state.name} is a ${stateLabels[status]} state; its status cannot be ${stateLabels[write.status]}`,
      );
    return { status, stateId: state.id };
  }
  if (write.status === undefined) return undefined;
  if (current?.status === write.status) return { status: write.status, stateId: current.stateId };
  const [first] = await ctx.db
    .select({ id: workflowStates.id })
    .from(workflowStates)
    .where(
      and(eq(workflowStates.projectId, project(ctx).id), eq(workflowStates.category, write.status)),
    )
    .orderBy(asc(workflowStates.position))
    .limit(1);
  // Every category keeps a state; this guards data edited outside the application.
  if (!first) invalid("status", `This project has no ${stateLabels[write.status]} state`);
  return { status: write.status, stateId: first.id };
}
async function getState(ctx: Context, stateId: string, expectedVersion: number) {
  const state = one(
    await ctx.db
      .select()
      .from(workflowStates)
      .where(and(eq(workflowStates.projectId, project(ctx).id), eq(workflowStates.id, stateId))),
  );
  assertVersion(state, expectedVersion, "workflow state", "saving");
  return state;
}
async function availableName(ctx: Context, name: string, exceptId?: string) {
  const [taken] = await ctx.db
    .select({ id: workflowStates.id })
    .from(workflowStates)
    .where(
      and(
        eq(workflowStates.projectId, project(ctx).id),
        sql`lower(${workflowStates.name}) = lower(${name})`,
        exceptId ? ne(workflowStates.id, exceptId) : undefined,
      ),
    );
  if (taken) fail(409, "duplicate_state", "A workflow state with this name already exists.");
}
// Every category keeps a state, so a client that writes only `status` always lands on one.
function assertNotLast(all: State[], state: State, action: string) {
  if (!all.some((other) => other.id !== state.id && other.category === state.category))
    fail(
      409,
      "last_state",
      `Add another ${stateLabels[category.parse(state.category)]} state before you ${action} ${state.name}`,
    );
}
// A slug from the name, unique within the project and never changed afterwards.
function slugFor(name: string, all: State[]) {
  const base =
    name
      .normalize("NFKD")
      .toLowerCase()
      .replaceAll(/[^a-z0-9]+/g, "_")
      .replaceAll(/^_+|_+$/g, "")
      .slice(0, 40) || "state";
  const taken = new Set(all.map((state) => state.slug));
  let slug = base;
  for (let suffix = 2; taken.has(slug); suffix += 1) slug = `${base}_${suffix}`;
  return slug;
}
// Numbers a category's states 0, 1, 2… in the given order. A state whose place changes gets a new
// version, so a move based on the old order is refused.
async function renumber(ctx: Context, ordered: State[]) {
  for (const [position, state] of ordered.entries())
    if (state.position !== position)
      await ctx.db
        .update(workflowStates)
        .set({ position, version: state.version + 1 })
        .where(eq(workflowStates.id, state.id));
}

export const workflowHandlers: Pick<
  Handlers,
  | "list_workflow_states"
  | "create_workflow_state"
  | "update_workflow_state"
  | "delete_workflow_state"
> = {
  async list_workflow_states(ctx) {
    return (
      await ctx.db
        .select({
          ...getTableColumns(workflowStates),
          count:
            sql<number>`(SELECT count(*) FROM tickets WHERE tickets.state_id = workflow_states.id)`.mapWith(
              Number,
            ),
        })
        .from(workflowStates)
        .where(eq(workflowStates.projectId, project(ctx).id))
    ).toSorted(workflowOrder);
  },
  async create_workflow_state(ctx, input) {
    const all = await projectStates(ctx);
    if (all.length >= stateLimit)
      invalid("name", `A project can have up to ${stateLimit} workflow states`);
    await availableName(ctx, input.name);
    const row = one(
      await ctx.db
        .insert(workflowStates)
        .values({
          projectId: project(ctx).id,
          slug: slugFor(input.name, all),
          name: input.name,
          category: input.category,
          color: input.color,
          position: all.filter((state) => state.category === input.category).length,
        })
        .returning(),
    );
    await publish(ctx, "workflow.created", null, { stateId: row.id, version: row.version });
    return row;
  },
  async update_workflow_state(ctx, input) {
    const current = await getState(ctx, input.stateId, input.expectedVersion);
    if (input.name !== undefined) await availableName(ctx, input.name, current.id);
    const all = await projectStates(ctx),
      next = input.category ?? category.parse(current.category),
      moving = next !== current.category;
    if (moving) assertNotLast(all, current, "move");
    const siblings = all.filter((state) => state.category === next && state.id !== current.id),
      at = Math.min(
        input.position ?? (moving ? siblings.length : current.position),
        siblings.length,
      );
    // The tickets in a recategorized state change status under the definition migration policy.
    const held = moving
      ? await ctx.db.select().from(tickets).where(eq(tickets.stateId, current.id))
      : [];
    await assertDefinitionMigration(ctx, held);
    const row = one(
      await ctx.db
        .update(workflowStates)
        .set({
          ...(input.name === undefined ? {} : { name: input.name }),
          ...(input.color === undefined ? {} : { color: input.color }),
          category: next,
          position: at,
          version: current.version + 1,
        })
        .where(eq(workflowStates.id, current.id))
        .returning(),
    );
    await renumber(ctx, siblings.toSpliced(at, 0, row));
    if (moving)
      await renumber(
        ctx,
        all.filter((state) => state.category === current.category && state.id !== current.id),
      );
    // The foreign key already carried the new category into each ticket's status.
    const moved = held.length
      ? await ctx.db
          .update(tickets)
          .set({ version: sql`${tickets.version} + 1`, updatedAt: new Date() })
          .where(eq(tickets.stateId, current.id))
          .returning()
      : [];
    await publishMany(ctx, [
      ...moved.map((ticket) => ({
        type: "ticket.updated",
        ticketId: ticket.id,
        data: { version: ticket.version, changedFields: ["status"] },
      })),
      { type: "workflow.updated", ticketId: null, data: { stateId: row.id, version: row.version } },
    ]);
    return row;
  },
  async delete_workflow_state(ctx, input) {
    const current = await getState(ctx, input.stateId, input.expectedVersion);
    if (input.reassignTo === current.id)
      invalid("reassignTo", "Move the tickets to another workflow state");
    const target =
      (await findState(ctx, input.reassignTo)) ??
      invalid("reassignTo", "Choose a workflow state of this project");
    const all = await projectStates(ctx);
    assertNotLast(all, current, "delete");
    // Each ticket moves through the shared versioned write under the definition migration policy.
    const held = await ctx.db.select().from(tickets).where(eq(tickets.stateId, current.id));
    const pending = [];
    for (const ticket of held)
      pending.push(
        (
          await migrateTicketRow(ctx, {
            ticketId: ticket.id,
            expectedVersion: ticket.version,
            changes: { stateId: target.id },
          })
        ).event,
      );
    await reassignTransitions(ctx, current.id, target.id);
    await ctx.db.delete(workflowStates).where(eq(workflowStates.id, current.id));
    await renumber(
      ctx,
      all.filter((state) => state.category === current.category && state.id !== current.id),
    );
    await publishMany(ctx, [
      ...pending,
      {
        type: "workflow.deleted",
        ticketId: null,
        data: { stateId: current.id, reassignTo: target.id },
      },
    ]);
    return { ok: true };
  },
};
