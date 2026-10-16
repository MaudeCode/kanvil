import {
  and,
  asc,
  count,
  desc,
  eq,
  getTableColumns,
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
  claims,
  members,
  projects,
  projectLabels,
  relations,
  subscriptions,
  tickets,
} from "./schema.ts";
import {
  assertVersion,
  assertWorkerClaim,
  ownsLiveClaim,
  complete,
  fail,
  getTicket,
  project,
  publish,
  publishMany,
  requireRow,
  subscribe,
  type Context,
  type Handlers,
  type PendingEvent,
  one,
} from "./domain.ts";
import { accessibleProjectRows } from "./project-access.ts";
import {
  closedStates,
  defaultOrder,
  difficulties,
  priorities,
  states,
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
// Contracts carry ISO strings; the column stores a timestamp.
const dueColumn = (dueAt: string | null | undefined) =>
  dueAt === undefined ? {} : { dueAt: dueAt ? new Date(dueAt) : null };

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
    if (ticket.status !== "todo" || ticket.archived)
      reasons.push({ code: "not_open", message: "Ticket must be in To do and unarchived" });
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
export async function readiness(ctx: Context, ticket: typeof tickets.$inferSelect) {
  return requireRow((await readinessMany(ctx, [ticket])).get(ticket.id));
}
async function validateReferences(
  ctx: Context,
  ticketId: string,
  changes: Pick<ParsedInput<"update_ticket">["changes"], "assigneeId" | "parentId" | "labels">,
) {
  if (changes.labels?.length)
    await ctx.db
      .insert(projectLabels)
      .values(changes.labels.map((name) => ({ projectId: project(ctx).id, name })))
      .onConflictDoNothing();
  if (
    changes.assigneeId &&
    !(
      await ctx.db
        .select()
        .from(members)
        .where(and(eq(members.projectId, project(ctx).id), eq(members.userId, changes.assigneeId)))
        .limit(1)
    ).length
  )
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
  await validateReferences(ctx, current.id, input.changes);
  const { dueAt, ...changes } = input.changes;
  const row = one(
    await ctx.db
      .update(tickets)
      .set({
        ...changes,
        ...dueColumn(dueAt),
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
    data: { version: row.version, changedFields: Object.keys(input.changes) },
  };
  return { row, event };
}
export async function updateTicket(ctx: Context, input: ParsedInput<"update_ticket">) {
  const { row, event } = await updateTicketRow(ctx, input);
  await publish(ctx, event.type, event.ticketId, event.data);
  return row;
}
export function labelUsage(ctx: Context, archived: "include" | "exclude" | "only") {
  const labels = ctx.db
    .select({ name: sql<string>`unnest(${tickets.labels})`.as("name") })
    .from(tickets)
    .where(
      and(
        eq(tickets.projectId, project(ctx).id),
        archived === "include" ? undefined : eq(tickets.archived, archived === "only"),
      ),
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
export const ticketHandlers: Pick<
  Handlers,
  | "list_tickets"
  | "list_ticket_labels"
  | "get_ticket"
  | "create_ticket"
  | "update_ticket"
  | "bulk_update_tickets"
  | "delete_ticket"
  | "search_tickets"
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
    const search = input.q ? await ctx.search.where(ctx.db, [project(ctx).id], input.q) : undefined;
    const where = and(
      eq(tickets.projectId, project(ctx).id),
      parent ? eq(tickets.parentId, parent.id) : undefined,
      input.status ? eq(tickets.status, input.status) : undefined,
      input.priority ? eq(tickets.priority, input.priority) : undefined,
      input.kind ? eq(tickets.kind, input.kind) : undefined,
      input.difficulty ? eq(tickets.difficulty, input.difficulty) : undefined,
      input.assigneeId === "none"
        ? isNull(tickets.assigneeId)
        : input.assigneeId
          ? eq(tickets.assigneeId, input.assigneeId)
          : undefined,
      input.label ? sql`${input.label} = ANY(${tickets.labels})` : undefined,
      input.archived === "include" ? undefined : eq(tickets.archived, input.archived === "only"),
      dueWhere(input.due),
      search,
    );
    const direction = input.order ?? defaultOrder[input.sort];
    const by = (column: SQL | AnyColumn, flip = false) =>
      (direction === "asc") !== flip
        ? sql`${column} ASC NULLS LAST`
        : sql`${column} DESC NULLS LAST`;
    const primary: Record<typeof input.sort, SQL> = {
      priority: by(rank(tickets.priority, priorities)),
      updated: by(tickets.updatedAt),
      created: by(tickets.createdAt),
      title: by(sql`lower(${tickets.title})`),
      labels: by(
        sql`(SELECT min(lower(label) COLLATE "C") FROM unnest(${tickets.labels}) AS label)`,
      ),
      due: by(tickets.dueAt),
      number: by(tickets.number),
      status: by(rank(tickets.status, states)),
      difficulty: by(rank(tickets.difficulty, difficulties)),
      kind: by(tickets.kind),
      assignee: by(sql`(SELECT lower(name) FROM "user" WHERE id = ${tickets.assigneeId})`),
    };
    const order = [primary[input.sort], asc(tickets.number)];
    return pageOf(ctx, where, order, input);
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
    const id = crypto.randomUUID();
    await validateReferences(ctx, id, input);
    const counter = one(
      await ctx.db
        .update(projects)
        .set({ nextNumber: sql`${projects.nextNumber} + 1` })
        .where(eq(projects.id, project(ctx).id))
        .returning(),
    );
    const { projectId: _projectId, requestId: _requestId, dueAt, ...fields } = input;
    const row = one(
      await ctx.db
        .insert(tickets)
        .values({
          ...fields,
          ...dueColumn(dueAt),
          id,
          projectId: counter.id,
          number: counter.nextNumber - 1,
          key: `${counter.key}-${counter.nextNumber - 1}`,
          createdBy: ctx.actor.id,
        })
        .returning(),
    );
    await subscribe(ctx, row.projectId, row.id, [ctx.actor.id, row.assigneeId]);
    await publish(ctx, "ticket.created", row.id, { key: row.key, version: row.version });
    return row;
  },
  update_ticket: updateTicket,
  async bulk_update_tickets(ctx, input) {
    const result = [],
      pending: PendingEvent[] = [];
    for (const item of input.tickets) {
      const { row, event } = await updateTicketRow(ctx, {
        projectId: input.projectId,
        ticketId: item.ticketId,
        expectedVersion: item.expectedVersion,
        changes: input.changes,
      });
      result.push(row);
      pending.push(event);
    }
    await publishMany(ctx, pending);
    return result;
  },
  async delete_ticket(ctx, input) {
    const ticket = await getTicket(ctx, input.ticketId);
    assertVersion(ticket, input.expectedVersion, "ticket", "deleting");
    if ((await ctx.db.select().from(claims).where(eq(claims.ticketId, ticket.id))).length)
      fail(409, "claim_conflict", "Release ownership before deleting this ticket");
    const children = await ctx.db
      .update(tickets)
      .set({ parentId: null, version: sql`${tickets.version} + 1`, updatedAt: new Date() })
      .where(eq(tickets.parentId, ticket.id))
      .returning();
    await publishMany(ctx, [
      ...children.map((child) => ({
        type: "ticket.updated",
        ticketId: child.id,
        data: { version: child.version, changedFields: ["parentId"] },
      })),
      {
        type: "ticket.deleted",
        ticketId: ticket.id,
        data: { key: ticket.key, version: ticket.version },
      },
    ]);
    await ctx.db.delete(tickets).where(eq(tickets.id, ticket.id));
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
    const allowed = await accessibleProjectRows(ctx.db, ctx.actor, input.workspaceId);
    if (!allowed.length) return { items: [] };
    const ids = allowed.map((row) => row.id);
    const rows = await ctx.db
      .select()
      .from(tickets)
      .where(
        and(
          inArray(tickets.projectId, ids),
          eq(tickets.archived, false),
          or(eq(tickets.key, input.q.toUpperCase()), await ctx.search.where(ctx.db, ids, input.q)),
        ),
      )
      .orderBy(
        sql`CASE WHEN ${tickets.key} = ${input.q.toUpperCase()} THEN 0 ELSE 1 END`,
        desc(tickets.updatedAt),
      )
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
          expiresAt: new Date(Date.now() + input.leaseSeconds * 1000),
        })
        .returning(),
    );
    const row = one(
      await ctx.db
        .update(tickets)
        .set({
          status: "in_progress",
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
        .set({ expiresAt: new Date(Date.now() + input.leaseSeconds * 1000) })
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
        "Only the owning worker can release an unexpired claim. Expired claims require administrator recovery.",
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
    if (current.expiresAt > new Date())
      fail(409, "claim_not_expired", "The current claim has not expired");
    await ctx.db.delete(claims).where(eq(claims.id, current.id));
    await publish(ctx, "claim.recovered", ticket.id, {
      claimId: current.id,
      reason: input.reason,
      confirmedStopped: true,
    });
    return { ok: true };
  },
};
