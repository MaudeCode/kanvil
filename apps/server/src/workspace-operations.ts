import { and, eq, inArray, sql } from "drizzle-orm";
import { projectSchema } from "@kanvil/contracts";
import { user } from "./auth-schema.ts";
import { members, projects, workspaces, workspaceMembers } from "./schema.ts";
import { accessibleProjectRows } from "./project-access.ts";
import { fail, publish, requireRow, type Context, type Handlers } from "./domain.ts";
export async function requireWorkspace(ctx: Context, workspaceId: string, admin = false) {
  if (ctx.actor.projectIds)
    fail(403, "workspace_scope_required", "Use an account with workspace access for this action");
  const row = requireRow(
    (await ctx.db.select().from(workspaces).where(eq(workspaces.id, workspaceId)))[0],
  );
  const membership = (
    await ctx.db
      .select()
      .from(workspaceMembers)
      .where(
        and(
          eq(workspaceMembers.workspaceId, workspaceId),
          eq(workspaceMembers.userId, ctx.actor.id),
        ),
      )
  )[0];
  if (!ctx.actor.admin && (!membership || (admin && membership.role !== "admin")))
    fail(
      admin ? 403 : 404,
      "workspace_access_required",
      admin ? "Workspace administrator access is required" : "Workspace was not found",
    );
  return { ...row, role: ctx.actor.admin ? "admin" : membership!.role };
}
export async function publishWorkspace(
  ctx: Context,
  workspaceId: string,
  type: string,
  data: Record<string, unknown>,
) {
  for (const row of await ctx.db
    .select()
    .from(projects)
    .where(eq(projects.workspaceId, workspaceId))) {
    await publish(
      {
        ...ctx,
        project: projectSchema.parse({
          ...row,
          createdAt: row.createdAt.toISOString(),
          updatedAt: row.updatedAt.toISOString(),
        }),
      },
      type,
      null,
      { workspaceId, ...data },
    );
  }
}
export const workspaceHandlers: Pick<
  Handlers,
  | "list_workspaces"
  | "create_workspace"
  | "update_workspace"
  | "list_workspace_members"
  | "set_workspace_member"
> = {
  async list_workspaces(ctx) {
    const allowed = await accessibleProjectRows(ctx.db, ctx.actor);
    const memberships = await ctx.db
      .select()
      .from(workspaceMembers)
      .where(eq(workspaceMembers.userId, ctx.actor.id));
    const ids = [
      ...new Set([
        ...allowed.map((row) => row.workspaceId),
        ...(!ctx.actor.projectIds ? memberships.map((row) => row.workspaceId) : []),
      ]),
    ];
    const rows = await ctx.db
      .select()
      .from(workspaces)
      .where(
        ctx.actor.admin && !ctx.actor.projectIds
          ? undefined
          : ids.length
            ? inArray(workspaces.id, ids)
            : sql`false`,
      )
      .orderBy(workspaces.name);
    return rows.map((row) => ({
      ...row,
      role: ctx.actor.projectIds
        ? null
        : ctx.actor.admin
          ? "admin"
          : (memberships.find((m) => m.workspaceId === row.id)?.role ?? null),
    }));
  },
  async create_workspace(ctx, input) {
    if (ctx.actor.projectIds)
      fail(403, "workspace_scope_required", "Project-bound credentials cannot create workspaces");
    if ((await ctx.db.select().from(workspaces).where(eq(workspaces.slug, input.slug))).length)
      fail(409, "duplicate_workspace", "This workspace URL key is already in use");
    const row = requireRow(
      (
        await ctx.db
          .insert(workspaces)
          .values({ name: input.name, slug: input.slug, description: input.description })
          .returning()
      )[0],
    );
    await ctx.db
      .insert(workspaceMembers)
      .values({ workspaceId: row.id, userId: ctx.actor.id, role: "admin" });
    return { ...row, role: "admin" };
  },
  async update_workspace(ctx, input) {
    const current = await requireWorkspace(ctx, input.workspaceId, true);
    if (current.version !== input.expectedVersion)
      fail(409, "version_conflict", "Workspace settings changed. Reopen the editor before saving.");
    const row = requireRow(
      (
        await ctx.db
          .update(workspaces)
          .set({
            name: input.name,
            description: input.description,
            version: current.version + 1,
            updatedAt: new Date(),
          })
          .where(eq(workspaces.id, current.id))
          .returning()
      )[0],
    );
    await publishWorkspace(ctx, row.id, "workspace.updated", { version: row.version });
    return { ...row, role: current.role };
  },
  async list_workspace_members(ctx, input) {
    await requireWorkspace(ctx, input.workspaceId);
    return ctx.db
      .select({
        userId: user.id,
        name: user.name,
        email: user.email,
        image: user.image,
        role: workspaceMembers.role,
      })
      .from(workspaceMembers)
      .innerJoin(user, eq(user.id, workspaceMembers.userId))
      .where(eq(workspaceMembers.workspaceId, input.workspaceId))
      .orderBy(user.name);
  },
  async set_workspace_member(ctx, input) {
    await requireWorkspace(ctx, input.workspaceId, true);
    const person = requireRow(
      (await ctx.db.select().from(user).where(eq(user.email, input.email.toLowerCase())))[0],
    );
    const existing = (
      await ctx.db
        .select()
        .from(workspaceMembers)
        .where(
          and(
            eq(workspaceMembers.workspaceId, input.workspaceId),
            eq(workspaceMembers.userId, person.id),
          ),
        )
    )[0];
    if (existing?.role === "admin" && input.role !== "admin") {
      const admins = await ctx.db
        .select()
        .from(workspaceMembers)
        .where(
          and(
            eq(workspaceMembers.workspaceId, input.workspaceId),
            eq(workspaceMembers.role, "admin"),
          ),
        );
      if (admins.length <= 1)
        fail(409, "last_administrator", "Keep at least one workspace administrator");
    }
    if (input.role)
      await ctx.db
        .insert(workspaceMembers)
        .values({ workspaceId: input.workspaceId, userId: person.id, role: input.role })
        .onConflictDoUpdate({
          target: [workspaceMembers.workspaceId, workspaceMembers.userId],
          set: { role: input.role },
        });
    else {
      await ctx.db
        .delete(workspaceMembers)
        .where(
          and(
            eq(workspaceMembers.workspaceId, input.workspaceId),
            eq(workspaceMembers.userId, person.id),
          ),
        );
      await ctx.db
        .delete(members)
        .where(
          and(
            eq(members.userId, person.id),
            inArray(
              members.projectId,
              ctx.db
                .select({ id: projects.id })
                .from(projects)
                .where(eq(projects.workspaceId, input.workspaceId)),
            ),
          ),
        );
    }
    await publishWorkspace(ctx, input.workspaceId, "membership.updated", {
      userId: person.id,
      role: input.role,
    });
    return { ok: true };
  },
};
