import {
  and,
  asc,
  count,
  desc,
  eq,
  getTableColumns,
  gt,
  inArray,
  isNull,
  isNotNull,
  notInArray,
  or,
  sql,
  type SQL,
  type AnyColumn,
} from "drizzle-orm";
import {
  attachments,
  claims,
  comments,
  events,
  evidence,
  projectPrefixes,
  projects,
  projectLabels,
  workspaceLabels,
  relations,
  resources,
  timeEntries,
  stagedUploads,
  subscriptions,
  ticketAliases,
  tickets,
} from "./schema.ts";
import { stagedUploadCutoff } from "./blob-storage.ts";
import {
  assertDefinitionMigration,
  assertVersion,
  assertWorkerClaim,
  can,
  context,
  ownsLiveClaim,
  complete,
  fail,
  getTicket,
  project,
  publish,
  publishMany,
  relationEvents,
  requireRow,
  subscribe,
  type Context,
  type Handlers,
  type PendingEvent,
  one,
  ticketMatch,
} from "./domain.ts";
import { accessibleProjectRows, projectRoleSQL } from "./project-access.ts";
import { endPosition, positionNear, ticketPositions } from "./ordering.ts";
import { projectStates, resolveState } from "./workflow-operations.ts";
import { likePattern } from "./search.ts";
import {
  applyCustomFieldValues,
  assertCustomFieldFilters,
  customFieldPredicate,
  projectCustomFields,
} from "./custom-field-operations.ts";
import { z } from "zod";
import {
  closedStates,
  defaultOrder,
  difficulties,
  operations,
  eventLabels,
  formatEvent,
  searchResultTypes,
  priorities,
  states,
  ticketPredicates,
  type TicketPredicate,
  type ParsedInput,
  type Output,
} from "@kanvil/contracts";
// Shared predicates so "open" and "overdue" mean one thing in filters, counts, and eligibility.
export const openTicket = notInArray(tickets.status, [...closedStates]);
export const overdueTicket = sql`${tickets.dueAt} < now()`;
// Orders a column by its position in the contract's enum; values outside it sort last.
const rank = (column: AnyColumn, values: readonly string[]) =>
  sql`array_position(ARRAY[${sql.join(
    values.map((value) => sql`${value}`),
    sql`, `,
  )}]::text[], ${column}::text)`;
// Label names sort case-insensitively with a stable byte-order tiebreak.
export const labelOrder = (column: AnyColumn | SQL | SQL.Aliased) => [
  asc(sql`lower(${column}) COLLATE "C"`),
  asc(sql`${column} COLLATE "C"`),
];
// Contracts carry ISO strings; the columns store timestamps.
const toDate = (value: string | null) => (value ? new Date(value) : null);
function dateColumns(dates: {
  startAt?: string | null | undefined;
  dueAt?: string | null | undefined;
}) {
  return {
    ...(dates.startAt === undefined ? {} : { startAt: toDate(dates.startAt) }),
    ...(dates.dueAt === undefined ? {} : { dueAt: toDate(dates.dueAt) }),
  };
}
// A ticket's schedule, from its start (or due) date to its due (or start) date.
export const scheduleStart = sql`coalesce(${tickets.startAt}, ${tickets.dueAt})`;
export const scheduleEnd = sql`coalesce(${tickets.dueAt}, ${tickets.startAt})`;
// Checks the dates a write leaves on the ticket, so moving either side keeps the order. A bulk
// edit names the ticket that would break.
function assertSchedule(startAt: Date | null, dueAt: Date | null, key?: string) {
  if (!startAt || !dueAt || startAt <= dueAt) return;
  const message = key
    ? `${key} would start after its due date`
    : "The start date must be on or before the due date";
  fail(400, "validation_error", message, [{ path: "startAt", message }]);
}

async function readinessMany(ctx: Context, selected: (typeof tickets.$inferSelect)[]) {
  const ids = selected.map((ticket) => ticket.id);
  const result = new Map<string, Output<"get_ticket">["readiness"]>();
  if (!ids.length) return result;
  const blockers = await ctx.db
    .select({ targetId: relations.targetId, ticket: tickets })
    .from(relations)
    .innerJoin(tickets, eq(tickets.id, relations.sourceId))
    .where(and(inArray(relations.targetId, ids), eq(relations.type, "blocks")));
  const children = await ctx.db.select().from(tickets).where(inArray(tickets.parentId, ids));
  const ownership = await ctx.db.select().from(claims).where(inArray(claims.ticketId, ids));
  const duplicates = await ctx.db
    .select({ sourceId: relations.sourceId })
    .from(relations)
    .where(and(inArray(relations.sourceId, ids), eq(relations.type, "duplicate")));
  for (const ticket of selected) {
    const reasons: Output<"get_ticket">["readiness"]["reasons"] = [];
    if (project(ctx).archivedAt)
      reasons.push({ code: "project_archived", message: "The project is archived" });
    if (ticket.status !== "todo" || ticket.archived)
      reasons.push({ code: "not_open", message: "Ticket must be in a To do state and unarchived" });
    if (!ticket.automationReady)
      reasons.push({ code: "not_enabled", message: "Agent work has not been enabled" });
    if (ticket.holdReason) reasons.push({ code: "hold", message: ticket.holdReason });
    if (!ticket.description.trim())
      reasons.push({ code: "missing_description", message: "Add a description" });
    if (!ticket.acceptanceCriteria.trim())
      reasons.push({ code: "missing_acceptance_criteria", message: "Add acceptance criteria" });
    if (!ticket.difficulty)
      reasons.push({ code: "missing_difficulty", message: "Choose a difficulty" });
    const dependencies = [
      ...blockers.filter((row) => row.targetId === ticket.id).map((row) => row.ticket),
      ...children.filter((row) => row.parentId === ticket.id),
    ];
    const seen = new Set<string>();
    for (const dependency of dependencies)
      if (!complete(dependency.status) && !seen.has(dependency.id)) {
        seen.add(dependency.id);
        reasons.push({
          code: "dependency",
          message: `${dependency.key} is unfinished`,
          ticketId: dependency.id,
          ticketKey: dependency.key,
        });
      }
    if (duplicates.some((row) => row.sourceId === ticket.id))
      reasons.push({ code: "duplicate", message: "This ticket is marked as a duplicate" });
    const claim = ownership.find((row) => row.ticketId === ticket.id);
    if (claim) {
      const expired = claim.expiresAt <= new Date();
      reasons.push({
        code: expired ? "claim_recovery_required" : "claimed",
        message: expired
          ? "Confirm the previous worker stopped before recovering ownership"
          : `Claimed by ${claim.workerId}`,
      });
    }
    result.set(ticket.id, { ready: reasons.length === 0, reasons });
  }
  return result;
}
function claimExpiry(ctx: Context, requested?: number) {
  const leaseSeconds = requested ?? Math.min(300, ctx.claimMaxLeaseSeconds);
  if (leaseSeconds > ctx.claimMaxLeaseSeconds)
    fail(400, "validation_error", "Claim lease exceeds the configured maximum", {
      path: "leaseSeconds",
      maximum: ctx.claimMaxLeaseSeconds,
    });
  return new Date(Date.now() + leaseSeconds * 1000);
}
export async function readiness(ctx: Context, ticket: typeof tickets.$inferSelect) {
  return requireRow((await readinessMany(ctx, [ticket])).get(ticket.id));
}
// Uses the effective role, so workspace members of a workspace-visible project count.
async function projectMember(ctx: Context, userId: string) {
  const { id } = project(ctx);
  return !!one(
    await ctx.db
      .select({ role: projectRoleSQL(userId, id) })
      .from(projects)
      .where(eq(projects.id, id)),
  ).role;
}
// New names register as project labels unless the workspace already defines them.
async function registerLabels(ctx: Context, labels: readonly string[] | undefined) {
  if (!labels?.length) return;
  const shared = new Set(
    (
      await ctx.db
        .select({ name: workspaceLabels.name })
        .from(workspaceLabels)
        .where(
          and(
            eq(workspaceLabels.workspaceId, project(ctx).workspaceId),
            inArray(workspaceLabels.name, [...labels]),
          ),
        )
    ).map((row) => row.name),
  );
  const own = labels.filter((name) => !shared.has(name));
  if (own.length)
    await ctx.db
      .insert(projectLabels)
      .values(own.map((name) => ({ projectId: project(ctx).id, name })))
      .onConflictDoNothing();
}
async function validateReferences(
  ctx: Context,
  ticketId: string,
  changes: Pick<ParsedInput<"update_ticket">["changes"], "assigneeId" | "parentId" | "labels">,
) {
  await registerLabels(ctx, changes.labels);
  if (changes.assigneeId && !(await projectMember(ctx, changes.assigneeId)))
    fail(400, "invalid_assignee", "Assign a project member");
  if (changes.parentId) {
    await getTicket(ctx, changes.parentId);
    await assertNoCycle(ctx, ticketId, changes.parentId);
  }
}
export async function assertNoCycle(ctx: Context, sourceId: string, targetId: string) {
  if (sourceId === targetId) fail(409, "dependency_cycle", "A ticket cannot depend on itself");
  const all = await ctx.db
    .select({ id: tickets.id, parentId: tickets.parentId })
    .from(tickets)
    .where(eq(tickets.projectId, project(ctx).id));
  const links = await ctx.db
    .select()
    .from(relations)
    .where(and(eq(relations.projectId, project(ctx).id), eq(relations.type, "blocks")));
  const edges = new Map<string, string[]>();
  const add = (from: string, to: string) => edges.set(from, [...(edges.get(from) ?? []), to]);
  for (const row of all) if (row.parentId) add(row.id, row.parentId);
  for (const row of links) add(row.sourceId, row.targetId);
  const pending = [targetId],
    visited = new Set<string>();
  while (pending.length) {
    const node = pending.pop();
    if (!node || visited.has(node)) continue;
    if (node === sourceId)
      fail(409, "dependency_cycle", "This relationship would create a dependency cycle");
    visited.add(node);
    pending.push(...(edges.get(node) ?? []));
  }
}
// Applies one update and returns its event so callers can publish singly or in a batch.
export async function updateTicketRow(ctx: Context, input: ParsedInput<"update_ticket">) {
  const current = await getTicket(ctx, input.ticketId);
  assertVersion(current, input.expectedVersion, "ticket");
  await assertWorkerClaim(ctx, current, input.claimId);
  return persistTicketChanges(ctx, current, input.changes);
}
// Label administration changes only labels and never takes or clears worker ownership.
export async function updateTicketLabels(
  ctx: Context,
  input: Pick<ParsedInput<"update_ticket_labels">, "ticketId" | "expectedVersion" | "labels">,
) {
  if (!can(ctx, "project.manage") && !can(ctx, "workspace.manage"))
    fail(403, "forbidden", "Label administration permission is required");
  const current = await getTicket(ctx, input.ticketId);
  assertVersion(current, input.expectedVersion, "ticket");
  return persistTicketChanges(ctx, current, { labels: input.labels });
}
// A definition migration moves one ticket through the shared versioned write under the
// definition-administration ownership policy instead of the worker claim check.
export async function migrateTicketRow(
  ctx: Context,
  input: Pick<ParsedInput<"update_ticket">, "ticketId" | "expectedVersion" | "changes">,
) {
  const current = await getTicket(ctx, input.ticketId);
  assertVersion(current, input.expectedVersion, "ticket");
  await assertDefinitionMigration(ctx, [current]);
  return persistTicketChanges(ctx, current, input.changes);
}
async function persistTicketChanges(
  ctx: Context,
  current: typeof tickets.$inferSelect,
  changes: ParsedInput<"update_ticket">["changes"],
) {
  await validateReferences(ctx, current.id, changes);
  const state = await resolveState(ctx, changes, current);
  const { startAt, dueAt, customFields, ...values } = changes,
    dates = dateColumns({ startAt, dueAt });
  assertSchedule(
    dates.startAt === undefined ? current.startAt : dates.startAt,
    dates.dueAt === undefined ? current.dueAt : dates.dueAt,
    current.key,
  );
  const row = one(
    await ctx.db
      .update(tickets)
      .set({
        ...values,
        ...state,
        ...dates,
        ...(customFields && {
          customFields: applyCustomFieldValues(
            await projectCustomFields(ctx),
            current.customFields,
            customFields,
          ),
        }),
        version: current.version + 1,
        updatedAt: new Date(),
      })
      .where(eq(tickets.id, current.id))
      .returning(),
  );
  await subscribe(ctx, row.projectId, row.id, [row.assigneeId]);
  const event: PendingEvent = {
    type: "ticket.updated",
    ticketId: row.id,
    // A state change is a status change, whichever of the two the caller wrote.
    data: {
      version: row.version,
      changedFields: [
        ...new Set([...Object.keys(changes), ...(state ? ["status", "stateId"] : [])]),
      ],
    },
  };
  return { row, event };
}
export async function updateTicket(ctx: Context, input: ParsedInput<"update_ticket">) {
  const { row, event } = await updateTicketRow(ctx, input);
  await publish(ctx, event.type, event.ticketId, event.data);
  return row;
}
// Label usage counts in the context project, or in the projects `where` selects.
export function labelUsage(
  ctx: Context,
  archived: "include" | "exclude" | "only",
  where: SQL = eq(tickets.projectId, project(ctx).id),
) {
  const labels = ctx.db
    .select({ name: sql<string>`unnest(${tickets.labels})`.as("name") })
    .from(tickets)
    .where(
      and(where, archived === "include" ? undefined : eq(tickets.archived, archived === "only")),
    )
    .as("ticket_labels");
  return ctx.db
    .select({ name: labels.name, count: count().as("count") })
    .from(labels)
    .groupBy(labels.name);
}
// Windows run from the database clock: overdue is in the past, today and week look ahead.
const dueWithin = (interval: string) =>
  and(sql`${tickets.dueAt} >= now()`, sql`${tickets.dueAt} < now() + ${interval}::interval`);
function dueWhere(due: ParsedInput<"list_tickets">["due"]) {
  switch (due) {
    case "overdue":
      return and(overdueTicket, openTicket);
    case "today":
      return and(dueWithin("1 day"), openTicket);
    case "week":
      return and(dueWithin("7 days"), openTicket);
    case "scheduled":
      return isNotNull(tickets.dueAt);
    case "none":
      return isNull(tickets.dueAt);
    default:
      return undefined;
  }
}
// One predicate per normalized filter; lists and search share it. Excluding a value keeps tickets
// where the field is unset, and the assignee value "none" stands for unassigned.
const filterColumns = {
  status: tickets.status,
  priority: tickets.priority,
  kind: tickets.kind,
  difficulty: tickets.difficulty,
};
function predicateSQL({ field, operator, values }: TicketPredicate) {
  if (field === "customField") return customFieldPredicate(operator, values);
  if (field === "label") {
    const overlap = sql`${tickets.labels} && ${sql.param(values)}::text[]`;
    return operator === "any" ? overlap : sql`NOT (${overlap})`;
  }
  const column = field === "assigneeId" ? tickets.assigneeId : filterColumns[field];
  const named = field === "assigneeId" ? values.filter((value) => value !== "none") : values,
    unset = field === "assigneeId" && values.includes("none");
  if (operator === "any")
    return or(
      named.length ? inArray(column, named) : undefined,
      unset ? isNull(column) : undefined,
    );
  return and(
    named.length ? or(isNull(column), notInArray(column, named)) : undefined,
    unset ? isNotNull(column) : undefined,
  );
}
export const predicateWhere = (filter: Parameters<typeof ticketPredicates>[0]) =>
  and(...ticketPredicates(filter).map(predicateSQL));
// Every ticket listing orders the same way: the chosen sort, then the ticket number.
function ticketOrder(input: Pick<ParsedInput<"list_tickets">, "sort" | "order">) {
  const direction = input.order ?? defaultOrder[input.sort];
  const by = (column: SQL | AnyColumn) =>
    direction === "asc" ? sql`${column} ASC NULLS LAST` : sql`${column} DESC NULLS LAST`;
  const primary: Record<typeof input.sort, SQL> = {
    priority: by(rank(tickets.priority, priorities)),
    updated: by(tickets.updatedAt),
    created: by(tickets.createdAt),
    title: by(sql`lower(${tickets.title})`),
    labels: by(sql`(SELECT min(lower(label) COLLATE "C") FROM unnest(${tickets.labels}) AS label)`),
    due: by(tickets.dueAt),
    start: by(scheduleStart),
    number: by(tickets.number),
    // The state's category, then its place within the category.
    status: by(
      sql`${rank(tickets.status, states)} * 1000 + (SELECT workflow_states.position FROM workflow_states WHERE workflow_states.id = tickets.state_id)`,
    ),
    difficulty: by(rank(tickets.difficulty, difficulties)),
    kind: by(tickets.kind),
    assignee: by(sql`(SELECT lower(name) FROM "user" WHERE id = ${tickets.assigneeId})`),
    manual: by(tickets.position),
  };
  return [primary[input.sort], asc(tickets.number)];
}
// One round trip returns the page and its total; a second count runs only for an empty page past the start.
async function pageOf(
  ctx: Context,
  where: ReturnType<typeof and>,
  order: SQL[],
  input: { limit: number; offset: number },
) {
  const rows = await ctx.db
    .select({ ...getTableColumns(tickets), total: sql<number>`count(*) over()`.mapWith(Number) })
    .from(tickets)
    .where(where)
    .orderBy(...order)
    .limit(input.limit)
    .offset(input.offset);
  const total =
    rows[0]?.total ??
    (input.offset
      ? one(await ctx.db.select({ count: count() }).from(tickets).where(where)).count
      : 0);
  return { items: rows.map(({ total: _total, ...row }) => row), total };
}
const copySuffix = " (copy)";
// Takes the context project's next number, its key under the current prefix, and a place at the
// end of its order. Numbers only grow, so with reserved prefixes no key is ever issued twice.
async function allocateTicket(ctx: Context) {
  const counter = one(
    await ctx.db
      .update(projects)
      .set({ nextNumber: sql`${projects.nextNumber} + 1` })
      .where(eq(projects.id, project(ctx).id))
      .returning(),
  );
  const number = counter.nextNumber - 1;
  return {
    projectId: counter.id,
    number,
    key: `${counter.key}-${number}`,
    position: endPosition(ticketPositions, eq(tickets.projectId, counter.id)),
  };
}
// Inserts one ticket with the next project number and returns its event for the caller to publish.
export async function createTicketRow(ctx: Context, input: ParsedInput<"create_ticket">) {
  const id = crypto.randomUUID();
  await validateReferences(ctx, id, input);
  const {
      projectId: _projectId,
      requestId: _requestId,
      uploads: _uploads,
      startAt,
      dueAt,
      customFields,
      ...fields
    } = input,
    dates = dateColumns({ startAt, dueAt });
  assertSchedule(dates.startAt ?? null, dates.dueAt ?? null);
  const state = requireRow(
    await resolveState(ctx, {
      status: input.status ?? (input.stateId ? undefined : "todo"),
      stateId: input.stateId,
    }),
  );
  const row = one(
    await ctx.db
      .insert(tickets)
      .values({
        ...fields,
        ...state,
        ...dates,
        customFields: applyCustomFieldValues(await projectCustomFields(ctx), null, customFields),
        ...(await allocateTicket(ctx)),
        id,
        createdBy: ctx.actor.id,
      })
      .returning(),
  );
  await subscribe(ctx, row.projectId, row.id, [ctx.actor.id, row.assigneeId]);
  const event: PendingEvent = {
    type: "ticket.created",
    ticketId: row.id,
    data: { key: row.key, version: row.version },
  };
  return { row, event };
}
// The author's own live staged uploads become the new ticket's attachments under the same IDs, so
// the content addresses its text embeds keep working. Any missing one fails the whole creation.
async function claimStagedUploads(ctx: Context, ticketId: string, ids: string[]) {
  const unique = [...new Set(ids)];
  if (!unique.length) return [];
  const rows = await ctx.db
    .delete(stagedUploads)
    .where(
      and(
        inArray(stagedUploads.id, unique),
        eq(stagedUploads.projectId, project(ctx).id),
        eq(stagedUploads.actorId, ctx.actor.id),
        gt(stagedUploads.createdAt, stagedUploadCutoff()),
      ),
    )
    .returning();
  if (rows.length !== unique.length)
    fail(404, "not_found", "An inline upload expired or is not yours to attach", {
      uploads: unique.filter((id) => !rows.some((row) => row.id === id)),
    });
  return ctx.db
    .insert(attachments)
    .values(
      rows.map(({ createdAt: _createdAt, ...row }) => ({ ...row, objectId: row.id, ticketId })),
    )
    .returning();
}
const countRow = z.object({ type: z.enum(searchResultTypes), count: z.number().int() });
const hitRow = z.object({
  type: z.enum(searchResultTypes),
  id: z.string(),
  project_id: z.string(),
  ticket_id: z.string().nullable(),
  actor_id: z.string().nullable(),
  body: z.string().nullable(),
  event_type: z.string().nullable(),
  data: z.record(z.string(), z.unknown()).nullable(),
  at: z.coerce.date(),
  key: z.string().nullable(),
  title: z.string().nullable(),
  status: z.enum(states).nullable(),
});
// The text around the first literal match, or nothing when only the title or index matched.
function excerpt(body: string | null, query: string, radius = 80) {
  const text = body?.replace(/\s+/gu, " ").trim() ?? "",
    at = text.toLowerCase().indexOf(query.toLowerCase());
  if (at < 0) return "";
  const start = Math.max(0, at - radius),
    end = Math.min(text.length, at + query.length + radius);
  return `${start > 0 ? "…" : ""}${text.slice(start, end).trim()}${end < text.length ? "…" : ""}`;
}
// Checks every ticket's version and ownership before deleting any, so a selection is all or
// nothing. Children outside the selection lose their parent; events publish before the rows go.
async function deleteTicketRows(
  ctx: Context,
  selection: { ticketId: string; expectedVersion: number }[],
) {
  const selected = new Map<string, typeof tickets.$inferSelect>();
  for (const item of selection) {
    const ticket = await getTicket(ctx, item.ticketId);
    // A key and its UUID, or two spellings of a key, name one ticket.
    if (selected.has(ticket.id))
      fail(400, "validation_error", "Each ticket can appear only once", { ticketId: ticket.id });
    assertVersion(ticket, item.expectedVersion, "ticket", "deleting");
    selected.set(ticket.id, ticket);
  }
  const ids = [...selected.keys()];
  const [claimed] = await ctx.db
    .select({ ticketId: claims.ticketId })
    .from(claims)
    .where(inArray(claims.ticketId, ids))
    .limit(1);
  if (claimed)
    fail(409, "claim_conflict", "Release ownership before deleting this ticket", {
      ticketId: claimed.ticketId,
    });
  const children = await ctx.db
    .update(tickets)
    .set({ parentId: null, version: sql`${tickets.version} + 1`, updatedAt: new Date() })
    .where(and(inArray(tickets.parentId, ids), notInArray(tickets.id, ids)))
    .returning();
  await publishMany(ctx, [
    ...children.map((child) => ({
      type: "ticket.updated",
      ticketId: child.id,
      data: { version: child.version, changedFields: ["parentId"] },
    })),
    ...[...selected.values()].map((ticket) => ({
      type: "ticket.deleted",
      ticketId: ticket.id,
      data: { key: ticket.key, version: ticket.version },
    })),
  ]);
  await ctx.db.delete(tickets).where(inArray(tickets.id, ids));
}
// The destination of a move, entered with its own write check, and what keeps the ticket where it
// is. A destination the caller cannot write to reads as not found, like any unreachable project.
async function relocation(
  ctx: Context,
  ticket: typeof tickets.$inferSelect,
  destinationProjectId: string,
) {
  const entered = await context(ctx.db, ctx.actor, "write", destinationProjectId),
    target: Context = { ...ctx, project: entered.project, role: entered.role },
    destination = project(target);
  if (destination.id === ticket.projectId)
    fail(400, "validation_error", "Choose a different project");
  if (destination.workspaceId !== project(ctx).workspaceId)
    fail(400, "validation_error", "Tickets move only between projects of one workspace");
  if (destination.archivedAt)
    fail(409, "project_archived", "Restore the destination project before moving tickets into it");
  // Claims, hierarchy, and relationships live within one project; the move never severs them.
  const blockers: { code: string; message: string; ticketId?: string }[] = [];
  const [claim] = await ctx.db.select().from(claims).where(eq(claims.ticketId, ticket.id));
  if (claim)
    blockers.push({
      code: "claimed",
      message: `Claimed by ${claim.workerId}; release or recover the claim first`,
    });
  const [parent] = ticket.parentId
    ? await ctx.db
        .select({ id: tickets.id, key: tickets.key })
        .from(tickets)
        .where(eq(tickets.id, ticket.parentId))
    : [];
  if (parent)
    blockers.push({
      code: "parent",
      message: `Remove it from its parent ${parent.key} first`,
      ticketId: parent.id,
    });
  const [child] = await ctx.db
    .select({ id: tickets.id, key: tickets.key })
    .from(tickets)
    .where(eq(tickets.parentId, ticket.id))
    .orderBy(asc(tickets.number))
    .limit(1);
  if (child)
    blockers.push({
      code: "children",
      message: `Move or detach its sub-tickets, such as ${child.key}, first`,
      ticketId: child.id,
    });
  const [related] = await ctx.db
    .select({ id: tickets.id, key: tickets.key })
    .from(relations)
    .innerJoin(
      tickets,
      sql`${tickets.id} = CASE WHEN ${relations.sourceId} = ${ticket.id} THEN ${relations.targetId} ELSE ${relations.sourceId} END`,
    )
    .where(or(eq(relations.sourceId, ticket.id), eq(relations.targetId, ticket.id)))
    .orderBy(asc(tickets.number))
    .limit(1);
  if (related)
    blockers.push({
      code: "relations",
      message: `Remove its relationships, such as with ${related.key}, first`,
      ticketId: related.id,
    });
  if (ticket.assigneeId && !(await projectMember(target, ticket.assigneeId)))
    blockers.push({
      code: "assignee",
      message: "The assignee cannot access the destination; reassign the ticket first",
    });
  // Custom fields belong to one project: values never carry over, and the destination's defaults
  // must satisfy its required fields.
  const filled = (await projectCustomFields(ctx)).filter((field) =>
    Object.hasOwn(ticket.customFields, field.id),
  );
  if (filled.length)
    blockers.push({
      code: "custom_fields",
      message: `Clear its custom field values first: ${filled.map((field) => field.name).join(", ")}`,
    });
  const fields = await projectCustomFields(target),
    unmet = fields.filter((field) => field.required && field.defaultValue === null);
  if (unmet.length)
    blockers.push({
      code: "required_fields",
      message: `The destination requires fields without a default: ${unmet.map((field) => field.name).join(", ")}`,
    });
  return { target, blockers, fields };
}
export const ticketHandlers: Pick<
  Handlers,
  | "list_tickets"
  | "list_my_work"
  | "list_ticket_labels"
  | "get_ticket"
  | "create_ticket"
  | "duplicate_ticket"
  | "update_ticket"
  | "update_ticket_labels"
  | "move_ticket"
  | "check_ticket_relocation"
  | "relocate_ticket"
  | "resolve_ticket"
  | "bulk_update_tickets"
  | "delete_ticket"
  | "bulk_delete_tickets"
  | "search_tickets"
  | "search_workspace"
  | "list_eligible_tickets"
  | "claim_ticket"
  | "renew_claim"
  | "release_claim"
  | "recover_claim"
> = {
  async list_ticket_labels(ctx, input) {
    const labels = labelUsage(ctx, input.archived).as("usage");
    return ctx.db
      .select()
      .from(labels)
      .orderBy(...labelOrder(labels.name));
  },
  async list_tickets(ctx, input) {
    const parent = input.parentId ? await getTicket(ctx, input.parentId) : undefined;
    const related = input.relatedTo ? await getTicket(ctx, input.relatedTo) : undefined;
    const search = input.q ? await ctx.search.where(ctx.db, [project(ctx).id], input.q) : undefined;
    await assertCustomFieldFilters(ctx, [project(ctx).id], input);
    const where = and(
      eq(tickets.projectId, project(ctx).id),
      parent ? eq(tickets.parentId, parent.id) : undefined,
      related
        ? or(
            inArray(
              tickets.id,
              ctx.db
                .select({ id: relations.targetId })
                .from(relations)
                .where(eq(relations.sourceId, related.id)),
            ),
            inArray(
              tickets.id,
              ctx.db
                .select({ id: relations.sourceId })
                .from(relations)
                .where(eq(relations.targetId, related.id)),
            ),
          )
        : undefined,
      predicateWhere(input),
      input.archived === "include" ? undefined : eq(tickets.archived, input.archived === "only"),
      dueWhere(input.due),
      input.stateId ? eq(tickets.stateId, input.stateId) : undefined,
      input.scheduledFrom ? sql`${scheduleEnd} >= ${input.scheduledFrom}::timestamptz` : undefined,
      input.scheduledTo ? sql`${scheduleStart} < ${input.scheduledTo}::timestamptz` : undefined,
      search?.where,
    );
    return pageOf(ctx, where, ticketOrder(input), input);
  },
  async list_my_work(ctx, input) {
    const allowed = await accessibleProjectRows(ctx.db, ctx.actor, input.workspaceId, "exclude");
    if (!allowed.length) return { items: [], total: 0, activity: [] };
    const ids = allowed.map((row) => row.id);
    const where = and(
      inArray(tickets.projectId, ids),
      eq(tickets.assigneeId, ctx.actor.id),
      eq(tickets.archived, false),
      openTicket,
      input.q ? (await ctx.search.where(ctx.db, ids, input.q)).where : undefined,
    );
    const activity = input.activity
      ? await ctx.db
          .select()
          .from(events)
          .where(inArray(events.projectId, ids))
          .orderBy(desc(events.id))
          .limit(input.activity)
      : [];
    return { ...(await pageOf(ctx, where, ticketOrder(input), input)), activity };
  },
  async get_ticket(ctx, input) {
    const ticket = await getTicket(ctx, input.ticketId);
    const claim =
      (await ctx.db.select().from(claims).where(eq(claims.ticketId, ticket.id)))[0] ?? null;
    return {
      ticket,
      canReleaseClaim: claim ? ownsLiveClaim(ctx, claim) : false,
      subscribed:
        (
          await ctx.db
            .select({ id: subscriptions.ticketId })
            .from(subscriptions)
            .where(
              and(eq(subscriptions.ticketId, ticket.id), eq(subscriptions.userId, ctx.actor.id)),
            )
        ).length > 0,
      readiness: await readiness(ctx, ticket),
      claim,
    };
  },
  async create_ticket(ctx, input) {
    const { row, event } = await createTicketRow(ctx, input);
    const claimed = await claimStagedUploads(ctx, row.id, input.uploads);
    await publishMany(ctx, [
      event,
      ...claimed.map((item) => ({
        type: "attachment.created",
        ticketId: row.id,
        data: { attachmentId: item.id, size: item.size },
      })),
    ]);
    return row;
  },
  async duplicate_ticket(ctx, input) {
    const source = await getTicket(ctx, input.ticketId);
    // Parsing narrows the stored text columns to the contract's enums.
    const copy = operations.create_ticket.input.parse({
      projectId: source.projectId,
      title: source.title.slice(0, 500 - copySuffix.length) + copySuffix,
      description: source.description,
      acceptanceCriteria: source.acceptanceCriteria,
      // The copy is new, unclaimed work: status and agent readiness start over.
      status: "todo",
      priority: source.priority,
      kind: source.kind,
      difficulty: source.difficulty,
      startAt: source.startAt?.toISOString() ?? null,
      dueAt: source.dueAt?.toISOString() ?? null,
      labels: source.labels,
      scopes: source.scopes,
      // A former member stays on old tickets but cannot be assigned new ones.
      assigneeId:
        source.assigneeId && (await projectMember(ctx, source.assigneeId))
          ? source.assigneeId
          : null,
      parentId: source.parentId,
      customFields: source.customFields,
      automationReady: false,
      holdReason: null,
      archived: false,
    });
    const { row, event } = await createTicketRow(ctx, copy);
    const relation = one(
      await ctx.db
        .insert(relations)
        .values({ projectId: row.projectId, sourceId: row.id, targetId: source.id, type: "clones" })
        .returning(),
    );
    await publishMany(ctx, [
      { ...event, data: { ...event.data, duplicateOf: source.id } },
      ...relationEvents("relation.added", relation),
    ]);
    return row;
  },
  update_ticket: updateTicket,
  async update_ticket_labels(ctx, input) {
    const { row, event } = await updateTicketLabels(ctx, input);
    await publish(ctx, event.type, event.ticketId, event.data);
    return row;
  },
  async move_ticket(ctx, input) {
    const current = await getTicket(ctx, input.ticketId);
    assertVersion(current, input.expectedVersion, "ticket", "moving");
    await assertWorkerClaim(ctx, current, input.claimId);
    const neighbor = input.before ?? input.after,
      anchor = neighbor ? await getTicket(ctx, neighbor) : undefined;
    if (anchor?.id === current.id)
      fail(400, "validation_error", "A ticket cannot be placed next to itself");
    const state = (await resolveState(ctx, input, current)) ?? current,
      changedFields = [
        ...(state.stateId === current.stateId ? [] : ["status", "stateId"]),
        ...(anchor ? ["position"] : []),
      ];
    if (!changedFields.length) return current;
    const row = one(
      await ctx.db
        .update(tickets)
        .set({
          status: state.status,
          stateId: state.stateId,
          ...(anchor && {
            position: await positionNear(
              ctx,
              ticketPositions,
              current.id,
              anchor.id,
              input.before ? "before" : "after",
            ),
          }),
          version: current.version + 1,
          updatedAt: new Date(),
        })
        .where(eq(tickets.id, current.id))
        .returning(),
    );
    await publish(ctx, "ticket.updated", row.id, { version: row.version, changedFields });
    return row;
  },
  async check_ticket_relocation(ctx, input) {
    const ticket = await getTicket(ctx, input.ticketId);
    const { target, blockers } = await relocation(ctx, ticket, input.destinationProjectId),
      destination = project(target);
    return {
      destination: { id: destination.id, key: destination.key, name: destination.name },
      states: await projectStates(target),
      stateId: requireRow(
        await resolveState(target, { status: z.enum(states).parse(ticket.status) }),
      ).stateId,
      blockers,
    };
  },
  async relocate_ticket(ctx, input) {
    const current = await getTicket(ctx, input.ticketId);
    assertVersion(current, input.expectedVersion, "ticket", "moving");
    const { target, blockers, fields } = await relocation(ctx, current, input.destinationProjectId);
    if (blockers.length)
      fail(409, "relocation_blocked", blockers.map((item) => item.message).join(". "), {
        blockers,
      });
    // After the blockers, so a claimed ticket answers every caller with the same blocker.
    await assertWorkerClaim(ctx, current);
    const state = requireRow(
      await resolveState(target, {
        status: input.status ?? (input.stateId ? undefined : z.enum(states).parse(current.status)),
        stateId: input.stateId,
      }),
    );
    await registerLabels(target, current.labels);
    // The source hears only that a ticket left, never where it went.
    await publishMany(ctx, [
      {
        type: "ticket.moved_away",
        ticketId: null,
        data: { ticketId: current.id, key: current.key, title: current.title },
      },
    ]);
    // Every key it had here, under each prefix the project has used, keeps naming it.
    const prefixes = await ctx.db
      .select({ prefix: projectPrefixes.prefix })
      .from(projectPrefixes)
      .where(eq(projectPrefixes.projectId, current.projectId));
    await ctx.db
      .insert(ticketAliases)
      .values(
        [
          ...new Set([current.key, ...prefixes.map((row) => `${row.prefix}-${current.number}`)]),
        ].map((key) => ({ key, ticketId: current.id })),
      );
    const row = one(
      await ctx.db
        .update(tickets)
        .set({
          ...(await allocateTicket(target)),
          ...state,
          customFields: applyCustomFieldValues(fields, null, {}),
          version: current.version + 1,
          updatedAt: new Date(),
        })
        .where(eq(tickets.id, current.id))
        .returning(),
    );
    // Everything that belongs to the ticket follows it; its earlier activity stays as recorded.
    for (const table of [comments, attachments, evidence, resources, subscriptions, timeEntries])
      await ctx.db
        .update(table)
        .set({ projectId: row.projectId })
        .where(eq(table.ticketId, row.id));
    await publish(target, "ticket.moved", row.id, { from: current.key, version: row.version });
    return row;
  },
  async resolve_ticket(ctx, input) {
    const allowed = await accessibleProjectRows(ctx.db, ctx.actor);
    const [ticket] = allowed.length
      ? await ctx.db
          .select()
          .from(tickets)
          .where(
            and(
              inArray(
                tickets.projectId,
                allowed.map((row) => row.id),
              ),
              ticketMatch(input.ticketId),
            ),
          )
          .limit(1)
      : [];
    const owner = allowed.find((row) => row.id === ticket?.projectId);
    if (!ticket || !owner) fail(404, "not_found", "Ticket was not found");
    return { ticket, project: { id: owner.id, key: owner.key, name: owner.name } };
  },
  async bulk_update_tickets(ctx, input) {
    const result = [],
      pending: PendingEvent[] = [];
    for (const item of input.tickets) {
      const { row, event } = await updateTicketRow(ctx, {
        projectId: input.projectId,
        ticketId: item.ticketId,
        expectedVersion: item.expectedVersion,
        claimId: item.claimId,
        changes: input.changes,
      });
      result.push(row);
      pending.push(event);
    }
    await publishMany(ctx, pending);
    return result;
  },
  async delete_ticket(ctx, input) {
    await deleteTicketRows(ctx, [input]);
    return { ok: true };
  },
  async bulk_delete_tickets(ctx, input) {
    await deleteTicketRows(ctx, input.tickets);
    return { ok: true };
  },
  async list_eligible_tickets(ctx, input) {
    const where = and(
      eq(tickets.projectId, project(ctx).id),
      openTicket,
      eq(tickets.archived, false),
    );
    const page = await pageOf(ctx, where, [asc(tickets.number)], input);
    const eligibility = await readinessMany(ctx, page.items);
    return {
      items: page.items.map((ticket) => ({
        ticket,
        readiness: requireRow(eligibility.get(ticket.id)),
      })),
      total: page.total,
    };
  },
  async search_tickets(ctx, input) {
    const allowed = await accessibleProjectRows(ctx.db, ctx.actor, input.workspaceId, "exclude");
    if (!allowed.length) return { items: [] };
    const ids = allowed.map((row) => row.id);
    const rows = await ctx.db
      .select()
      .from(tickets)
      .where(
        and(
          inArray(tickets.projectId, ids),
          eq(tickets.archived, false),
          or(ticketMatch(input.q), (await ctx.search.where(ctx.db, ids, input.q)).where),
        ),
      )
      .orderBy(sql`CASE WHEN ${ticketMatch(input.q)} THEN 0 ELSE 1 END`, desc(tickets.updatedAt))
      .limit(input.limit);
    return {
      items: rows.flatMap((ticket) => {
        const owner = allowed.find((row) => row.id === ticket.projectId);
        return owner
          ? [{ ticket, project: { id: owner.id, key: owner.key, name: owner.name } }]
          : [];
      }),
    };
  },
  async search_workspace(ctx, input) {
    const counts = { project: 0, ticket: 0, comment: 0, activity: 0 };
    const allowed = await accessibleProjectRows(ctx.db, ctx.actor, input.workspaceId, "exclude");
    if (!allowed.length)
      return { items: [], total: 0, counts, engine: "postgres" as const, indexing: false };
    const ids = allowed.map((row) => row.id);
    await assertCustomFieldFilters(ctx, ids, input);
    const key = input.q.toUpperCase(),
      like = likePattern(input.q),
      match = await ctx.search.where(ctx.db, ids, input.q),
      filtered = ticketPredicates(input).length > 0,
      // Results that belong to a ticket also honor its filters; archived tickets stay out.
      ticketScope = and(
        inArray(tickets.projectId, ids),
        eq(tickets.archived, false),
        predicateWhere(input),
      );
    // ponytail: every family is matched with ILIKE scans per request; add trigram indexes or index
    // comments and activity externally if large workspaces make this slow.
    const hits = sql.join(
      [
        filtered
          ? undefined
          : sql`SELECT 'project' AS type, projects.id::text AS id, projects.id AS project_id,
              NULL::uuid AS ticket_id, NULL::text AS actor_id, projects.description AS body,
              NULL::text AS event_type, NULL::jsonb AS data, projects.updated_at AS at,
              CASE WHEN projects.key = ${key} THEN 0 ELSE 1 END AS rank, 0 AS family
            FROM projects WHERE ${inArray(projects.id, ids)}
              AND (projects.name ILIKE ${like} OR projects.key ILIKE ${like} OR projects.description ILIKE ${like})`,
        sql`SELECT 'ticket' AS type, tickets.id::text AS id, tickets.project_id,
              tickets.id AS ticket_id, NULL::text AS actor_id,
              concat_ws(' ', tickets.description, tickets.acceptance_criteria) AS body,
              NULL::text AS event_type, NULL::jsonb AS data, tickets.updated_at AS at,
              CASE WHEN ${ticketMatch(input.q)} THEN 0 ELSE 1 END AS rank, 1 AS family
            FROM tickets WHERE ${and(ticketScope, or(ticketMatch(input.q), match.where))}`,
        sql`SELECT 'comment' AS type, comments.id::text AS id, comments.project_id,
              comments.ticket_id, comments.actor_id, comments.body, NULL::text AS event_type,
              NULL::jsonb AS data, comments.created_at AS at, 1 AS rank, 2 AS family
            FROM comments JOIN tickets ON tickets.id = comments.ticket_id
            WHERE ${and(ticketScope, sql`comments.body ILIKE ${like}`)}`,
        // Activity matches its label, its ticket key, or an active actor's name.
        sql`SELECT 'activity' AS type, events.id::text AS id, events.project_id,
              events.ticket_id, events.actor_id, NULL::text AS body, events.type AS event_type,
              events.data, events.created_at AS at, 1 AS rank, 3 AS family
            FROM events
            LEFT JOIN tickets ON tickets.id = events.ticket_id AND tickets.project_id = events.project_id
            LEFT JOIN "user" ON "user".id = events.actor_id
            LEFT JOIN (VALUES ${sql.join(
              Object.entries(eventLabels).map(([type, label]) => sql`(${type}, ${label})`),
              sql`, `,
            )}) AS labels(type, label) ON labels.type = events.type
            WHERE ${and(
              inArray(events.projectId, ids),
              filtered ? ticketScope : undefined,
              sql`(coalesce(labels.label, replace(replace(events.type, '.', ' '), '_', ' ')) ILIKE ${like}
                OR events.data->>'key' = ${key}
                OR ("user".name ILIKE ${like} AND NOT coalesce("user".banned, false)))`,
            )}`,
      ].filter((part) => part !== undefined),
      sql` UNION ALL `,
    );
    for (const row of (
      await ctx.db.execute(
        sql`SELECT hits.type, count(*)::int AS count FROM (${hits}) AS hits GROUP BY hits.type`,
      )
    ).rows) {
      const parsed = countRow.parse(row);
      counts[parsed.type] = parsed.count;
    }
    const rows = (
      await ctx.db.execute(sql`SELECT hits.*, tickets.key, tickets.title, tickets.status
        FROM (${hits}) AS hits
        LEFT JOIN tickets ON tickets.id = hits.ticket_id AND tickets.project_id = hits.project_id
        WHERE ${input.type ? sql`hits.type = ${input.type}` : sql`true`}
        ORDER BY hits.rank, hits.family, hits.at DESC, hits.id DESC
        LIMIT ${input.limit} OFFSET ${input.offset}`)
    ).rows.map((row) => hitRow.parse(row));
    const projectsById = new Map(allowed.map((row) => [row.id, row]));
    return {
      items: rows.flatMap((row) => {
        const owner = projectsById.get(row.project_id);
        if (!owner) return [];
        const ticket =
          row.ticket_id && row.key && row.title && row.status
            ? { id: row.ticket_id, key: row.key, title: row.title, status: row.status }
            : null;
        const at = row.at.toISOString();
        return [
          {
            type: row.type,
            id: row.id,
            project: { id: owner.id, key: owner.key, name: owner.name },
            ticket,
            title:
              row.type === "project"
                ? owner.name
                : row.type === "activity"
                  ? formatEvent(
                      {
                        id: row.id,
                        projectId: owner.id,
                        ticketId: row.ticket_id,
                        actorId: row.actor_id,
                        type: row.event_type ?? "",
                        data: row.data ?? {},
                        createdAt: at,
                      },
                      true,
                    )
                  : (ticket?.title ?? ""),
            excerpt: excerpt(row.body, input.q),
            actorId: row.actor_id,
            at,
          },
        ];
      }),
      total: input.type
        ? counts[input.type]
        : counts.project + counts.ticket + counts.comment + counts.activity,
      counts,
      engine: match.engine,
      indexing: match.indexing,
    };
  },
  async claim_ticket(ctx, input) {
    const ticket = await getTicket(ctx, input.ticketId);
    assertVersion(ticket, input.expectedVersion, "ticket", "claiming");
    const eligible = await readiness(ctx, ticket);
    if (!eligible.ready) fail(409, "not_ready", "The ticket is not ready to claim", eligible);
    const claim = one(
      await ctx.db
        .insert(claims)
        .values({
          projectId: project(ctx).id,
          ticketId: ticket.id,
          actorId: ctx.actor.id,
          ownerId: ctx.actor.ownerId,
          workerId: input.workerId,
          expiresAt: claimExpiry(ctx, input.leaseSeconds),
        })
        .returning(),
    );
    const row = one(
      await ctx.db
        .update(tickets)
        .set({
          ...(await resolveState(ctx, { status: "in_progress" }, ticket)),
          claimRequired: true,
          version: ticket.version + 1,
          updatedAt: new Date(),
        })
        .where(eq(tickets.id, ticket.id))
        .returning(),
    );
    await publish(ctx, "ticket.claimed", ticket.id, {
      claimId: claim.id,
      workerId: claim.workerId,
      version: row.version,
    });
    return claim;
  },
  async renew_claim(ctx, input) {
    const ticket = await getTicket(ctx, input.ticketId);
    const current = one(
      await ctx.db
        .select()
        .from(claims)
        .where(and(eq(claims.id, input.claimId), eq(claims.ticketId, ticket.id))),
    );
    if (!ownsLiveClaim(ctx, current))
      fail(409, "claim_conflict", "Only the current worker can renew an unexpired claim");
    const claim = one(
      await ctx.db
        .update(claims)
        .set({ expiresAt: claimExpiry(ctx, input.leaseSeconds) })
        .where(eq(claims.id, current.id))
        .returning(),
    );
    await publish(ctx, "claim.renewed", ticket.id, {
      claimId: claim.id,
      expiresAt: claim.expiresAt.toISOString(),
    });
    return claim;
  },
  async release_claim(ctx, input) {
    const ticket = await getTicket(ctx, input.ticketId);
    const current = one(
      await ctx.db
        .select()
        .from(claims)
        .where(and(eq(claims.id, input.claimId), eq(claims.ticketId, ticket.id))),
    );
    if (!ownsLiveClaim(ctx, current))
      fail(
        409,
        "claim_conflict",
        "Only the owning worker can release an unexpired claim. Expired claims require explicit recovery.",
      );
    await ctx.db.delete(claims).where(eq(claims.id, current.id));
    await publish(ctx, "claim.released", ticket.id, { claimId: current.id });
    return { ok: true };
  },
  async recover_claim(ctx, input) {
    const ticket = await getTicket(ctx, input.ticketId);
    const current = one(
      await ctx.db
        .select()
        .from(claims)
        .where(and(eq(claims.id, input.claimId), eq(claims.ticketId, ticket.id))),
    );
    if (input.cancelActive && !can(ctx, "project.manage"))
      fail(
        403,
        "forbidden",
        "Cancelling an active claim requires project management access and admin scope",
      );
    if (current.expiresAt > new Date() && !input.cancelActive)
      fail(409, "claim_not_expired", "The current claim has not expired");
    if (input.reschedule && input.expectedVersion !== undefined) {
      assertVersion(ticket, input.expectedVersion, "ticket", "rescheduling recovered work");
      const row = one(
        await ctx.db
          .update(tickets)
          .set({
            ...(await resolveState(ctx, { status: "todo" }, ticket)),
            version: ticket.version + 1,
            updatedAt: new Date(),
          })
          .where(eq(tickets.id, ticket.id))
          .returning(),
      );
      await publish(ctx, "ticket.updated", ticket.id, {
        version: row.version,
        changedFields: ["status", "stateId"],
      });
    }
    await ctx.db.delete(claims).where(eq(claims.id, current.id));
    await publish(ctx, "claim.recovered", ticket.id, {
      claimId: current.id,
      reason: input.reason,
      confirmedStopped: true,
      ...(input.cancelActive && { cancelActive: true }),
    });
    return { ok: true };
  },
};
