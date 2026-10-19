import { and, asc, desc, eq, inArray, isNull, ne, sql } from "drizzle-orm";
import { unionAll } from "drizzle-orm/pg-core";
import { filterKey, filterList, isHexColor, ticketFilter } from "@kanvil/contracts";
import { renameFeedLabel } from "./calendar-operations.ts";
import { accessibleProjectRows, projectRoleSQL } from "./project-access.ts";
import { labelColors, projectLabels, projects, tickets, views, workspaceLabels } from "./schema.ts";
import { labelOrder, labelUsage, updateTicketRow } from "./ticket-operations.ts";
import { publishWorkspace } from "./workspace-operations.ts";
import {
  assertVersion,
  fail,
  one,
  project,
  publish,
  publishMany,
  toProject,
  workspace,
  type Context,
  type Handlers,
} from "./domain.ts";

// Within one workspace a label name is defined by the workspace or by its projects, never both,
// so a ticket's label name always resolves to one definition and color.
async function workspaceLabelNamed(
  ctx: Context,
  workspaceId: string,
  name: string,
  exceptId?: string,
) {
  return (
    await ctx.db
      .select({ id: workspaceLabels.id })
      .from(workspaceLabels)
      .where(
        and(
          eq(workspaceLabels.workspaceId, workspaceId),
          eq(workspaceLabels.name, name),
          exceptId ? ne(workspaceLabels.id, exceptId) : undefined,
        ),
      )
  ).length;
}
async function availableProjectName(ctx: Context, name: string, exceptId?: string) {
  if (
    (
      await ctx.db
        .select({ id: projectLabels.id })
        .from(projectLabels)
        .where(
          and(
            eq(projectLabels.projectId, project(ctx).id),
            eq(projectLabels.name, name),
            exceptId ? ne(projectLabels.id, exceptId) : undefined,
          ),
        )
    ).length
  )
    fail(409, "duplicate_label", "A label with this name already exists in this project.");
  if (await workspaceLabelNamed(ctx, project(ctx).workspaceId, name))
    fail(409, "duplicate_label", "A workspace label with this name already exists.");
}
// Projects that define the name themselves block a workspace label of that name until the caller
// adopts them: their definitions are removed and their tickets keep the name under the workspace's
// color. Workspace administrators manage every project in it, so the keys are theirs to see.
async function availableWorkspaceName(
  ctx: Context,
  name: string,
  adopt: boolean,
  exceptId?: string,
) {
  if (await workspaceLabelNamed(ctx, workspace(ctx).id, name, exceptId))
    fail(409, "duplicate_label", "A label with this name already exists in this workspace.");
  const defined = await ctx.db
    .select({ id: projectLabels.id, key: projects.key })
    .from(projectLabels)
    .innerJoin(projects, eq(projects.id, projectLabels.projectId))
    .where(and(eq(projects.workspaceId, workspace(ctx).id), eq(projectLabels.name, name)))
    .orderBy(projects.key);
  if (!defined.length) return;
  if (!adopt)
    fail(
      409,
      "label_conflict",
      `${defined.length === 1 ? "A project already defines" : `${defined.length} projects already define`} this label. Adopt to replace their definitions with the workspace label.`,
      { projects: defined.map((row) => row.key) },
    );
  await ctx.db.delete(projectLabels).where(
    inArray(
      projectLabels.id,
      defined.map((row) => row.id),
    ),
  );
}
// A custom color becomes part of the site-wide palette the first time a label uses it.
export async function rememberLabelColor(ctx: Context, color: string) {
  if (isHexColor(color))
    await ctx.db
      .insert(labelColors)
      .values({ value: color, createdBy: ctx.actor.id })
      .onConflictDoNothing();
}
// Renames or removes a label in the context project: tickets through the versioned, claim-checked
// update, then saved-view filters and calendar feeds.
async function changeLabelUsage(ctx: Context, name: string, replacement?: string) {
  const affected = await ctx.db
    .select()
    .from(tickets)
    .where(and(eq(tickets.projectId, project(ctx).id), sql`${name} = ANY(${tickets.labels})`));
  const pending = [];
  for (const ticket of affected)
    pending.push(
      (
        await updateTicketRow(ctx, {
          projectId: project(ctx).id,
          ticketId: ticket.id,
          expectedVersion: ticket.version,
          changes: {
            // An adopting rename can land on a name the ticket already carries.
            labels: [
              ...new Set(
                replacement
                  ? ticket.labels.map((tag) => (tag === name ? replacement : tag))
                  : ticket.labels.filter((tag) => tag !== name),
              ),
            ],
          },
        })
      ).event,
    );
  await publishMany(ctx, pending);
  await rewriteViewFilters(ctx, "label", (tag) => (tag !== name ? tag : (replacement ?? null)));
  if (replacement) await renameFeedLabel(ctx, name, replacement);
}
// Rewrites one filter field in the context project's saved views: `rename` maps each value to its
// replacement, or to null to drop it. Saved filters hold a list, or a single value from before
// lists existed. A rename can land on a value the view excludes; the included value wins.
export async function rewriteViewFilters(
  ctx: Context,
  field: "label" | "customField",
  rename: (value: string) => string | null,
) {
  const excludedKey = filterKey(field, "none");
  const saved = await ctx.db
    .select()
    .from(views)
    .where(
      and(
        eq(views.projectId, project(ctx).id),
        sql`(${views.filters} ? ${field} OR ${views.filters} ? ${excludedKey})`,
      ),
    );
  const apply = (values: string | string[] | undefined) => {
    const next = filterList(values).flatMap((value) => rename(value) ?? []);
    return next.length ? [...new Set(next)] : undefined;
  };
  for (const view of saved) {
    const filters = ticketFilter.parse(view.filters),
      included = apply(filters[field]),
      excluded = apply(filters[excludedKey])?.filter((value) => !included?.includes(value)),
      next = {
        ...filters,
        [field]: included,
        [excludedKey]: excluded?.length ? excluded : undefined,
      };
    if (JSON.stringify(next) !== JSON.stringify(filters))
      await ctx.db.update(views).set({ filters: next }).where(eq(views.id, view.id));
  }
}
// A workspace label change reaches every project of the workspace in the same transaction. The
// caller is a workspace administrator, which is the administrator role in each of those projects.
async function changeWorkspaceLabelUsage(ctx: Context, name: string, replacement?: string) {
  const rows = await ctx.db
    .select()
    .from(projects)
    .where(and(eq(projects.workspaceId, workspace(ctx).id), isNull(projects.deletedAt)))
    .orderBy(projects.position, projects.id);
  for (const row of rows)
    await changeLabelUsage({ ...ctx, project: toProject(row), role: "admin" }, name, replacement);
}
async function getProjectLabel(ctx: Context, labelId: string, expectedVersion: number) {
  const label = one(
    await ctx.db
      .select()
      .from(projectLabels)
      .where(and(eq(projectLabels.projectId, project(ctx).id), eq(projectLabels.id, labelId))),
  );
  assertVersion(label, expectedVersion, "label", "saving");
  return label;
}
async function getWorkspaceLabel(ctx: Context, labelId: string, expectedVersion: number) {
  const label = one(
    await ctx.db
      .select()
      .from(workspaceLabels)
      .where(
        and(eq(workspaceLabels.workspaceId, workspace(ctx).id), eq(workspaceLabels.id, labelId)),
      ),
  );
  assertVersion(label, expectedVersion, "label", "saving");
  return label;
}

export const labelHandlers: Pick<
  Handlers,
  | "list_project_labels"
  | "create_project_label"
  | "update_project_label"
  | "delete_project_label"
  | "list_workspace_labels"
  | "create_workspace_label"
  | "update_workspace_label"
  | "delete_workspace_label"
  | "list_label_colors"
  | "remove_label_color"
> = {
  async list_project_labels(ctx) {
    const usage = labelUsage(ctx, "include").as("usage");
    const count = sql<number>`coalesce(${usage.count}, 0)`.mapWith(Number).as("count");
    const definitions = unionAll(
      ctx.db
        .select({
          id: projectLabels.id,
          scope: sql<"project" | "workspace">`'project'`.as("scope"),
          ownerId: sql<string>`${projectLabels.projectId}`.as("owner_id"),
          name: projectLabels.name,
          color: projectLabels.color,
          version: projectLabels.version,
          count,
        })
        .from(projectLabels)
        .leftJoin(usage, eq(projectLabels.name, sql<string>`"usage"."name"`))
        .where(eq(projectLabels.projectId, project(ctx).id)),
      ctx.db
        .select({
          id: workspaceLabels.id,
          scope: sql<"project" | "workspace">`'workspace'`.as("scope"),
          ownerId: sql<string>`${workspaceLabels.workspaceId}`.as("owner_id"),
          name: workspaceLabels.name,
          color: workspaceLabels.color,
          version: workspaceLabels.version,
          count,
        })
        .from(workspaceLabels)
        .leftJoin(usage, eq(workspaceLabels.name, sql<string>`"usage"."name"`))
        .where(eq(workspaceLabels.workspaceId, project(ctx).workspaceId)),
    ).as("definitions");
    const rows = await ctx.db
      .select()
      .from(definitions)
      .orderBy(...labelOrder(definitions.name));
    return rows.map(({ scope, ownerId, ...label }) =>
      scope === "project"
        ? { ...label, scope, projectId: ownerId }
        : { ...label, scope, workspaceId: ownerId },
    );
  },
  async create_project_label(ctx, input) {
    await availableProjectName(ctx, input.name);
    await rememberLabelColor(ctx, input.color);
    const label = one(
      await ctx.db
        .insert(projectLabels)
        .values({ projectId: project(ctx).id, name: input.name, color: input.color })
        .returning(),
    );
    await publish(ctx, "label.created", null, {
      labelId: label.id,
      name: label.name,
      color: label.color,
      version: label.version,
    });
    return label;
  },
  async update_project_label(ctx, input) {
    const current = await getProjectLabel(ctx, input.labelId, input.expectedVersion);
    await availableProjectName(ctx, input.name, current.id);
    if (input.color !== current.color) await rememberLabelColor(ctx, input.color);
    const label = one(
      await ctx.db
        .update(projectLabels)
        .set({ name: input.name, color: input.color, version: current.version + 1 })
        .where(eq(projectLabels.id, current.id))
        .returning(),
    );
    if (current.name !== label.name) await changeLabelUsage(ctx, current.name, label.name);
    await publish(ctx, "label.updated", null, {
      labelId: label.id,
      name: label.name,
      previousName: current.name,
      color: label.color,
      version: label.version,
    });
    return label;
  },
  async delete_project_label(ctx, input) {
    const label = await getProjectLabel(ctx, input.labelId, input.expectedVersion);
    await changeLabelUsage(ctx, label.name);
    await ctx.db.delete(projectLabels).where(eq(projectLabels.id, label.id));
    await publish(ctx, "label.deleted", null, { labelId: label.id, name: label.name });
    return { ok: true };
  },
  async list_workspace_labels(ctx) {
    // Counts come only from projects this reader can open, so private usage stays out of them.
    const readable = (await accessibleProjectRows(ctx.db, ctx.actor, workspace(ctx).id)).map(
      (row) => row.id,
    );
    const usage = labelUsage(
      ctx,
      "include",
      readable.length ? inArray(tickets.projectId, readable) : sql`false`,
    ).as("usage");
    return ctx.db
      .select({
        id: workspaceLabels.id,
        scope: sql<"workspace">`'workspace'`,
        workspaceId: workspaceLabels.workspaceId,
        name: workspaceLabels.name,
        color: workspaceLabels.color,
        version: workspaceLabels.version,
        count: sql<number>`coalesce(${usage.count}, 0)`.mapWith(Number),
      })
      .from(workspaceLabels)
      .leftJoin(usage, eq(workspaceLabels.name, sql<string>`"usage"."name"`))
      .where(eq(workspaceLabels.workspaceId, workspace(ctx).id))
      .orderBy(...labelOrder(workspaceLabels.name));
  },
  async create_workspace_label(ctx, input) {
    await availableWorkspaceName(ctx, input.name, input.adopt);
    await rememberLabelColor(ctx, input.color);
    const label = one(
      await ctx.db
        .insert(workspaceLabels)
        .values({ workspaceId: workspace(ctx).id, name: input.name, color: input.color })
        .returning(),
    );
    await publishWorkspace(ctx, label.workspaceId, "label.created", {
      scope: "workspace",
      labelId: label.id,
      name: label.name,
      color: label.color,
      version: label.version,
    });
    return label;
  },
  async update_workspace_label(ctx, input) {
    const current = await getWorkspaceLabel(ctx, input.labelId, input.expectedVersion);
    if (input.name !== current.name)
      await availableWorkspaceName(ctx, input.name, input.adopt, current.id);
    if (input.color !== current.color) await rememberLabelColor(ctx, input.color);
    const label = one(
      await ctx.db
        .update(workspaceLabels)
        .set({ name: input.name, color: input.color, version: current.version + 1 })
        .where(eq(workspaceLabels.id, current.id))
        .returning(),
    );
    if (current.name !== label.name) await changeWorkspaceLabelUsage(ctx, current.name, label.name);
    await publishWorkspace(ctx, label.workspaceId, "label.updated", {
      scope: "workspace",
      labelId: label.id,
      name: label.name,
      previousName: current.name,
      color: label.color,
      version: label.version,
    });
    return label;
  },
  async delete_workspace_label(ctx, input) {
    const label = await getWorkspaceLabel(ctx, input.labelId, input.expectedVersion);
    await changeWorkspaceLabelUsage(ctx, label.name);
    await ctx.db.delete(workspaceLabels).where(eq(workspaceLabels.id, label.id));
    await publishWorkspace(ctx, label.workspaceId, "label.deleted", {
      scope: "workspace",
      labelId: label.id,
      name: label.name,
    });
    return { ok: true };
  },
  async list_label_colors(ctx) {
    return ctx.db
      .select({ value: labelColors.value, createdAt: labelColors.createdAt })
      .from(labelColors)
      .orderBy(desc(labelColors.createdAt), asc(labelColors.value));
  },
  async remove_label_color(ctx, input) {
    const current = (
      await ctx.db.select().from(labelColors).where(eq(labelColors.value, input.value))
    )[0];
    if (!current) return { ok: true };
    if (!ctx.actor.admin && current.createdBy !== ctx.actor.id)
      fail(
        403,
        "forbidden",
        "Only an instance administrator or the person who added this color can remove it",
      );
    await ctx.db.delete(labelColors).where(eq(labelColors.value, input.value));
    // The palette is site-wide; the projects the actor can write hear about it in one batch.
    const audience = await ctx.db
      .select({ id: projects.id })
      .from(projects)
      .where(
        ctx.actor.admin
          ? isNull(projects.deletedAt)
          : inArray(projectRoleSQL(ctx.actor.id, projects.id), ["writer", "admin"]),
      );
    await publishMany(
      ctx,
      audience.map((row) => ({
        type: "label.color_removed",
        ticketId: null,
        projectId: row.id,
        data: { value: input.value },
      })),
    );
    return { ok: true };
  },
};
