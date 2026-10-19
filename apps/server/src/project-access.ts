import { and, eq, inArray, isNotNull, isNull, or, sql, type SQLWrapper } from "drizzle-orm";
import { z } from "zod";
import { roles } from "@kanvil/contracts";
import { projects } from "./schema.ts";
import { user } from "./auth-schema.ts";
import type { Actor, Context } from "./domain.ts";
// One effective-role rule serves requests, discovery, notifications, and delivery revalidation.
// A deleted project grants no role. `workspaceId` evaluates the role as if the project lived there,
// which is how a workspace move previews who loses or gains access.
export function projectRoleSQL(
  userId: string | SQLWrapper,
  projectId: string | SQLWrapper,
  workspaceId?: string,
) {
  return sql<string | null>`(SELECT CASE WHEN wm.role = 'admin' THEN 'admin'
    WHEN pm.role IS NOT NULL THEN pm.role
    WHEN p.visibility = 'workspace' THEN wm.role ELSE NULL END
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
export async function projectRole(
  db: Context["db"],
  actor: Actor,
  row: typeof projects.$inferSelect,
) {
  if (actor.admin) return "admin" as const;
  const result = (
    await db
      .select({ role: projectRoleSQL(actor.id, row.id) })
      .from(projects)
      .where(eq(projects.id, row.id))
  )[0];
  return z.enum(roles).safeParse(result?.role).data;
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
