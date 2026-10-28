import { decodeBlobData, stagedUploadCutoff } from "./blob-storage.ts";
import {
  attachmentLimit,
  resourceProvider,
  stagedUploadLifetime,
  type ParsedInput,
} from "@kanvil/contracts";
import {
  and,
  asc,
  count,
  desc,
  eq,
  getTableColumns,
  gt,
  inArray,
  isNull,
  ne,
  or,
} from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import {
  attachments,
  blobObjects,
  comments,
  events,
  evidence,
  relations,
  resources,
  subscriptions,
  notifications,
  deliveries,
  projects,
  stagedUploads,
  tickets,
} from "./schema.ts";
import { accessibleProjectRows } from "./project-access.ts";
import { assertNoCycle, readableTicket } from "./ticket-operations.ts";
import { mentionedUserIds } from "./mentions.ts";
import {
  assertVersion,
  assertWorkerClaim,
  context,
  fail,
  getTicket,
  project,
  publish,
  can,
  publishMany,
  relationEvents,
  requireRow,
  subscribe,
  type Context,
  type Handlers,
  one,
} from "./domain.ts";
const sourceTicket = alias(tickets, "source_ticket"),
  targetTicket = alias(tickets, "target_ticket"),
  sourceProject = alias(projects, "source_project"),
  targetProject = alias(projects, "target_project");

// Reading another project lets a writer here depend on its tickets and link to them. An edge that
// constrains one of its tickets, as the blocked side of `blocks` or the duplicate, needs write
// there too, to add or to remove.
async function assertMayConstrain(
  ctx: Context,
  relation: { type: string; sourceId: string; targetId: string },
  sides: readonly { id: string; projectId: string }[],
) {
  const constrained =
    relation.type === "blocks"
      ? relation.targetId
      : relation.type === "duplicate"
        ? relation.sourceId
        : null;
  const side = sides.find((item) => item.id === constrained);
  if (side && side.projectId !== project(ctx).id)
    await context(ctx.db, ctx.actor, "write", side.projectId);
}
async function editableComment(ctx: Context, commentId: string, expectedVersion: number) {
  const row = one(
    await ctx.db
      .select()
      .from(comments)
      .where(and(eq(comments.projectId, project(ctx).id), eq(comments.id, commentId))),
  );
  if (row.actorId !== ctx.actor.id && !can(ctx, "project.manage"))
    fail(403, "forbidden", "Only the author or a project administrator can edit this comment");
  assertVersion(row, expectedVersion, "comment");
  return row;
}
async function editableResource(
  ctx: Context,
  input: { resourceId: string; expectedVersion: number; claimId?: string | undefined },
) {
  const row = one(
    await ctx.db
      .select()
      .from(resources)
      .where(and(eq(resources.projectId, project(ctx).id), eq(resources.id, input.resourceId))),
  );
  await assertWorkerClaim(ctx, await getTicket(ctx, row.ticketId), input.claimId);
  assertVersion(row, input.expectedVersion, "resource");
  return row;
}
export async function addComment(ctx: Context, input: ParsedInput<"add_comment">) {
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
  await subscribe(ctx, row.projectId, row.ticketId, [ctx.actor.id]);
  await publish(ctx, "comment.created", ticket.id, {
    commentId: row.id,
    mentions: mentionedUserIds(row.body),
  });
  return row;
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
  | "stage_upload"
  | "discard_upload"
  | "list_attachments"
  | "delete_attachment"
  | "list_evidence"
  | "add_evidence"
  | "list_resources"
  | "add_resource"
  | "update_resource"
  | "delete_resource"
  | "set_subscription"
> = {
  async list_relations(ctx, input) {
    const ticket = await getTicket(ctx, input.ticketId);
    const rows = await ctx.db
      .select({
        ...getTableColumns(relations),
        sourceKey: sourceTicket.key,
        sourceTitle: sourceTicket.title,
        sourceProjectId: sourceTicket.projectId,
        sourceProjectKey: sourceProject.key,
        targetKey: targetTicket.key,
        targetTitle: targetTicket.title,
        targetProjectId: targetTicket.projectId,
        targetProjectKey: targetProject.key,
      })
      .from(relations)
      .innerJoin(sourceTicket, eq(sourceTicket.id, relations.sourceId))
      .innerJoin(targetTicket, eq(targetTicket.id, relations.targetId))
      .innerJoin(sourceProject, eq(sourceProject.id, sourceTicket.projectId))
      .innerJoin(targetProject, eq(targetProject.id, targetTicket.projectId))
      .where(or(eq(relations.sourceId, ticket.id), eq(relations.targetId, ticket.id)));
    // The other side of an edge into another project shows only its key, unless the caller can
    // read that project too.
    const here = project(ctx).id,
      elsewhere = rows.some((row) => row.sourceProjectId !== here || row.targetProjectId !== here),
      readable = new Set([
        here,
        ...(elsewhere ? await accessibleProjectRows(ctx.db, ctx.actor) : []).map((row) => row.id),
      ]);
    return rows.map(
      ({
        sourceTitle,
        sourceProjectId,
        sourceProjectKey,
        targetTitle,
        targetProjectId,
        targetProjectKey,
        ...row
      }) => {
        const source = readable.has(sourceProjectId),
          target = readable.has(targetProjectId);
        return {
          ...row,
          ...(source && { sourceTitle, sourceProjectId, sourceProjectKey }),
          ...(target && { targetTitle, targetProjectId, targetProjectKey }),
          restricted: !source || !target,
        };
      },
    );
  },
  async add_relation(ctx, input) {
    // The other ticket may live in any project the caller can read.
    const current = await getTicket(ctx, input.ticketId),
      { ticket: other } = await readableTicket(ctx, input.targetId);
    const [source, target] = input.direction === "incoming" ? [other, current] : [current, other];
    if (source.id === target.id) fail(409, "invalid_relation", "Choose a different ticket");
    await assertMayConstrain(ctx, { type: input.type, sourceId: source.id, targetId: target.id }, [
      current,
      other,
    ]);
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
    await publishMany(ctx, relationEvents("relation.added", row, [current, other]));
    return row;
  },
  // Either ticket's project can remove an edge; one that constrains a ticket elsewhere needs write
  // there too.
  async remove_relation(ctx, input) {
    const found = one(
      await ctx.db.select().from(relations).where(eq(relations.id, input.relationId)),
    );
    const sides = await ctx.db
      .select({ id: tickets.id, projectId: tickets.projectId })
      .from(tickets)
      .where(inArray(tickets.id, [found.sourceId, found.targetId]));
    if (!sides.some((side) => side.projectId === project(ctx).id))
      fail(404, "not_found", "The requested record was not found");
    await assertMayConstrain(ctx, found, sides);
    const row = one(await ctx.db.delete(relations).where(eq(relations.id, found.id)).returning());
    await publishMany(ctx, relationEvents("relation.removed", row, sides));
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
  add_comment: addComment,
  async update_comment(ctx, input) {
    const current = await editableComment(ctx, input.commentId, input.expectedVersion);
    const row = one(
      await ctx.db
        .update(comments)
        .set({ body: input.body, version: current.version + 1, updatedAt: new Date() })
        .where(eq(comments.id, current.id))
        .returning(),
    );
    // An edit notifies only the members it newly mentions.
    const before = new Set(mentionedUserIds(current.body));
    await publish(ctx, "comment.updated", row.ticketId, {
      commentId: row.id,
      version: row.version,
      mentions: mentionedUserIds(row.body).filter((id) => !before.has(id)),
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
  // No event: a staged upload is private to its uploader until create_ticket claims it and
  // publishes the attachment with the ticket.
  async stage_upload(ctx, input) {
    const bytes = decodeBlobData(input.data, attachmentLimit);
    const id = crypto.randomUUID();
    await ctx.blobs.put(ctx.db, id, bytes, input.contentType);
    const row = one(
      await ctx.db
        .insert(stagedUploads)
        .values({
          id,
          projectId: project(ctx).id,
          actorId: ctx.actor.id,
          name: input.name,
          contentType: input.contentType,
          size: bytes.length,
        })
        .returning(),
    );
    return { ...row, expiresAt: new Date(row.createdAt.getTime() + stagedUploadLifetime) };
  },
  async discard_upload(ctx, input) {
    const row = one(
      await ctx.db
        .delete(stagedUploads)
        .where(
          and(
            eq(stagedUploads.id, input.uploadId),
            eq(stagedUploads.projectId, project(ctx).id),
            eq(stagedUploads.actorId, ctx.actor.id),
            gt(stagedUploads.createdAt, stagedUploadCutoff()),
          ),
        )
        .returning(),
    );
    // Unclaimed bytes never reach external storage, so removing the row removes them.
    await ctx.db.delete(blobObjects).where(eq(blobObjects.id, row.id));
    return { ok: true };
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
  async list_resources(ctx, input) {
    const ticket = await getTicket(ctx, input.ticketId);
    return ctx.db
      .select()
      .from(resources)
      .where(eq(resources.ticketId, ticket.id))
      .orderBy(asc(resources.createdAt), asc(resources.id));
  },
  async add_resource(ctx, input) {
    const ticket = await getTicket(ctx, input.ticketId);
    await assertWorkerClaim(ctx, ticket, input.claimId);
    const row = one(
      await ctx.db
        .insert(resources)
        .values({
          projectId: project(ctx).id,
          ticketId: ticket.id,
          actorId: ctx.actor.id,
          url: input.url,
          title: input.title,
          provider: resourceProvider(input.url),
        })
        .returning(),
    );
    await publish(ctx, "resource.added", ticket.id, { resourceId: row.id });
    return row;
  },
  async update_resource(ctx, input) {
    const current = await editableResource(ctx, input);
    const url = input.url ?? current.url,
      moved = url !== current.url;
    const row = one(
      await ctx.db
        .update(resources)
        .set({
          url,
          title: input.title ?? current.title,
          // Remote state belongs to the old target, so a new URL starts unknown again.
          ...(moved && {
            provider: resourceProvider(url),
            remoteKind: null,
            remoteState: null,
            remoteCheckedAt: null,
          }),
          version: current.version + 1,
          updatedAt: new Date(),
        })
        .where(eq(resources.id, current.id))
        .returning(),
    );
    await publish(ctx, "resource.updated", row.ticketId, {
      resourceId: row.id,
      version: row.version,
    });
    return row;
  },
  async delete_resource(ctx, input) {
    const current = await editableResource(ctx, input);
    await ctx.db.delete(resources).where(eq(resources.id, current.id));
    await publish(ctx, "resource.removed", current.ticketId, { resourceId: current.id });
    return { ok: true };
  },
  async set_subscription(ctx, input) {
    const ticket = await getTicket(ctx, input.ticketId);
    if (input.enabled) await subscribe(ctx, project(ctx).id, ticket.id, [ctx.actor.id]);
    else {
      await ctx.db
        .delete(subscriptions)
        .where(and(eq(subscriptions.ticketId, ticket.id), eq(subscriptions.userId, ctx.actor.id)));
      await ctx.db
        .update(deliveries)
        .set({ finishedAt: new Date(), error: "unsubscribed" })
        .where(
          and(
            isNull(deliveries.finishedAt),
            inArray(
              deliveries.notificationId,
              ctx.db
                .select({ id: notifications.id })
                .from(notifications)
                .innerJoin(events, eq(events.id, notifications.eventId))
                .where(
                  and(
                    eq(notifications.userId, ctx.actor.id),
                    eq(events.ticketId, ticket.id),
                    // A mention reaches its member whether or not they follow the ticket.
                    ne(notifications.category, "mention"),
                  ),
                ),
            ),
          ),
        );
    }
    return { ok: true };
  },
};
