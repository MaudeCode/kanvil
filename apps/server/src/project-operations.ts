import { and, eq, inArray, sql } from "drizzle-orm";
import { user } from "./auth-schema.ts";
import { members, projects, views } from "./schema.ts";
import { fail, project, publish, requireRow, type Handlers } from "./domain.ts";

export const projectHandlers: Pick<
  Handlers,
  | "list_projects"
  | "create_project"
  | "update_project"
  | "list_members"
  | "set_member"
  | "list_views"
  | "save_view"
  | "delete_view"
> = {
  async list_projects(ctx) {
    const memberships = await ctx.db
      .select({ projectId: members.projectId })
      .from(members)
      .where(eq(members.userId, ctx.actor.id));
    const ids = ctx.actor.admin ? undefined : memberships.map((row) => row.projectId);
    if (ids && !ids.length) return [];
    return ctx.db
      .select()
      .from(projects)
      .where(
        and(
          ids ? inArray(projects.id, ids) : undefined,
          ctx.actor.projectIds
            ? ctx.actor.projectIds.length
              ? inArray(projects.id, [...ctx.actor.projectIds])
              : sql`false`
            : undefined,
        ),
      )
      .orderBy(projects.name);
  },
  async create_project(ctx, input) {
    if (ctx.actor.projectIds)
      fail(403, "insufficient_scope", "Project-bound credentials cannot create projects");
    if (
      (await ctx.db.select({ id: projects.id }).from(projects).where(eq(projects.key, input.key)))
        .length
    )
      fail(409, "duplicate_prefix", "This project prefix is already in use");
    const row = requireRow(
      (
        await ctx.db
          .insert(projects)
          .values({ key: input.key, name: input.name, description: input.description })
          .returning()
      )[0],
    );
    await ctx.db.insert(members).values({ projectId: row.id, userId: ctx.actor.id, role: "admin" });
    await publish(
      {
        ...ctx,
        project: {
          ...row,
          createdAt: row.createdAt.toISOString(),
          updatedAt: row.updatedAt.toISOString(),
        },
      },
      "project.created",
      null,
      { projectId: row.id },
    );
    return row;
  },
  async update_project(ctx, input) {
    const current = project(ctx);
    if (current.version !== input.expectedVersion)
      fail(409, "version_conflict", "The project changed; reload before editing", {
        currentVersion: current.version,
      });
    const row = requireRow(
      (
        await ctx.db
          .update(projects)
          .set({
            name: input.name,
            description: input.description,
            version: current.version + 1,
            updatedAt: new Date(),
          })
          .where(eq(projects.id, current.id))
          .returning()
      )[0],
    );
    await publish(ctx, "project.updated", null, { version: row.version });
    return row;
  },
  async list_members(ctx) {
    return ctx.db
      .select({ userId: members.userId, role: members.role, name: user.name, email: user.email })
      .from(members)
      .innerJoin(user, eq(user.id, members.userId))
      .where(eq(members.projectId, project(ctx).id));
  },
  async set_member(ctx, input) {
    const member = requireRow(
      (
        await ctx.db.select().from(user).where(eq(user.email, input.email.toLowerCase())).limit(1)
      )[0],
    );
    const projectId = project(ctx).id;
    const existing = (
      await ctx.db
        .select()
        .from(members)
        .where(and(eq(members.projectId, projectId), eq(members.userId, member.id)))
    )[0];
    if (existing?.role === "admin" && input.role !== "admin") {
      const administrators = await ctx.db
        .select()
        .from(members)
        .where(and(eq(members.projectId, projectId), eq(members.role, "admin")));
      if (administrators.length === 1)
        fail(409, "last_administrator", "Keep at least one project administrator");
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
    return ctx.db
      .select()
      .from(views)
      .where(and(eq(views.projectId, project(ctx).id), eq(views.userId, ctx.actor.id)))
      .orderBy(views.name);
  },
  async save_view(ctx, input) {
    return requireRow(
      (
        await ctx.db
          .insert(views)
          .values({
            projectId: project(ctx).id,
            userId: ctx.actor.id,
            name: input.name,
            filters: input.filters,
          })
          .returning({ id: views.id })
      )[0],
    );
  },
  async delete_view(ctx, input) {
    requireRow(
      (
        await ctx.db
          .delete(views)
          .where(
            and(
              eq(views.projectId, project(ctx).id),
              eq(views.userId, ctx.actor.id),
              eq(views.id, input.viewId),
            ),
          )
          .returning()
      )[0],
    );
    return { ok: true };
  },
};
