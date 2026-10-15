import { and, eq, inArray } from "drizzle-orm";
import { user } from "./auth-schema.ts";
import { projectSchema } from "@kanvil/contracts";
import { accessibleProjectRows } from "./project-access.ts";
import { requireWorkspace } from "./workspace-operations.ts";
import { members, projects, views, workspaces, workspaceMembers } from "./schema.ts";
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
  async list_projects(ctx, input) {
    return accessibleProjectRows(ctx.db, ctx.actor, input.workspaceId);
  },
  async create_project(ctx, input) {
    if (ctx.actor.projectIds)
      fail(403, "insufficient_scope", "Project-bound credentials cannot create projects");
    let workspaceId = input.workspaceId;
    if (workspaceId) {
      const workspace = await requireWorkspace(ctx, workspaceId);
      if (workspace.role === "reader")
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
        const personal = requireRow(
          (
            await ctx.db
              .insert(workspaces)
              .values({ name: "Personal workspace", slug: `personal-${crypto.randomUUID()}` })
              .returning()
          )[0],
        );
        workspaceId = personal.id;
        await ctx.db
          .insert(workspaceMembers)
          .values({ workspaceId, userId: ctx.actor.id, role: "admin" });
      }
    }
    if (
      (await ctx.db.select({ id: projects.id }).from(projects).where(eq(projects.key, input.key)))
        .length
    )
      fail(409, "duplicate_prefix", "This project prefix is already in use");
    const row = requireRow(
      (
        await ctx.db
          .insert(projects)
          .values({
            workspaceId,
            visibility: input.visibility,
            key: input.key,
            name: input.name,
            description: input.description,
          })
          .returning()
      )[0],
    );
    await ctx.db.insert(members).values({ projectId: row.id, userId: ctx.actor.id, role: "admin" });
    await publish(
      {
        ...ctx,
        project: projectSchema.parse({
          ...row,
          createdAt: row.createdAt.toISOString(),
          updatedAt: row.updatedAt.toISOString(),
        }),
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
            ...(input.visibility ? { visibility: input.visibility } : {}),
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
    return [...people.values()].toSorted((a, b) => a.name.localeCompare(b.name));
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
