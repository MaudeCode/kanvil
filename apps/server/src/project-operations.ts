import { icons } from "@iconify-json/lucide";
import { decodeImage } from "./blob-storage.ts";
import { and, asc, count, desc, eq, getTableColumns, inArray, ne, or, sql } from "drizzle-orm";
import { user } from "./auth-schema.ts";
import { isHexColor, roles } from "@kanvil/contracts";
import { z } from "zod";
import { accessibleProjectRows, projectRoleSQL } from "./project-access.ts";
import {
  members,
  labelColors,
  projects,
  projectLabels,
  tickets,
  views,
  workspaces,
  workspaceMembers,
} from "./schema.ts";
import {
  labelOrder,
  labelUsage,
  openTicket,
  overdueTicket,
  updateTicketRow,
} from "./ticket-operations.ts";
import {
  accountByEmail,
  assertVersion,
  fail,
  project,
  publish,
  publishMany,
  toProject,
  workspace,
  type Handlers,
  type Context,
  one,
} from "./domain.ts";

async function getLabel(ctx: Context, labelId: string, expectedVersion: number) {
  const label = one(
    await ctx.db
      .select()
      .from(projectLabels)
      .where(and(eq(projectLabels.projectId, project(ctx).id), eq(projectLabels.id, labelId))),
  );
  assertVersion(label, expectedVersion, "label", "saving");
  return label;
}
// A custom color becomes part of the site-wide palette the first time a label uses it.
async function rememberLabelColor(ctx: Context, color: string) {
  if (isHexColor(color))
    await ctx.db
      .insert(labelColors)
      .values({ value: color, createdBy: ctx.actor.id })
      .onConflictDoNothing();
}
async function availableLabelName(ctx: Context, name: string, exceptId?: string) {
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
}
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
            labels: replacement
              ? ticket.labels.map((tag) => (tag === name ? replacement : tag))
              : ticket.labels.filter((tag) => tag !== name),
          },
        })
      ).event,
    );
  await publishMany(ctx, pending);
  await ctx.db
    .update(views)
    .set({
      filters: replacement
        ? sql`jsonb_set(${views.filters}, '{label}', to_jsonb(${replacement}::text))`
        : sql`${views.filters} - 'label'`,
    })
    .where(and(eq(views.projectId, project(ctx).id), sql`${views.filters}->>'label' = ${name}`));
}

export const projectHandlers: Pick<
  Handlers,
  | "get_project"
  | "set_project_icon"
  | "list_projects"
  | "create_project"
  | "update_project"
  | "list_members"
  | "set_member"
  | "list_views"
  | "save_view"
  | "delete_view"
  | "list_project_labels"
  | "create_project_label"
  | "update_project_label"
  | "delete_project_label"
  | "list_label_colors"
  | "remove_label_color"
> = {
  async list_project_labels(ctx) {
    const usage = labelUsage(ctx, "include").as("usage");
    return ctx.db
      .select({
        ...getTableColumns(projectLabels),
        count: sql<number>`coalesce(${usage.count}, 0)`.mapWith(Number),
      })
      .from(projectLabels)
      .leftJoin(usage, eq(projectLabels.name, sql<string>`"usage"."name"`))
      .where(eq(projectLabels.projectId, project(ctx).id))
      .orderBy(...labelOrder(projectLabels.name));
  },
  async create_project_label(ctx, input) {
    await availableLabelName(ctx, input.name);
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
    const current = await getLabel(ctx, input.labelId, input.expectedVersion);
    await availableLabelName(ctx, input.name, current.id);
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
    const label = await getLabel(ctx, input.labelId, input.expectedVersion);
    await changeLabelUsage(ctx, label.name);
    await ctx.db.delete(projectLabels).where(eq(projectLabels.id, label.id));
    await publish(ctx, "label.deleted", null, { labelId: label.id, name: label.name });
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
          ? undefined
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
  async get_project(ctx) {
    return project(ctx);
  },
  async set_project_icon(ctx, input) {
    const current = project(ctx);
    assertVersion(current, input.expectedVersion, "project icon", "saving");
    const icon = input.icon;
    if (icon?.kind === "library" && !icons.icons[icon.name])
      fail(400, "invalid_icon", "Choose an icon from the installed library");
    let objectId: string | null = null;
    if (icon?.kind === "image") {
      objectId = crypto.randomUUID();
      await ctx.blobs.put(ctx.db, objectId, decodeImage(icon), icon.contentType);
    }
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
  async list_projects(ctx, input) {
    const rows = await accessibleProjectRows(ctx.db, ctx.actor, input.workspaceId);
    if (!rows.length) return [];
    const counts = await ctx.db
      .select({
        projectId: tickets.projectId,
        open: count(),
        overdue: count(sql`CASE WHEN ${overdueTicket} THEN 1 END`),
      })
      .from(tickets)
      .where(
        and(
          inArray(
            tickets.projectId,
            rows.map((row) => row.id),
          ),
          eq(tickets.archived, false),
          openTicket,
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
    if (
      (await ctx.db.select({ id: projects.id }).from(projects).where(eq(projects.key, input.key)))
        .length
    )
      fail(409, "duplicate_prefix", "This project prefix is already in use");
    const row = one(
      await ctx.db
        .insert(projects)
        .values({
          workspaceId,
          visibility: input.visibility,
          key: input.key,
          name: input.name,
          description: input.description,
        })
        .returning(),
    );
    await ctx.db.insert(members).values({ projectId: row.id, userId: ctx.actor.id, role: "admin" });
    await publish({ ...ctx, project: toProject(row) }, "project.created", null, {
      projectId: row.id,
    });
    return row;
  },
  async update_project(ctx, input) {
    const current = project(ctx);
    assertVersion(current, input.expectedVersion, "project");
    const row = one(
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
        .returning(),
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
    return ctx.db
      .select()
      .from(views)
      .where(and(eq(views.projectId, project(ctx).id), eq(views.userId, ctx.actor.id)))
      .orderBy(views.name);
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
