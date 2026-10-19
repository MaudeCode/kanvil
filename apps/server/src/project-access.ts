import { and, eq, inArray, isNotNull, isNull, or, sql, type SQLWrapper } from "drizzle-orm";
import { z } from "zod";
import {
  isSeededRole,
  permissions,
  roles,
  seededPermissions,
  type Permission,
  type Role,
} from "@kanvil/contracts";
import { projects, workspaceRoles } from "./schema.ts";
import { user } from "./auth-schema.ts";
import type { Actor, Context } from "./domain.ts";
// One effective-role rule serves requests, discovery, notifications, and delivery revalidation.
// A deleted project grants no role. `workspaceId` evaluates the role as if the project lived there,
// which is how a workspace move previews who loses or gains access. `held: "id"` names the role
// itself, a custom role's ID where one is held; the default is its seeded stand-in.
export function projectRoleSQL(
  userId: string | SQLWrapper,
  projectId: string | SQLWrapper,
  workspaceId?: string,
  held: "role" | "id" = "role",
) {
  const pick = (member: "pm" | "wm") =>
    sql.raw(held === "id" ? `coalesce(${member}.role_id::text, ${member}.role)` : `${member}.role`);
  return sql<string | null>`(SELECT CASE WHEN wm.role = 'admin' THEN 'admin'
    WHEN pm.role IS NOT NULL THEN ${pick("pm")}
    WHEN p.visibility = 'workspace' THEN ${pick("wm")} ELSE NULL END
    FROM projects p
    LEFT JOIN project_members pm ON pm.project_id = p.id AND pm.user_id = ${userId}
    LEFT JOIN workspace_members wm ON wm.workspace_id = ${workspaceId ? sql`${workspaceId}::uuid` : sql`p.workspace_id`} AND wm.user_id = ${userId}
    WHERE p.id = ${projectId} AND p.deleted_at IS NULL)`;
}
// A joined user who is active and can read the project, directly or as an instance administrator.
export const readsProject = (projectId: SQLWrapper) =>
  and(
    or(
      isNotNull(projectRoleSQL(user.id, projectId)),
      sql`'admin' = any(string_to_array(${user.role}, ','))`,
    ),
    sql`not coalesce(${user.banned}, false)`,
  );
const known = (value: string): value is Permission => permissions.some((item) => item === value);
// The current actions of each role ID: a seeded role's fixed set or a custom role's stored row,
// read in one query for any number of IDs.
export async function permissionsOf(
  db: Context["db"],
  ids: readonly (string | null | undefined)[],
) {
  const custom = [...new Set(ids.filter((id): id is string => !!id && !isSeededRole(id)))];
  const rows = custom.length
    ? await db
        .select({ id: workspaceRoles.id, permissions: workspaceRoles.permissions })
        .from(workspaceRoles)
        .where(inArray(workspaceRoles.id, custom))
    : [];
  const stored = new Map(rows.map((row) => [row.id, row.permissions.filter(known)]));
  return (id: string | null | undefined): readonly Permission[] =>
    !id ? [] : isSeededRole(id) ? seededPermissions[id] : (stored.get(id) ?? []);
}
// What one membership holds: the seeded role older clients see, the role itself, and its actions.
export interface Access {
  role: Role;
  roleId: string;
  permissions: readonly Permission[];
}
export const instanceAdministration: Access = {
  role: "admin",
  roleId: "admin",
  permissions: seededPermissions.admin,
};
export async function projectAccess(
  db: Context["db"],
  actor: Actor,
  row: typeof projects.$inferSelect,
): Promise<Access | undefined> {
  if (actor.admin) return instanceAdministration;
  const result = (
    await db
      .select({
        role: projectRoleSQL(actor.id, row.id),
        roleId: projectRoleSQL(actor.id, row.id, undefined, "id"),
      })
      .from(projects)
      .where(eq(projects.id, row.id))
  )[0];
  const role = z.enum(roles).safeParse(result?.role).data;
  if (!role || !result?.roleId) return undefined;
  return {
    role,
    roleId: result.roleId,
    permissions: (await permissionsOf(db, [result.roleId]))(result.roleId),
  };
}
// Deleted projects never appear. Archived ones do unless the caller lists only active work.
export async function accessibleProjectRows(
  db: Context["db"],
  actor: Actor,
  workspaceId?: string,
  archived: "include" | "exclude" | "only" = "include",
) {
  return db
    .select()
    .from(projects)
    .where(
      and(
        isNull(projects.deletedAt),
        archived === "include"
          ? undefined
          : archived === "only"
            ? isNotNull(projects.archivedAt)
            : isNull(projects.archivedAt),
        workspaceId ? eq(projects.workspaceId, workspaceId) : undefined,
        actor.admin ? undefined : isNotNull(projectRoleSQL(actor.id, projects.id)),
        actor.projectIds
          ? actor.projectIds.length
            ? inArray(projects.id, [...actor.projectIds])
            : sql`false`
          : undefined,
      ),
    )
    .orderBy(projects.position, projects.name);
}
