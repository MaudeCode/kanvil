import { and, asc, count, eq, inArray, or, sql } from "drizzle-orm";
import type { PgUpdateSetSource } from "drizzle-orm/pg-core";
import { hasAdminRole, type Project, type ProjectImpact } from "@kanvil/contracts";
import { user } from "./auth-schema.ts";
import { dropProjectFromInvitations } from "./invitation-operations.ts";
import { projectRoleSQL } from "./project-access.ts";
import { endPosition, projectPositions } from "./ordering.ts";
import { labelUsage } from "./ticket-operations.ts";
import { requireWorkspace } from "./workspace-operations.ts";
import {
  attachments,
  calendarFeeds,
  claims,
  comments,
  events,
  invitations,
  members,
  projectDestinations,
  projectLabels,
  projects,
  stagedUploads,
  subscriptions,
  tickets,
  workspaceLabels,
  workspaceMembers,
} from "./schema.ts";
import {
  assertVersion,
  fail,
  one,
  project,
  publish,
  publishMany,
  requireRow,
  toProject,
  type Context,
  type Handlers,
} from "./domain.ts";

// Archive, restore, delete, and workspace moves. Each write re-runs the preview it shows people, so
// what was reviewed is what is checked; a blocker fails the write with its own code.
type Blocker = ProjectImpact["blockers"][number];
function assertNoBlockers(blockers: Blocker[]) {
  const [first] = blockers;
  if (first) fail(409, first.code, first.message, { blockers });
}
// A claim, live or expired, means a worker may still be acting on the ticket.
async function claimBlockers(ctx: Context): Promise<Blocker[]> {
  const rows = await ctx.db
    .select({ key: tickets.key })
    .from(claims)
    .innerJoin(tickets, eq(tickets.id, claims.ticketId))
    .where(eq(claims.projectId, project(ctx).id))
    .orderBy(asc(tickets.number));
  return rows.length
    ? [
        {
          code: "claim_conflict",
          message: "Release or recover the claimed tickets first",
          tickets: rows.map((row) => row.key),
        },
      ]
    : [];
}
// Relationships and parents stay inside a project today; one that reaches another project would
// cross workspaces after a move, so it has to be removed first rather than silently kept or dropped.
async function relationBlockers(ctx: Context): Promise<Blocker[]> {
  const rows = await ctx.db
    .select({ key: tickets.key })
    .from(tickets)
    .where(
      and(
        eq(tickets.projectId, project(ctx).id),
        sql`(EXISTS (SELECT 1 FROM ticket_relations r JOIN tickets o
            ON o.id = CASE WHEN r.source_id = ${tickets.id} THEN r.target_id ELSE r.source_id END
            WHERE (r.source_id = ${tickets.id} OR r.target_id = ${tickets.id})
              AND o.project_id <> ${tickets.projectId})
          OR EXISTS (SELECT 1 FROM tickets o
            WHERE (o.id = ${tickets.parentId} OR o.parent_id = ${tickets.id})
              AND o.project_id <> ${tickets.projectId}))`,
      ),
    )
    .orderBy(asc(tickets.number));
  return rows.length
    ? [
        {
          code: "relation_conflict",
          message: "Remove relationships and parents that link to other projects first",
          tickets: rows.map((row) => row.key),
        },
      ]
    : [];
}
// The destination's administration is checked with the request; the source's is checked here.
async function assertTransferable(ctx: Context, workspaceId: string) {
  const current = project(ctx);
  if (workspaceId === current.workspaceId)
    fail(400, "validation_error", "The project is already in this workspace");
  await requireWorkspace(ctx, current.workspaceId, true);
}
async function transferImpact(ctx: Context, workspaceId: string) {
  const current = project(ctx),
    // Qualified, since a single-table select renders bare "id", which the subquery binds to p.
    userId = sql`${user}."id"`;
  const people = await ctx.db
    .select({
      userId: user.id,
      name: user.name,
      email: user.email,
      role: user.role,
      before: projectRoleSQL(userId, current.id),
      after: projectRoleSQL(userId, current.id, workspaceId),
    })
    .from(user)
    .where(
      and(
        sql`not coalesce(${user.banned}, false)`,
        or(
          inArray(
            user.id,
            ctx.db
              .select({ id: members.userId })
              .from(members)
              .where(eq(members.projectId, current.id)),
          ),
          inArray(
            user.id,
            ctx.db
              .select({ id: workspaceMembers.userId })
              .from(workspaceMembers)
              .where(inArray(workspaceMembers.workspaceId, [current.workspaceId, workspaceId])),
          ),
        ),
      ),
    )
    .orderBy(user.name);
  // Instance administrators read every project, so a move changes nothing for them.
  const person = ({ userId, name, email }: (typeof people)[number]) => ({ userId, name, email });
  const affected = people.filter((row) => !hasAdminRole(row.role)),
    losingAccess = affected.filter((row) => row.before && !row.after).map(person),
    gainingAccess = affected.filter((row) => !row.before && row.after).map(person);
  // Labels resolve by name within a workspace. Shared labels the tickets use become project labels
  // unless the destination shares the name too; project labels the destination shares give way.
  const usage = labelUsage(ctx, "include").as("usage");
  const used = (await ctx.db.select({ name: usage.name }).from(usage)).map((row) => row.name);
  const shared = async (id: string) =>
    (
      await ctx.db
        .select({ name: workspaceLabels.name })
        .from(workspaceLabels)
        .where(eq(workspaceLabels.workspaceId, id))
    ).map((row) => row.name);
  const source = await shared(current.workspaceId),
    destination = await shared(workspaceId);
  const own = (
    await ctx.db
      .select({ name: projectLabels.name })
      .from(projectLabels)
      .where(eq(projectLabels.projectId, current.id))
  ).map((row) => row.name);
  const inherited = used.filter((name) => source.includes(name));
  const [follows] = losingAccess.length
    ? await ctx.db
        .select({ count: count() })
        .from(subscriptions)
        .where(
          and(
            eq(subscriptions.projectId, current.id),
            inArray(
              subscriptions.userId,
              losingAccess.map((row) => row.userId),
            ),
          ),
        )
    : [];
  const [invited] = await ctx.db
    .select({ count: count() })
    .from(invitations)
    .where(
      and(
        eq(invitations.workspaceId, current.workspaceId),
        eq(invitations.status, "pending"),
        sql`${current.id}::uuid = ANY(${invitations.projectIds})`,
      ),
    );
  return {
    workspaceId,
    losingAccess,
    gainingAccess,
    copiedLabels: inherited.filter((name) => !destination.includes(name)).toSorted(),
    mergedLabels: [...inherited, ...own].filter((name) => destination.includes(name)).toSorted(),
    subscriptions: follows?.count ?? 0,
    invitations: invited?.count ?? 0,
  };
}
async function projectImpact(ctx: Context, workspaceId?: string): Promise<ProjectImpact> {
  const id = project(ctx).id;
  const files = one(
    await ctx.db
      .select({
        count: count(),
        bytes: sql<number>`coalesce(sum(${attachments.size}), 0)`.mapWith(Number),
      })
      .from(attachments)
      .where(eq(attachments.projectId, id)),
  );
  return {
    tickets: await ctx.db.$count(tickets, eq(tickets.projectId, id)),
    comments: await ctx.db.$count(comments, eq(comments.projectId, id)),
    attachments: files.count,
    attachmentBytes: files.bytes,
    events: await ctx.db.$count(events, eq(events.projectId, id)),
    blockers: [...(await claimBlockers(ctx)), ...(workspaceId ? await relationBlockers(ctx) : [])],
    transfer: workspaceId ? await transferImpact(ctx, workspaceId) : null,
  };
}
const changed = async (ctx: Context, values: PgUpdateSetSource<typeof projects>) =>
  one(
    await ctx.db
      .update(projects)
      .set({ ...values, version: project(ctx).version + 1, updatedAt: new Date() })
      .where(eq(projects.id, project(ctx).id))
      .returning(),
  );

export const lifecycleHandlers: Pick<
  Handlers,
  "archive_project" | "get_project_impact" | "transfer_project" | "delete_project"
> = {
  async archive_project(ctx, input) {
    const current: Project = project(ctx);
    assertVersion(
      current,
      input.expectedVersion,
      "project",
      input.archived ? "archiving" : "restoring",
    );
    if (!!current.archivedAt === input.archived) return current;
    if (input.archived) assertNoBlockers(await claimBlockers(ctx));
    const row = await changed(ctx, { archivedAt: input.archived ? new Date() : null });
    await publish(ctx, input.archived ? "project.archived" : "project.restored", null, {
      version: row.version,
    });
    return row;
  },
  async get_project_impact(ctx, input) {
    if (input.workspaceId) await assertTransferable(ctx, input.workspaceId);
    return projectImpact(ctx, input.workspaceId);
  },
  async transfer_project(ctx, input) {
    const current = project(ctx);
    assertVersion(current, input.expectedVersion, "project", "moving");
    await assertTransferable(ctx, input.workspaceId);
    const impact = await projectImpact(ctx, input.workspaceId);
    assertNoBlockers(impact.blockers);
    const transfer = requireRow(impact.transfer ?? undefined);
    if (transfer.copiedLabels.length) {
      const copies = await ctx.db
        .select({ name: workspaceLabels.name, color: workspaceLabels.color })
        .from(workspaceLabels)
        .where(
          and(
            eq(workspaceLabels.workspaceId, current.workspaceId),
            inArray(workspaceLabels.name, transfer.copiedLabels),
          ),
        );
      await ctx.db
        .insert(projectLabels)
        .values(copies.map((label) => ({ ...label, projectId: current.id })))
        .onConflictDoNothing();
    }
    if (transfer.mergedLabels.length)
      await ctx.db
        .delete(projectLabels)
        .where(
          and(
            eq(projectLabels.projectId, current.id),
            inArray(projectLabels.name, transfer.mergedLabels),
          ),
        );
    const row = await changed(ctx, {
      workspaceId: input.workspaceId,
      position: endPosition(projectPositions, eq(projects.workspaceId, input.workspaceId)),
    });
    // People who can no longer read the project stop following its tickets.
    if (transfer.losingAccess.length)
      await ctx.db.delete(subscriptions).where(
        and(
          eq(subscriptions.projectId, current.id),
          inArray(
            subscriptions.userId,
            transfer.losingAccess.map((person) => person.userId),
          ),
        ),
      );
    await dropProjectFromInvitations(ctx, current);
    await publish({ ...ctx, project: toProject(row) }, "project.transferred", null, {
      version: row.version,
      fromWorkspaceId: current.workspaceId,
      workspaceId: row.workspaceId,
      copiedLabels: transfer.copiedLabels,
      mergedLabels: transfer.mergedLabels,
    });
    return row;
  },
  // The project row stays as a tombstone: its prefix is never reused, and its activity and the
  // deletion events remain in the log. Content goes; unreferenced files are collected by blob cleanup.
  async delete_project(ctx, input) {
    const current = project(ctx);
    assertVersion(current, input.expectedVersion, "project", "deleting");
    if (input.confirmKey.trim().toUpperCase() !== current.key)
      fail(400, "validation_error", "Type the project prefix to confirm deletion");
    assertNoBlockers(await claimBlockers(ctx));
    // Destinations go first, so the deletion events queue no outbound deliveries.
    await ctx.db.delete(projectDestinations).where(eq(projectDestinations.projectId, current.id));
    await ctx.db.delete(calendarFeeds).where(eq(calendarFeeds.projectId, current.id));
    const removed = await ctx.db
      .select({ id: tickets.id, key: tickets.key, version: tickets.version })
      .from(tickets)
      .where(eq(tickets.projectId, current.id))
      .orderBy(asc(tickets.number));
    await publishMany(
      ctx,
      [
        ...removed.map((ticket) => ({
          type: "ticket.deleted",
          ticketId: ticket.id,
          data: { key: ticket.key, version: ticket.version },
        })),
        {
          type: "project.deleted",
          ticketId: null,
          data: { key: current.key, name: current.name, tickets: removed.length },
        },
      ],
      false,
    );
    // Comments, attachments, relationships, follows, evidence, and links cascade with the tickets.
    await ctx.db.delete(tickets).where(eq(tickets.projectId, current.id));
    await ctx.db.delete(stagedUploads).where(eq(stagedUploads.projectId, current.id));
    await ctx.db.delete(projectLabels).where(eq(projectLabels.projectId, current.id));
    await dropProjectFromInvitations(ctx, current);
    await changed(ctx, {
      deletedAt: new Date(),
      image: null,
      iconObjectId: null,
      background: null,
      backgroundObjectId: null,
    });
    return { ok: true };
  },
};
