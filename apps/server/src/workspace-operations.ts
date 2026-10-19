import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { workspaceSchema } from "@kanvil/contracts";
import { user } from "./auth-schema.ts";
import { members, projects, workspaces, workspaceMembers } from "./schema.ts";
import { accessibleProjectRows } from "./project-access.ts";
import {
  accountByEmail,
  assertVersion,
  workspace,
  fail,
  publishMany,
  type Context,
  type Handlers,
  one,
} from "./domain.ts";
export async function requireWorkspace(ctx: Context, workspaceId: string, admin = false) {
  if (ctx.actor.projectIds)
    fail(403, "workspace_scope_required", "Use an account with workspace access for this action");
  const row = one(
    await ctx.db
      .select()
      .from(workspaces)
      .where(and(eq(workspaces.id, workspaceId), isNull(workspaces.deletedAt))),
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
  return workspaceSchema.parse({
    ...row,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    role: ctx.actor.admin ? "admin" : membership!.role,
  });
}
// Transferring and deleting a workspace belong to its owner; instance administrators can act for
// any workspace, which is also how an unowned one gets an owner.
export function requireOwner(ctx: Context) {
  const current = workspace(ctx);
  if (!ctx.actor.admin && current.ownerId !== ctx.actor.id)
    fail(403, "forbidden", "Only the workspace owner can do this");
  return current;
}
export async function publishWorkspace(
  ctx: Context,
  workspaceId: string,
  type: string,
  data: Record<string, unknown>,
) {
  const rows = await ctx.db
    .select({ id: projects.id })
    .from(projects)
    .where(and(eq(projects.workspaceId, workspaceId), isNull(projects.deletedAt)));
  await publishMany(
    ctx,
    rows.map((row) => ({
      type,
      ticketId: null,
      projectId: row.id,
      data: { workspaceId, ...data },
    })),
  );
}
export const workspaceHandlers: Pick<
  Handlers,
  | "list_workspaces"
  | "create_workspace"
  | "update_workspace"
  | "list_workspace_members"
  | "set_workspace_member"
  | "transfer_workspace"
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
        and(
          isNull(workspaces.deletedAt),
          ctx.actor.admin && !ctx.actor.projectIds
            ? undefined
            : ids.length
              ? inArray(workspaces.id, ids)
              : sql`false`,
        ),
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
    const row = one(
      await ctx.db
        .insert(workspaces)
        .values({
          name: input.name,
          slug: input.slug,
          description: input.description,
          ownerId: ctx.actor.id,
        })
        .returning(),
    );
    await ctx.db
      .insert(workspaceMembers)
      .values({ workspaceId: row.id, userId: ctx.actor.id, role: "admin" });
    return { ...row, role: "admin" };
  },
  async update_workspace(ctx, input) {
    const current = workspace(ctx);
    assertVersion(current, input.expectedVersion, "workspace", "saving");
    const row = one(
      await ctx.db
        .update(workspaces)
        .set({
          name: input.name,
          description: input.description,
          version: current.version + 1,
          updatedAt: new Date(),
        })
        .where(eq(workspaces.id, current.id))
        .returning(),
    );
    await publishWorkspace(ctx, row.id, "workspace.updated", { version: row.version });
    return { ...row, role: current.role };
  },
  async list_workspace_members(ctx, input) {
    workspace(ctx);
    return ctx.db
      .select({
        userId: user.id,
        name: user.name,
        email: user.email,
        image: user.image,
        role: workspaceMembers.role,
        disabled: sql<boolean>`coalesce(${user.banned}, false)`,
      })
      .from(workspaceMembers)
      .innerJoin(user, eq(user.id, workspaceMembers.userId))
      .where(eq(workspaceMembers.workspaceId, input.workspaceId))
      .orderBy(user.name);
  },
  async set_workspace_member(ctx, input) {
    const current = workspace(ctx);
    const person = await accountByEmail(ctx.db, input.email);
    if (person.id === current.ownerId && input.role !== "admin")
      fail(
        409,
        "workspace_owner",
        "Transfer ownership before removing or demoting the workspace owner",
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
  // Writes run one at a time under the domain lock, and removal, demotion, and account disabling
  // all refuse the owner, so the destination checked here is still an active administrator when
  // the transfer commits.
  async transfer_workspace(ctx, input) {
    const current = requireOwner(ctx);
    assertVersion(current, input.expectedVersion, "workspace", "transferring it");
    if (input.userId === current.ownerId)
      fail(400, "validation_error", "This person already owns the workspace");
    const [eligible] = await ctx.db
      .select({ id: user.id })
      .from(workspaceMembers)
      .innerJoin(user, eq(user.id, workspaceMembers.userId))
      .where(
        and(
          eq(workspaceMembers.workspaceId, current.id),
          eq(workspaceMembers.userId, input.userId),
          eq(workspaceMembers.role, "admin"),
          sql`not coalesce(${user.banned}, false)`,
        ),
      );
    if (!eligible)
      fail(
        409,
        "owner_ineligible",
        "Ownership can pass only to an active administrator of this workspace",
      );
    const row = one(
      await ctx.db
        .update(workspaces)
        .set({ ownerId: eligible.id, version: current.version + 1, updatedAt: new Date() })
        .where(eq(workspaces.id, current.id))
        .returning(),
    );
    await publishWorkspace(ctx, row.id, "workspace.owner_changed", {
      version: row.version,
      ownerId: row.ownerId,
      previousOwnerId: current.ownerId,
    });
    return { ...row, role: current.role };
  },
};
