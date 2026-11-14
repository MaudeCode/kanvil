import {
  decodeBlobData,
  stagedUploadCutoff,
  intakeAttachmentLimit,
  intakeByteQuota,
} from "./blob-storage.ts";
import {
  attachmentLimit,
  attachmentSchema,
  resourceProvider,
  scopes,
  stagedUploadLifetime,
  stagedUploadSchema,
  uploadUrlLifetime,
  type ParsedInput,
} from "@kanvil/contracts";
import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";
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
  sql,
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
  uploadUrls,
} from "./schema.ts";
import { apikey } from "./auth-schema.ts";
import { accessibleProjectRows } from "./project-access.ts";
import { addRelation, assertMayConstrain } from "./ticket-operations.ts";
import { mentionedUserIds } from "./mentions.ts";
import {
  assertVersion,
  assertWorkerClaim,
  fail,
  getTicket,
  json,
  intakeHoldReason,
  intakeOnly,
  project,
  publish,
  can,
  publishMany,
  relationEvents,
  subscribe,
  type Context,
  type Domain,
  type Handlers,
  one,
} from "./domain.ts";
const sourceTicket = alias(tickets, "source_ticket"),
  targetTicket = alias(tickets, "target_ticket"),
  sourceProject = alias(projects, "source_project"),
  targetProject = alias(projects, "target_project");

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
type FileMetadata = { name: string; contentType: string };
async function attachFile(
  ctx: Context,
  ticket: typeof tickets.$inferSelect,
  id: string,
  bytes: Buffer,
  file: FileMetadata,
) {
  if (intakeOnly(ctx.actor)) {
    const stored = one(
      await ctx.db
        .select({
          files:
            sql<number>`count(*) filter (where ${attachments.ticketId} = ${ticket.id})`.mapWith(
              Number,
            ),
          bytes: sql<number>`coalesce(sum(${attachments.size}), 0)`.mapWith(Number),
        })
        .from(attachments)
        .innerJoin(tickets, eq(tickets.id, attachments.ticketId))
        .where(
          and(
            eq(tickets.intakeCredentialId, ctx.actor.ownerId),
            eq(tickets.holdReason, intakeHoldReason),
          ),
        ),
    );
    if (stored.files >= intakeAttachmentLimit)
      fail(
        409,
        "attachment_limit",
        `An intake credential can attach at most ${intakeAttachmentLimit} files to a ticket`,
      );
    if (stored.bytes + bytes.length > intakeByteQuota)
      fail(
        409,
        "attachment_limit",
        "This intake credential's untriaged tickets hold too many attachment bytes",
      );
  }
  await ctx.blobs.put(ctx.db, id, bytes, file.contentType);
  const row = one(
    await ctx.db
      .insert(attachments)
      .values({
        id,
        objectId: id,
        projectId: project(ctx).id,
        ticketId: ticket.id,
        actorId: ctx.actor.id,
        name: file.name,
        contentType: file.contentType,
        size: bytes.length,
      })
      .returning(),
  );
  await publish(ctx, "attachment.created", ticket.id, { attachmentId: row.id, size: row.size });
  return row;
}
// No event: a staged upload is private to its uploader until create_ticket claims it and
// publishes the attachment with the ticket.
async function stageFile(ctx: Context, id: string, bytes: Buffer, file: FileMetadata) {
  await ctx.blobs.put(ctx.db, id, bytes, file.contentType);
  const row = one(
    await ctx.db
      .insert(stagedUploads)
      .values({
        id,
        projectId: project(ctx).id,
        actorId: ctx.actor.id,
        name: file.name,
        contentType: file.contentType,
        size: bytes.length,
      })
      .returning(),
  );
  return { ...row, expiresAt: new Date(row.createdAt.getTime() + stagedUploadLifetime) };
}
const uploadToken = /^kvup_[A-Za-z0-9_-]{43}$/;
const hashUploadToken = (token: string) => createHash("sha256").update(token).digest("hex");
const uploadCredential = z
  .object({
    ownerId: z.string(),
    scopes: z.array(z.enum(scopes)),
    projectIds: z.array(z.string()).optional(),
    // An API key, as opposed to an MCP OAuth grant: the PUT checks it was not revoked since.
    apiKey: z.boolean(),
  })
  .nullable();
function assertUploadUrlOpen(row: { usedAt: Date | null; expiresAt: Date }) {
  if (row.usedAt) fail(410, "upload_url_unavailable", "This upload URL was already used");
  if (row.expiresAt.getTime() <= Date.now())
    fail(410, "upload_url_unavailable", "This upload URL expired; request a new one");
}
// The PUT behind a create_upload_url URL. The token is its only credential, so it reaches one
// upload: unknown tokens read as not found and the URL serves no read. The request must announce
// the declared size as its Content-Length, and the URL is reserved before the body is read, so
// only one request at a time reads at most that many bytes. The write then
// runs as the issuer with the issuing credential's limits, and needs their current write access
// to the project (and ticket). Only a stored upload uses the URL: any failure, such as a wrong
// size, releases the reservation and leaves the URL usable.
export async function receiveUpload(
  domain: Domain,
  token: string,
  contentLength: string | undefined,
  read: (limit: number) => Promise<Buffer>,
) {
  const { db } = domain.database,
    row = uploadToken.test(token)
      ? (
          await db
            .select()
            .from(uploadUrls)
            .where(eq(uploadUrls.tokenHash, hashUploadToken(token)))
        )[0]
      : undefined;
  if (!row) return fail(404, "not_found", "This upload URL does not exist");
  assertUploadUrlOpen(row);
  const wrongSize = (sent: string) =>
    fail(
      400,
      "invalid_attachment",
      `This upload URL takes exactly ${row.size} bytes with that Content-Length; the request sent ${sent}`,
    );
  if (contentLength !== String(row.size)) wrongSize(contentLength ?? "no Content-Length");
  const reserved = new Date();
  const [held] = await db
    .update(uploadUrls)
    .set({ usedAt: reserved })
    .where(
      and(eq(uploadUrls.id, row.id), isNull(uploadUrls.usedAt), gt(uploadUrls.expiresAt, reserved)),
    )
    .returning({ id: uploadUrls.id });
  if (!held) fail(410, "upload_url_unavailable", "This upload URL is already receiving an upload");
  try {
    const bytes = await read(row.size);
    if (bytes.length !== row.size)
      wrongSize(bytes.length > row.size ? "more" : String(bytes.length));
    const credential = uploadCredential.parse(row.credential);
    if (credential?.apiKey) {
      const key = (await db.select().from(apikey).where(eq(apikey.id, credential.ownerId)))[0];
      if (!key?.enabled || (key.expiresAt && key.expiresAt <= new Date()))
        fail(401, "unauthorized", "The API credential that requested this upload URL was revoked");
    }
    const actor = await domain.actor(
      row.actorId,
      credential
        ? {
            ownerId: credential.ownerId,
            scopes: credential.scopes,
            ...(credential.projectIds ? { projectIds: credential.projectIds } : {}),
          }
        : undefined,
    );
    return await domain.transact(async (tx, as) => {
      const ctx = await as(actor, row.projectId);
      return row.ticketId
        ? attachmentSchema.parse(
            json(await attachFile(ctx, await getTicket(ctx, row.ticketId), row.id, bytes, row)),
          )
        : stagedUploadSchema.parse(json(await stageFile(ctx, row.id, bytes, row)));
    });
  } catch (error) {
    await db
      .update(uploadUrls)
      .set({ usedAt: null })
      .where(and(eq(uploadUrls.id, row.id), eq(uploadUrls.usedAt, reserved)));
    throw error;
  }
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
  | "create_upload_url"
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
    const added = await addRelation(ctx, await getTicket(ctx, input.ticketId), input);
    await publishMany(ctx, added.events);
    return added.row;
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
    return attachFile(
      ctx,
      await getTicket(ctx, input.ticketId),
      crypto.randomUUID(),
      decodeBlobData(input.data, attachmentLimit),
      input,
    );
  },
  async stage_upload(ctx, input) {
    return stageFile(ctx, crypto.randomUUID(), decodeBlobData(input.data, attachmentLimit), input);
  },
  // No event: nothing exists until the PUT stores the bytes. No requestId either: a receipt would
  // keep the URL's token.
  async create_upload_url(ctx, input) {
    const ticket = input.ticketId ? await getTicket(ctx, input.ticketId) : undefined,
      token = `kvup_${randomBytes(32).toString("base64url")}`,
      { id, ownerId, scopes: granted, projectIds, machine } = ctx.actor,
      apiKey =
        machine &&
        (await ctx.db.select({ id: apikey.id }).from(apikey).where(eq(apikey.id, ownerId))).length >
          0;
    const row = one(
      await ctx.db
        .insert(uploadUrls)
        .values({
          id: crypto.randomUUID(),
          projectId: project(ctx).id,
          ticketId: ticket?.id ?? null,
          actorId: id,
          credential: machine ? { ownerId, scopes: granted, projectIds, apiKey } : null,
          name: input.name,
          contentType: input.contentType,
          size: input.size,
          tokenHash: hashUploadToken(token),
          expiresAt: new Date(Date.now() + uploadUrlLifetime),
        })
        .returning(),
    );
    return {
      uploadId: row.id,
      url: new URL(`/api/uploads/${token}`, ctx.publicUrl).href,
      expiresAt: row.expiresAt,
    };
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
