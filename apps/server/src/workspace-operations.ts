import { and, count, eq, inArray, isNull, ne, sql } from "drizzle-orm";
import {
  isSeededRole,
  permissions,
  roleCategory,
  roleLabels,
  roles,
  seededPermissions,
  workspaceSchema,
  type Permission,
  type WorkspaceRole,
} from "@kanvil/contracts";
import { user } from "./auth-schema.ts";
import { members, projects, workspaceRoles, workspaces, workspaceMembers } from "./schema.ts";
import {
  accessibleProjectRows,
  instanceAdministration,
  permissionsOf,
  type Access,
} from "./project-access.ts";
import {
  accountByEmail,
  assertGrantable,
  assertVersion,
  capabilities,
  workspace,
  fail,
  publishMany,
  requirePermission,
  type Context,
  type Handlers,
  one,
} from "./domain.ts";
// The caller's membership of a workspace, checked against the action an operation needs.
export async function requireWorkspace(
  ctx: Context,
  workspaceId: string,
  permission: Permission | null,
) {
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
  // Outsiders asking to administer hear that it needs administration; anything else is not found.
  if (!ctx.actor.admin && !membership) {
    if (permission && permission !== "ticket.write") requirePermission([], permission, "workspace");
    fail(404, "workspace_access_required", "Workspace was not found");
  }
  const access: Access =
    membership && !ctx.actor.admin
      ? await membershipAccess(ctx, membership)
      : instanceAdministration;
  requirePermission(access.permissions, permission, "workspace");
  return {
    ...access,
    workspace: workspaceSchema.parse({
      ...row,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
      role: access.role,
      roleId: access.roleId,
      capabilities: capabilities(ctx.actor, access.permissions),
    }),
  };
}
const heldRole = (held: { role: string; roleId: string | null }) => held.roleId ?? held.role;
async function membershipAccess(
  ctx: Context,
  held: { role: string; roleId: string | null },
): Promise<Access> {
  const id = heldRole(held);
  return {
    role: roles.find((role) => role === held.role) ?? "reader",
    roleId: id,
    permissions: (await permissionsOf(ctx.db, [id]))(id),
  };
}
// What storing a role ID on a membership writes: its seeded stand-in and, for a custom role, its
// ID. A custom role must belong to the workspace.
export async function assignment(ctx: Context, workspaceId: string, id: string) {
  if (isSeededRole(id))
    return { role: id, roleId: null, permissions: seededPermissions[id] } as const;
  const row = (
    await ctx.db
      .select()
      .from(workspaceRoles)
      .where(and(eq(workspaceRoles.id, id), eq(workspaceRoles.workspaceId, workspaceId)))
  )[0];
  if (!row) fail(404, "not_found", "This role is not defined in the workspace");
  const granted = row.permissions.filter(isPermission);
  return { role: roleCategory(granted), roleId: row.id, permissions: granted } as const;
}
const isPermission = (value: string): value is Permission =>
  permissions.some((item) => item === value);
// Changing or removing a membership needs every action it grants now, so no one demotes or
// removes someone holding more than they do.
export async function assertHeldGrantable(ctx: Context, id: string | null | undefined) {
  if (id) assertGrantable(ctx, (await permissionsOf(ctx.db, [id]))(id), id);
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
    const granted = await permissionsOf(ctx.db, memberships.map(heldRole));
    return rows.map((row) => {
      const held = ctx.actor.admin
        ? { role: "admin", roleId: null }
        : memberships.find((m) => m.workspaceId === row.id);
      if (ctx.actor.projectIds || !held)
        return { ...row, role: null, roleId: null, capabilities: [] };
      const id = heldRole(held);
      return {
        ...row,
        role: held.role,
        roleId: id,
        capabilities: capabilities(ctx.actor, granted(id)),
      };
    });
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
    return {
      ...row,
      role: "admin",
      roleId: "admin",
      capabilities: capabilities(ctx.actor, permissions),
    };
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
    return { ...current, ...row };
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
        roleId: sql<string>`coalesce(${workspaceMembers.roleId}::text, ${workspaceMembers.role})`,
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
    const target = input.role ? await assignment(ctx, current.id, input.role) : null;
    if (target) assertGrantable(ctx, target.permissions, target.role);
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
    await assertHeldGrantable(ctx, existing && heldRole(existing));
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
    if (target)
      await ctx.db
        .insert(workspaceMembers)
        .values({
          workspaceId: input.workspaceId,
          userId: person.id,
          role: target.role,
          roleId: target.roleId,
        })
        .onConflictDoUpdate({
          target: [workspaceMembers.workspaceId, workspaceMembers.userId],
          set: { role: target.role, roleId: target.roleId },
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
      role: target?.role ?? null,
      roleId: input.role,
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
    return { ...current, ...row };
  },
};
// The seeded roles first, then the workspace's own, each with how many workspace and project
// memberships hold it.
export async function rolesOf(ctx: Context, workspaceId: string): Promise<WorkspaceRole[]> {
  const custom = await ctx.db
    .select()
    .from(workspaceRoles)
    .where(eq(workspaceRoles.workspaceId, workspaceId))
    .orderBy(workspaceRoles.name);
  const workspaceHeld = sql<string>`coalesce(${workspaceMembers.roleId}::text, ${workspaceMembers.role})`,
    projectHeld = sql<string>`coalesce(${members.roleId}::text, ${members.role})`;
  const held = [
    ...(await ctx.db
      .select({ id: workspaceHeld, count: count() })
      .from(workspaceMembers)
      .where(eq(workspaceMembers.workspaceId, workspaceId))
      .groupBy(workspaceHeld)),
    ...(await ctx.db
      .select({ id: projectHeld, count: count() })
      .from(members)
      .innerJoin(projects, eq(projects.id, members.projectId))
      .where(eq(projects.workspaceId, workspaceId))
      .groupBy(projectHeld)),
  ];
  const assigned = (id: string) =>
    held.filter((entry) => entry.id === id).reduce((sum, entry) => sum + entry.count, 0);
  return [
    ...roles.map((id) => ({
      id,
      name: roleLabels[id],
      permissions: [...seededPermissions[id]],
      seeded: true,
      assigned: assigned(id),
      version: 1,
    })),
    ...custom.map((row) => ({
      id: row.id,
      name: row.name,
      permissions: row.permissions.filter(isPermission),
      seeded: false,
      assigned: assigned(row.id),
      version: row.version,
    })),
  ];
}
// The seeded roles' names stay reserved in every spelling clients show.
const reservedNames = new Set(
  [...roles, ...Object.values(roleLabels)].map((name) => name.toLowerCase()),
);
async function assertRoleName(ctx: Context, workspaceId: string, name: string, except?: string) {
  const taken =
    reservedNames.has(name.toLowerCase()) ||
    (
      await ctx.db
        .select({ id: workspaceRoles.id })
        .from(workspaceRoles)
        .where(
          and(
            eq(workspaceRoles.workspaceId, workspaceId),
            sql`lower(${workspaceRoles.name}) = ${name.toLowerCase()}`,
            except ? ne(workspaceRoles.id, except) : undefined,
          ),
        )
    ).length > 0;
  if (taken) fail(409, "duplicate_role", "A role with this name already exists in the workspace");
}
async function customRole(ctx: Context, roleId: string, expectedVersion: number) {
  const row = one(
    await ctx.db
      .select()
      .from(workspaceRoles)
      .where(and(eq(workspaceRoles.id, roleId), eq(workspaceRoles.workspaceId, workspace(ctx).id))),
  );
  assertVersion(row, expectedVersion, "role");
  return row;
}
const ordered = (granted: readonly Permission[]) =>
  permissions.filter((permission) => granted.includes(permission));
const describe = async (ctx: Context, row: typeof workspaceRoles.$inferSelect) =>
  one((await rolesOf(ctx, row.workspaceId)).filter((role) => role.id === row.id));
// Moves every membership holding one role to another, rewriting the stand-in with it.
async function reassign(ctx: Context, from: string, to: { role: string; roleId: string | null }) {
  const values = { role: to.role, roleId: to.roleId };
  await ctx.db.update(workspaceMembers).set(values).where(eq(workspaceMembers.roleId, from));
  await ctx.db.update(members).set(values).where(eq(members.roleId, from));
}
export const roleHandlers: Pick<
  Handlers,
  | "list_workspace_roles"
  | "create_workspace_role"
  | "update_workspace_role"
  | "delete_workspace_role"
> = {
  async list_workspace_roles(ctx) {
    return rolesOf(ctx, workspace(ctx).id);
  },
  async create_workspace_role(ctx, input) {
    const current = workspace(ctx),
      granted = ordered(input.permissions);
    assertGrantable(ctx, granted);
    await assertRoleName(ctx, current.id, input.name);
    const row = one(
      await ctx.db
        .insert(workspaceRoles)
        .values({ workspaceId: current.id, name: input.name, permissions: granted })
        .returning(),
    );
    await publishWorkspace(ctx, current.id, "role.created", { roleId: row.id });
    return describe(ctx, row);
  },
  // Every membership holding the role changes with it in this write, its stand-in included.
  async update_workspace_role(ctx, input) {
    const current = await customRole(ctx, input.roleId, input.expectedVersion),
      granted = ordered(input.permissions);
    assertGrantable(ctx, [...current.permissions.filter(isPermission), ...granted]);
    await assertRoleName(ctx, current.workspaceId, input.name, current.id);
    const row = one(
      await ctx.db
        .update(workspaceRoles)
        .set({
          name: input.name,
          permissions: granted,
          version: current.version + 1,
          updatedAt: new Date(),
        })
        .where(eq(workspaceRoles.id, current.id))
        .returning(),
    );
    await reassign(ctx, row.id, { role: roleCategory(granted), roleId: row.id });
    await publishWorkspace(ctx, row.workspaceId, "role.updated", {
      roleId: row.id,
      version: row.version,
    });
    return describe(ctx, row);
  },
  async delete_workspace_role(ctx, input) {
    const current = await customRole(ctx, input.roleId, input.expectedVersion);
    assertGrantable(ctx, current.permissions.filter(isPermission));
    const { assigned } = await describe(ctx, current);
    if (input.reassignTo === current.id)
      fail(400, "validation_error", "Choose another role for its members");
    if (assigned && !input.reassignTo)
      fail(409, "role_in_use", "Choose a role for the members who hold this one", { assigned });
    if (assigned && input.reassignTo) {
      const target = await assignment(ctx, current.workspaceId, input.reassignTo);
      assertGrantable(ctx, target.permissions, target.role);
      await reassign(ctx, current.id, target);
    }
    await ctx.db.delete(workspaceRoles).where(eq(workspaceRoles.id, current.id));
    await publishWorkspace(ctx, current.workspaceId, "role.deleted", {
      roleId: current.id,
      reassignTo: assigned ? (input.reassignTo ?? null) : null,
    });
    return { ok: true };
  },
};
