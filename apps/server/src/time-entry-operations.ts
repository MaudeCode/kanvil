import { and, count, desc, eq, isNull, ne } from "drizzle-orm";
import {
  assertVersion,
  assertWorkerClaim,
  can,
  fail,
  getTicket,
  one,
  project,
  publish,
  type Context,
  type Handlers,
} from "./domain.ts";
import { timeEntries } from "./schema.ts";

// Evidence supplies the attribution pattern; comments supply author/admin edits. An observed
// range needs mutable, versioned storage rather than an evidence outcome.
const withDuration = (row: typeof timeEntries.$inferSelect) => ({
  ...row,
  durationMs: row.endAt === null ? null : row.endAt.getTime() - row.startAt.getTime(),
});
async function entry(ctx: Context, input: { ticketId: string; timeEntryId: string }) {
  const ticket = await getTicket(ctx, input.ticketId);
  return one(
    await ctx.db
      .select()
      .from(timeEntries)
      .where(
        and(
          eq(timeEntries.projectId, project(ctx).id),
          eq(timeEntries.ticketId, ticket.id),
          eq(timeEntries.id, input.timeEntryId),
        ),
      ),
  );
}
async function editableEntry(
  ctx: Context,
  input: {
    ticketId: string;
    timeEntryId: string;
    expectedVersion: number;
    claimId?: string | undefined;
  },
) {
  const row = await entry(ctx, input);
  if (row.actorId !== ctx.actor.id && !can(ctx, "project.manage"))
    fail(403, "forbidden", "Only the author or a project administrator can edit this time entry");
  await assertWorkerClaim(ctx, await getTicket(ctx, row.ticketId), input.claimId);
  assertVersion(row, input.expectedVersion, "time entry");
  return row;
}
async function validateRange(
  ctx: Context,
  range: { ticketId: string; actorId: string; startAt: Date; endAt: Date | null; id?: string },
) {
  if (range.endAt !== null) {
    if (range.endAt < range.startAt)
      fail(400, "validation_error", "The end must be at or after the start");
    return;
  }
  const running = await ctx.db
    .select({ id: timeEntries.id })
    .from(timeEntries)
    .where(
      and(
        eq(timeEntries.ticketId, range.ticketId),
        eq(timeEntries.actorId, range.actorId),
        isNull(timeEntries.endAt),
        range.id ? ne(timeEntries.id, range.id) : undefined,
      ),
    )
    .limit(1);
  if (running.length)
    fail(409, "time_entry_conflict", "This actor already has a running entry on the ticket");
}
export const timeEntryHandlers: Pick<
  Handlers,
  | "list_time_entries"
  | "get_time_entry"
  | "create_time_entry"
  | "update_time_entry"
  | "delete_time_entry"
> = {
  async list_time_entries(ctx, input) {
    const ticket = await getTicket(ctx, input.ticketId),
      where = and(eq(timeEntries.projectId, project(ctx).id), eq(timeEntries.ticketId, ticket.id));
    return {
      items: (
        await ctx.db
          .select()
          .from(timeEntries)
          .where(where)
          .orderBy(desc(timeEntries.createdAt), desc(timeEntries.id))
          .limit(input.limit)
          .offset(input.offset)
      ).map(withDuration),
      total: one(await ctx.db.select({ count: count() }).from(timeEntries).where(where)).count,
    };
  },
  async get_time_entry(ctx, input) {
    return withDuration(await entry(ctx, input));
  },
  async create_time_entry(ctx, input) {
    const ticket = await getTicket(ctx, input.ticketId),
      range = {
        ticketId: ticket.id,
        actorId: ctx.actor.id,
        startAt: new Date(input.startAt),
        endAt: input.endAt === null ? null : new Date(input.endAt),
      };
    await assertWorkerClaim(ctx, ticket, input.claimId);
    await validateRange(ctx, range);
    const row = one(
      await ctx.db
        .insert(timeEntries)
        .values({ ...range, projectId: project(ctx).id, note: input.note })
        .returning(),
    );
    await publish(ctx, "time_entry.created", ticket.id, {
      timeEntryId: row.id,
      version: row.version,
    });
    return withDuration(row);
  },
  async update_time_entry(ctx, input) {
    const current = await editableEntry(ctx, input),
      range = {
        ...current,
        startAt: input.startAt === undefined ? current.startAt : new Date(input.startAt),
        endAt:
          input.endAt === undefined
            ? current.endAt
            : input.endAt === null
              ? null
              : new Date(input.endAt),
      };
    await validateRange(ctx, range);
    const row = one(
      await ctx.db
        .update(timeEntries)
        .set({
          startAt: range.startAt,
          endAt: range.endAt,
          note: input.note ?? current.note,
          version: current.version + 1,
          updatedAt: new Date(),
        })
        .where(eq(timeEntries.id, current.id))
        .returning(),
    );
    await publish(ctx, "time_entry.updated", row.ticketId, {
      timeEntryId: row.id,
      version: row.version,
    });
    return withDuration(row);
  },
  async delete_time_entry(ctx, input) {
    const current = await editableEntry(ctx, input);
    await ctx.db.delete(timeEntries).where(eq(timeEntries.id, current.id));
    await publish(ctx, "time_entry.deleted", current.ticketId, {
      timeEntryId: current.id,
      version: current.version,
    });
    return { ok: true };
  },
};
