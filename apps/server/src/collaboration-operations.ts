import { decodeBlobData } from "./blob-storage.ts";
import { attachmentLimit } from "@kanvil/contracts";
import { and, asc, count, desc, eq, getTableColumns, inArray, isNull, or } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import {
  attachments,
  comments,
  events,
  evidence,
  relations,
  subscriptions,
  notifications,
  pushDeliveries,
  tickets,
} from "./schema.ts";
import { assertNoCycle } from "./ticket-operations.ts";
import {
  assertVersion,
  assertWorkerClaim,
  fail,
  getTicket,
  project,
  publish,
  requireRow,
  type Context,
  type Handlers,
  one,
} from "./domain.ts";
const sourceTicket = alias(tickets, "source_ticket"),
  targetTicket = alias(tickets, "target_ticket");

async function editableComment(ctx: Context, commentId: string, expectedVersion: number) {
  const row = one(
    await ctx.db
      .select()
      .from(comments)
      .where(and(eq(comments.projectId, project(ctx).id), eq(comments.id, commentId))),
  );
  if (row.actorId !== ctx.actor.id && ctx.role !== "admin")
    fail(403, "forbidden", "Only the author or a project administrator can edit this comment");
  assertVersion(row, expectedVersion, "comment");
  return row;
}
async function publishRelation(
  ctx: Context,
  type: "relation.added" | "relation.removed",
  relation: typeof relations.$inferSelect,
) {
  for (const ticketId of [relation.sourceId, relation.targetId])
    await publish(ctx, type, ticketId, { relation });
}
export const collaborationHandlers: Pick<
  Handlers,
  | "list_relations"
  | "add_relation"
  | "remove_relation"
  | "list_comments"
  | "add_comment"
  | "update_comment"
  | "delete_comment"
  | "list_activity"
  | "upload_attachment"
  | "list_attachments"
  | "delete_attachment"
  | "list_evidence"
  | "add_evidence"
  | "set_subscription"
> = {
  async list_relations(ctx, input) {
    const ticket = await getTicket(ctx, input.ticketId);
    return ctx.db
      .select({
        ...getTableColumns(relations),
        sourceKey: sourceTicket.key,
        sourceTitle: sourceTicket.title,
        targetKey: targetTicket.key,
        targetTitle: targetTicket.title,
      })
      .from(relations)
      .innerJoin(sourceTicket, eq(sourceTicket.id, relations.sourceId))
      .innerJoin(targetTicket, eq(targetTicket.id, relations.targetId))
      .where(
        and(
          eq(relations.projectId, project(ctx).id),
          or(eq(relations.sourceId, ticket.id), eq(relations.targetId, ticket.id)),
        ),
      );
  },
  async add_relation(ctx, input) {
    const current = await getTicket(ctx, input.ticketId),
      other = await getTicket(ctx, input.targetId);
    const [source, target] = input.direction === "incoming" ? [other, current] : [current, other];
    if (source.id === target.id) fail(409, "invalid_relation", "Choose a different ticket");
    if (input.type === "blocks") await assertNoCycle(ctx, source.id, target.id);
    const [sourceId, targetId] =
      input.type === "related" ? [source.id, target.id].toSorted() : [source.id, target.id];
    const row = one(
      await ctx.db
        .insert(relations)
        .values({
          projectId: project(ctx).id,
          sourceId: requireRow(sourceId),
          targetId: requireRow(targetId),
          type: input.type,
        })
        .onConflictDoUpdate({
          target: [relations.sourceId, relations.targetId, relations.type],
          set: { type: input.type },
        })
        .returning(),
    );
    await publishRelation(ctx, "relation.added", row);
    return row;
  },
  async remove_relation(ctx, input) {
    const row = one(
      await ctx.db
        .delete(relations)
        .where(and(eq(relations.projectId, project(ctx).id), eq(relations.id, input.relationId)))
        .returning(),
    );
    await publishRelation(ctx, "relation.removed", row);
    return { ok: true };
  },
  async list_comments(ctx, input) {
    const ticket = await getTicket(ctx, input.ticketId),
      where = eq(comments.ticketId, ticket.id);
    return {
      items: await ctx.db
        .select()
        .from(comments)
        .where(where)
        .orderBy(asc(comments.createdAt), asc(comments.id))
        .limit(input.limit)
        .offset(input.offset),
      total: one(await ctx.db.select({ count: count() }).from(comments).where(where)).count,
    };
  },
  async add_comment(ctx, input) {
    const ticket = await getTicket(ctx, input.ticketId);
    const row = one(
      await ctx.db
        .insert(comments)
        .values({
          projectId: project(ctx).id,
          ticketId: ticket.id,
          actorId: ctx.actor.id,
          body: input.body,
        })
        .returning(),
    );
    await ctx.db
      .insert(subscriptions)
      .values({ projectId: row.projectId, ticketId: row.ticketId, userId: ctx.actor.id })
      .onConflictDoNothing();
    await publish(ctx, "comment.created", ticket.id, { commentId: row.id });
    return row;
  },
  async update_comment(ctx, input) {
    const current = await editableComment(ctx, input.commentId, input.expectedVersion);
    const row = one(
      await ctx.db
        .update(comments)
        .set({ body: input.body, version: current.version + 1, updatedAt: new Date() })
        .where(eq(comments.id, current.id))
        .returning(),
    );
    await publish(ctx, "comment.updated", row.ticketId, {
      commentId: row.id,
      version: row.version,
    });
    return row;
  },
  async delete_comment(ctx, input) {
    const current = await editableComment(ctx, input.commentId, input.expectedVersion);
    await ctx.db.delete(comments).where(eq(comments.id, current.id));
    await publish(ctx, "comment.deleted", current.ticketId, { commentId: current.id });
    return { ok: true };
  },
  async list_activity(ctx, input) {
    const ticket = await getTicket(ctx, input.ticketId),
      where = and(eq(events.projectId, project(ctx).id), eq(events.ticketId, ticket.id));
    return {
      items: await ctx.db
        .select()
        .from(events)
        .where(where)
        .orderBy(desc(events.id))
        .limit(input.limit)
        .offset(input.offset),
      total: one(await ctx.db.select({ count: count() }).from(events).where(where)).count,
    };
  },
  async upload_attachment(ctx, input) {
    const ticket = await getTicket(ctx, input.ticketId);
    const bytes = decodeBlobData(input.data, attachmentLimit);
    const id = crypto.randomUUID();
    await ctx.blobs.put(ctx.db, id, bytes, input.contentType);
    const row = one(
      await ctx.db
        .insert(attachments)
        .values({
          id,
          objectId: id,
          projectId: project(ctx).id,
          ticketId: ticket.id,
          actorId: ctx.actor.id,
          name: input.name,
          contentType: input.contentType,
          size: bytes.length,
        })
        .returning(),
    );
    await publish(ctx, "attachment.created", ticket.id, { attachmentId: row.id, size: row.size });
    return row;
  },
  async list_attachments(ctx, input) {
    const ticket = await getTicket(ctx, input.ticketId);
    return ctx.db
      .select()
      .from(attachments)
      .where(eq(attachments.ticketId, ticket.id))
      .orderBy(asc(attachments.createdAt));
  },
  async delete_attachment(ctx, input) {
    const row = one(
      await ctx.db
        .delete(attachments)
        .where(
          and(eq(attachments.projectId, project(ctx).id), eq(attachments.id, input.attachmentId)),
        )
        .returning(),
    );
    await publish(ctx, "attachment.deleted", row.ticketId, { attachmentId: row.id });
    return { ok: true };
  },
  async list_evidence(ctx, input) {
    const ticket = await getTicket(ctx, input.ticketId);
    return ctx.db
      .select()
      .from(evidence)
      .where(eq(evidence.ticketId, ticket.id))
      .orderBy(asc(evidence.createdAt));
  },
  async add_evidence(ctx, input) {
    const ticket = await getTicket(ctx, input.ticketId);
    await assertWorkerClaim(ctx, ticket, input.claimId);
    const row = one(
      await ctx.db
        .insert(evidence)
        .values({
          projectId: project(ctx).id,
          ticketId: ticket.id,
          actorId: ctx.actor.id,
          title: input.title,
          kind: input.kind,
          url: input.url,
          commit: input.commit,
          outcome: input.outcome,
          note: input.note,
        })
        .returning(),
    );
    await publish(ctx, "evidence.added", ticket.id, {
      evidenceId: row.id,
      kind: row.kind,
      outcome: row.outcome,
      commit: row.commit,
    });
    return row;
  },
  async set_subscription(ctx, input) {
    const ticket = await getTicket(ctx, input.ticketId);
    if (input.enabled)
      await ctx.db
        .insert(subscriptions)
        .values({ projectId: project(ctx).id, ticketId: ticket.id, userId: ctx.actor.id })
        .onConflictDoNothing();
    else {
      await ctx.db
        .delete(subscriptions)
        .where(and(eq(subscriptions.ticketId, ticket.id), eq(subscriptions.userId, ctx.actor.id)));
      await ctx.db
        .update(pushDeliveries)
        .set({ finishedAt: new Date(), error: "unsubscribed" })
        .where(
          and(
            isNull(pushDeliveries.finishedAt),
            inArray(
              pushDeliveries.notificationId,
              ctx.db
                .select({ id: notifications.id })
                .from(notifications)
                .innerJoin(events, eq(events.id, notifications.eventId))
                .where(and(eq(notifications.userId, ctx.actor.id), eq(events.ticketId, ticket.id))),
            ),
          ),
        );
    }
    return { ok: true };
  },
};
