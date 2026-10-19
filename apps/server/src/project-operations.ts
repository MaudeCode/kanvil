import { icons } from "@iconify-json/lucide";
import { decodeImage } from "./blob-storage.ts";
import { and, count, eq, inArray, ne, or, sql } from "drizzle-orm";
import { user } from "./auth-schema.ts";
import { roles, ticketFilter } from "@kanvil/contracts";
import { z } from "zod";
import { accessibleProjectRows, projectRoleSQL } from "./project-access.ts";
import { endPosition, positionNear, projectPositions } from "./ordering.ts";
import { seedWorkflow } from "./workflow-operations.ts";
import {
  members,
  projectPrefixes,
  projects,
  tickets,
  views,
  workspaces,
  workspaceMembers,
} from "./schema.ts";
import { openTicket, overdueTicket } from "./ticket-operations.ts";
import {
  accountByEmail,
  assertVersion,
  fail,
  project,
  projectMatch,
  publish,
  toProject,
  workspace,
  type Handlers,
  type Context,
  one,
} from "./domain.ts";

// A prefix any other project has had, current or earlier, stays taken: its keys still name that
// project's tickets. Taking one reserves it for the project for good.
async function takePrefix(ctx: Context, prefix: string, projectId?: string) {
  const holders = await ctx.db
    .select({ id: projects.id })
    .from(projects)
    .where(projectMatch(prefix));
  if (holders.some((row) => row.id !== projectId))
    fail(409, "duplicate_prefix", "This prefix is in use or reserved by another project");
  return (owner: string) =>
    ctx.db.insert(projectPrefixes).values({ prefix, projectId: owner }).onConflictDoNothing();
}
// Stores an uploaded project image; the previous one becomes an orphan for blob cleanup.
async function storeImage(ctx: Context, image: { data: string; contentType: string }) {
  const objectId = crypto.randomUUID();
  await ctx.blobs.put(ctx.db, objectId, decodeImage(image), image.contentType);
  return objectId;
}

export const projectHandlers: Pick<
  Handlers,
  | "get_project"
  | "set_project_icon"
  | "set_project_background"
  | "list_projects"
  | "create_project"
  | "update_project"
  | "move_project"
  | "list_members"
  | "set_member"
  | "list_views"
  | "save_view"
  | "delete_view"
> = {
  async get_project(ctx) {
    return project(ctx);
  },
  async set_project_icon(ctx, input) {
    const current = project(ctx);
    assertVersion(current, input.expectedVersion, "project icon", "saving");
    const icon = input.icon;
    if (icon?.kind === "library" && !icons.icons[icon.name])
      fail(400, "invalid_icon", "Choose an icon from the installed library");
    const objectId = icon?.kind === "image" ? await storeImage(ctx, icon) : null;
    const row = one(
      await ctx.db
        .update(projects)
        .set({
          iconName: icon?.kind === "library" ? icon.name : null,
          iconColor: icon?.kind === "library" ? icon.color : "default",
          image: objectId ? `/api/v1/projects/${current.id}/icon?v=${objectId}` : null,
          iconObjectId: objectId,
          version: current.version + 1,
          updatedAt: new Date(),
        })
        .where(eq(projects.id, current.id))
        .returning(),
    );
    await publish(ctx, "project.updated", null, { version: row.version });
    return row;
  },
  async set_project_background(ctx, input) {
    const current = project(ctx);
    assertVersion(current, input.expectedVersion, "project background", "saving");
    const objectId = input.background ? await storeImage(ctx, input.background) : null;
    const row = one(
      await ctx.db
        .update(projects)
        .set({
          background: objectId ? `/api/v1/projects/${current.id}/background?v=${objectId}` : null,
          backgroundObjectId: objectId,
          version: current.version + 1,
          updatedAt: new Date(),
        })
        .where(eq(projects.id, current.id))
        .returning(),
    );
    await publish(ctx, "project.updated", null, { version: row.version });
    return row;
  },
  async list_projects(ctx, input) {
    const rows = await accessibleProjectRows(ctx.db, ctx.actor, input.workspaceId, input.archived);
    if (!rows.length) return [];
    const counts = await ctx.db
      .select({
        projectId: tickets.projectId,
        open: count(sql`CASE WHEN ${openTicket} THEN 1 END`),
        overdue: count(sql`CASE WHEN ${openTicket} AND ${overdueTicket} THEN 1 END`),
        closed: count(sql`CASE WHEN NOT ${openTicket} THEN 1 END`),
        nextDue:
          sql<Date | null>`min(CASE WHEN ${openTicket} AND ${tickets.dueAt} >= now() THEN ${tickets.dueAt} END)`.mapWith(
            tickets.dueAt,
          ),
      })
      .from(tickets)
      .where(
        and(
          inArray(
            tickets.projectId,
            rows.map((row) => row.id),
          ),
          eq(tickets.archived, false),
        ),
      )
      .groupBy(tickets.projectId);
    // The caller's effective role per project, so clients can tell writable projects in one read.
    const access = ctx.actor.admin
      ? []
      : await ctx.db
          // Qualified, since a single-table select renders bare "id", which the subquery binds to p.
          .select({ id: projects.id, role: projectRoleSQL(ctx.actor.id, sql`${projects}."id"`) })
          .from(projects)
          .where(
            inArray(
              projects.id,
              rows.map((row) => row.id),
            ),
          );
    return rows.map((row) => {
      const stats = counts.find((entry) => entry.projectId === row.id);
      return {
        ...toProject(row),
        openTickets: stats?.open ?? 0,
        overdueTickets: stats?.overdue ?? 0,
        closedTickets: stats?.closed ?? 0,
        nextDueAt: stats?.nextDue ?? null,
        role: ctx.actor.admin
          ? ("admin" as const)
          : z.enum(roles).parse(access.find((entry) => entry.id === row.id)?.role),
      };
    });
  },
  async create_project(ctx, input) {
    if (ctx.actor.projectIds)
      fail(403, "insufficient_scope", "Project-bound credentials cannot create projects");
    let workspaceId = input.workspaceId;
    if (workspaceId) {
      const currentWorkspace = workspace(ctx);
      if (currentWorkspace.role === "reader")
        fail(403, "forbidden", "Project creation requires workspace write access");
    } else {
      const available = ctx.actor.admin
        ? await ctx.db
            .select({ workspaceId: workspaces.id })
            .from(workspaces)
            .orderBy(workspaces.createdAt)
            .limit(1)
        : await ctx.db
            .select({ workspaceId: workspaceMembers.workspaceId })
            .from(workspaceMembers)
            .where(
              and(
                eq(workspaceMembers.userId, ctx.actor.id),
                inArray(workspaceMembers.role, ["writer", "admin"]),
              ),
            )
            .orderBy(workspaceMembers.workspaceId)
            .limit(1);
      workspaceId = available[0]?.workspaceId;
      if (!workspaceId) {
        const personal = one(
          await ctx.db
            .insert(workspaces)
            .values({ name: "Personal workspace", slug: `personal-${crypto.randomUUID()}` })
            .returning(),
        );
        workspaceId = personal.id;
        await ctx.db
          .insert(workspaceMembers)
          .values({ workspaceId, userId: ctx.actor.id, role: "admin" });
      }
    }
    const reserve = await takePrefix(ctx, input.key);
    const row = one(
      await ctx.db
        .insert(projects)
        .values({
          workspaceId,
          visibility: input.visibility,
          key: input.key,
          name: input.name,
          description: input.description,
          position: endPosition(projectPositions, eq(projects.workspaceId, workspaceId)),
        })
        .returning(),
    );
    await reserve(row.id);
    await ctx.db.insert(members).values({ projectId: row.id, userId: ctx.actor.id, role: "admin" });
    await seedWorkflow(ctx, row.id);
    await publish({ ...ctx, project: toProject(row) }, "project.created", null, {
      projectId: row.id,
    });
    return row;
  },
  async update_project(ctx, input) {
    const current = project(ctx);
    assertVersion(current, input.expectedVersion, "project");
    const key = input.key ?? current.key;
    if (key !== current.key) {
      const reserve = await takePrefix(ctx, key, current.id);
      await reserve(current.id);
      // Tickets take the new prefix; their earlier keys resolve through the reserved one.
      await ctx.db
        .update(tickets)
        .set({ key: sql`${key}::text || '-' || ${tickets.number}` })
        .where(eq(tickets.projectId, current.id));
    }
    const row = one(
      await ctx.db
        .update(projects)
        .set({
          key,
          name: input.name,
          ...(input.visibility ? { visibility: input.visibility } : {}),
          ...(input.publicReadEnabled === undefined
            ? {}
            : { publicReadEnabled: input.publicReadEnabled }),
          description: input.description,
          version: current.version + 1,
          updatedAt: new Date(),
        })
        .where(eq(projects.id, current.id))
        .returning(),
    );
    await publish(ctx, "project.updated", null, {
      version: row.version,
      ...(row.publicReadEnabled === current.publicReadEnabled
        ? {}
        : { publicReadEnabled: row.publicReadEnabled }),
      ...(row.key === current.key ? {} : { key: row.key, previousKey: current.key }),
    });
    return row;
  },
  async move_project(ctx, input) {
    const current = project(ctx);
    assertVersion(current, input.expectedVersion, "project", "moving");
    // The neighbor must be a project of the same workspace that the caller can already see.
    const [named] = await ctx.db
        .select({ id: projects.id })
        .from(projects)
        .where(projectMatch(input.before ?? input.after ?? "")),
      anchor = (await accessibleProjectRows(ctx.db, ctx.actor, current.workspaceId)).find(
        (row) => row.id === named?.id,
      );
    if (!anchor) fail(404, "not_found", "Project was not found");
    if (anchor.id === current.id)
      fail(400, "validation_error", "A project cannot be placed next to itself");
    const row = one(
      await ctx.db
        .update(projects)
        .set({
          position: await positionNear(
            ctx,
            projectPositions,
            current.id,
            anchor.id,
            input.before ? "before" : "after",
          ),
          version: current.version + 1,
          updatedAt: new Date(),
        })
        .where(eq(projects.id, current.id))
        .returning(),
    );
    await publish(ctx, "project.updated", null, {
      version: row.version,
      changedFields: ["position"],
    });
    return row;
  },
  async list_members(ctx) {
    const current = project(ctx);
    const inherited = await ctx.db
      .select({
        userId: user.id,
        role: workspaceMembers.role,
        name: user.name,
        email: user.email,
        image: user.image,
      })
      .from(workspaceMembers)
      .innerJoin(user, eq(user.id, workspaceMembers.userId))
      .where(
        and(
          eq(workspaceMembers.workspaceId, current.workspaceId),
          current.visibility === "workspace" ? undefined : eq(workspaceMembers.role, "admin"),
        ),
      );
    const direct = await ctx.db
      .select({
        userId: user.id,
        role: members.role,
        name: user.name,
        email: user.email,
        image: user.image,
      })
      .from(members)
      .innerJoin(user, eq(user.id, members.userId))
      .where(eq(members.projectId, current.id));
    const people = new Map(
      inherited.map((person) => [person.userId, { ...person, source: "workspace" }]),
    );
    for (const person of direct)
      if (people.get(person.userId)?.role !== "admin")
        people.set(person.userId, { ...person, source: "project" });
    const inheritedRoles = new Map(inherited.map((person) => [person.userId, person.role]));
    return [...people.values()]
      .map((person) => ({ ...person, inheritedRole: inheritedRoles.get(person.userId) ?? null }))
      .toSorted((a, b) => a.name.localeCompare(b.name));
  },
  async set_member(ctx, input) {
    const member = await accountByEmail(ctx.db, input.email);
    const projectId = project(ctx).id;
    const existing = (
      await ctx.db
        .select()
        .from(members)
        .where(and(eq(members.projectId, projectId), eq(members.userId, member.id)))
    )[0];
    if (existing?.role === "admin" && input.role !== "admin") {
      const administrators = await ctx.db
        .select({ id: user.id })
        .from(user)
        .leftJoin(
          workspaceMembers,
          and(
            eq(workspaceMembers.workspaceId, project(ctx).workspaceId),
            eq(workspaceMembers.userId, user.id),
          ),
        )
        .where(
          and(
            eq(projectRoleSQL(user.id, projectId), "admin"),
            sql`NOT coalesce(${user.banned},false)`,
            or(ne(user.id, member.id), eq(workspaceMembers.role, "admin")),
          ),
        )
        .limit(1);
      if (!administrators.length)
        fail(409, "last_administrator", "Keep at least one project or workspace administrator");
    }
    if (input.role)
      await ctx.db
        .insert(members)
        .values({ projectId, userId: member.id, role: input.role })
        .onConflictDoUpdate({
          target: [members.projectId, members.userId],
          set: { role: input.role },
        });
    else
      await ctx.db
        .delete(members)
        .where(and(eq(members.projectId, projectId), eq(members.userId, member.id)));
    await publish(ctx, "membership.updated", null, { userId: member.id, role: input.role });
    return { ok: true };
  },
  async list_views(ctx) {
    const rows = await ctx.db
      .select()
      .from(views)
      .where(and(eq(views.projectId, project(ctx).id), eq(views.userId, ctx.actor.id)))
      .orderBy(views.name);
    return rows.map((row) => ({ ...row, filters: ticketFilter.parse(row.filters) }));
  },
  async save_view(ctx, input) {
    return one(
      await ctx.db
        .insert(views)
        .values({
          projectId: project(ctx).id,
          userId: ctx.actor.id,
          name: input.name,
          filters: input.filters,
        })
        .returning({ id: views.id }),
    );
  },
  async delete_view(ctx, input) {
    one(
      await ctx.db
        .delete(views)
        .where(
          and(
            eq(views.projectId, project(ctx).id),
            eq(views.userId, ctx.actor.id),
            eq(views.id, input.viewId),
          ),
        )
        .returning(),
    );
    return { ok: true };
  },
};
