import { and, asc, count, desc, eq, ilike, inArray, ne, or, sql } from "drizzle-orm";
import { claims, members, projects, relations, subscriptions, tickets } from "./schema.ts";
import {
  assertWorkerClaim,
  complete,
  fail,
  getTicket,
  project,
  publish,
  requireRow,
  type Context,
  type Handlers,
} from "./domain.ts";
import type { ParsedInput, Output } from "@kanvil/contracts";

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
  changes: Pick<ParsedInput<"update_ticket">["changes"], "assigneeId" | "parentId">,
) {
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
async function update(ctx: Context, input: ParsedInput<"update_ticket">) {
  const current = await getTicket(ctx, input.ticketId);
  if (current.version !== input.expectedVersion)
    fail(409, "version_conflict", "The ticket changed; reload before editing", {
      currentVersion: current.version,
    });
  await assertWorkerClaim(ctx, current.id, input.claimId);
  await validateReferences(ctx, current.id, input.changes);
  const row = requireRow(
    (
      await ctx.db
        .update(tickets)
        .set({ ...input.changes, version: current.version + 1, updatedAt: new Date() })
        .where(eq(tickets.id, current.id))
        .returning()
    )[0],
  );
  if (row.assigneeId)
    await ctx.db
      .insert(subscriptions)
      .values({ projectId: row.projectId, ticketId: row.id, userId: row.assigneeId })
      .onConflictDoNothing();
  await publish(ctx, "ticket.updated", row.id, {
    version: row.version,
    changedFields: Object.keys(input.changes),
  });
  return row;
}
export const ticketHandlers: Pick<
  Handlers,
  | "list_tickets"
  | "get_ticket"
  | "create_ticket"
  | "update_ticket"
  | "bulk_update_tickets"
  | "delete_ticket"
  | "list_eligible_tickets"
  | "claim_ticket"
  | "renew_claim"
  | "release_claim"
  | "recover_claim"
> = {
  async list_tickets(ctx, input) {
    const search = input.q
      ? `%${input.q.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_")}%`
      : undefined;
    const where = and(
      eq(tickets.projectId, project(ctx).id),
      input.status ? eq(tickets.status, input.status) : undefined,
      input.priority ? eq(tickets.priority, input.priority) : undefined,
      input.kind ? eq(tickets.kind, input.kind) : undefined,
      input.difficulty ? eq(tickets.difficulty, input.difficulty) : undefined,
      input.assigneeId ? eq(tickets.assigneeId, input.assigneeId) : undefined,
      input.label ? sql`${input.label} = ANY(${tickets.labels})` : undefined,
      input.archived === "include" ? undefined : eq(tickets.archived, input.archived === "only"),
      search
        ? or(
            ilike(tickets.title, search),
            ilike(tickets.description, search),
            ilike(tickets.key, search),
          )
        : undefined,
    );
    const order =
      input.sort === "priority"
        ? [
            sql`CASE ${tickets.priority} WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 WHEN 'low' THEN 3 ELSE 4 END`,
            asc(tickets.number),
          ]
        : input.sort === "title"
          ? [asc(tickets.title), asc(tickets.id)]
          : [
              desc(input.sort === "created" ? tickets.createdAt : tickets.updatedAt),
              asc(tickets.id),
            ];
    return {
      items: await ctx.db
        .select()
        .from(tickets)
        .where(where)
        .orderBy(...order)
        .limit(input.limit)
        .offset(input.offset),
      total: requireRow((await ctx.db.select({ count: count() }).from(tickets).where(where))[0])
        .count,
    };
  },
  async get_ticket(ctx, input) {
    const ticket = await getTicket(ctx, input.ticketId);
    return {
      ticket,
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
      claim: (await ctx.db.select().from(claims).where(eq(claims.ticketId, ticket.id)))[0] ?? null,
    };
  },
  async create_ticket(ctx, input) {
    const id = crypto.randomUUID();
    await validateReferences(ctx, id, input);
    const counter = requireRow(
      (
        await ctx.db
          .update(projects)
          .set({ nextNumber: sql`${projects.nextNumber} + 1` })
          .where(eq(projects.id, project(ctx).id))
          .returning()
      )[0],
    );
    const { projectId: _projectId, requestId: _requestId, ...fields } = input;
    const row = requireRow(
      (
        await ctx.db
          .insert(tickets)
          .values({
            ...fields,
            id,
            projectId: counter.id,
            number: counter.nextNumber - 1,
            key: `${counter.key}-${counter.nextNumber - 1}`,
            createdBy: ctx.actor.id,
          })
          .returning()
      )[0],
    );
    for (const userId of new Set([ctx.actor.id, ...(row.assigneeId ? [row.assigneeId] : [])]))
      await ctx.db
        .insert(subscriptions)
        .values({ projectId: row.projectId, ticketId: row.id, userId })
        .onConflictDoNothing();
    await publish(ctx, "ticket.created", row.id, { key: row.key, version: row.version });
    return row;
  },
  update_ticket: update,
  async bulk_update_tickets(ctx, input) {
    const result = [];
    for (const item of input.tickets)
      result.push(
        await update(ctx, {
          projectId: input.projectId,
          ticketId: item.ticketId,
          expectedVersion: item.expectedVersion,
          changes: input.changes,
        }),
      );
    return result;
  },
  async delete_ticket(ctx, input) {
    const ticket = await getTicket(ctx, input.ticketId);
    if (ticket.version !== input.expectedVersion)
      fail(409, "version_conflict", "The ticket changed; reload before deleting");
    if ((await ctx.db.select().from(claims).where(eq(claims.ticketId, ticket.id))).length)
      fail(409, "claim_conflict", "Release ownership before deleting this ticket");
    const children = await ctx.db
      .update(tickets)
      .set({ parentId: null, version: sql`${tickets.version} + 1`, updatedAt: new Date() })
      .where(eq(tickets.parentId, ticket.id))
      .returning();
    for (const child of children)
      await publish(ctx, "ticket.updated", child.id, {
        version: child.version,
        changedFields: ["parentId"],
      });
    await publish(ctx, "ticket.deleted", ticket.id, { key: ticket.key, version: ticket.version });
    await ctx.db.delete(tickets).where(eq(tickets.id, ticket.id));
    return { ok: true };
  },
  async list_eligible_tickets(ctx, input) {
    const where = and(
      eq(tickets.projectId, project(ctx).id),
      ne(tickets.status, "done"),
      ne(tickets.status, "cancelled"),
      eq(tickets.archived, false),
    );
    const rows = await ctx.db
      .select()
      .from(tickets)
      .where(where)
      .orderBy(asc(tickets.number))
      .limit(input.limit)
      .offset(input.offset);
    const eligibility = await readinessMany(ctx, rows);
    return {
      items: rows.map((ticket) => ({ ticket, readiness: requireRow(eligibility.get(ticket.id)) })),
      total: requireRow((await ctx.db.select({ count: count() }).from(tickets).where(where))[0])
        .count,
    };
  },
  async claim_ticket(ctx, input) {
    const ticket = await getTicket(ctx, input.ticketId);
    if (ticket.version !== input.expectedVersion)
      fail(409, "version_conflict", "The ticket changed; refresh its eligibility");
    const eligible = await readiness(ctx, ticket);
    if (!eligible.ready) fail(409, "not_ready", "The ticket is not ready to claim", eligible);
    const claim = requireRow(
      (
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
          .returning()
      )[0],
    );
    const row = requireRow(
      (
        await ctx.db
          .update(tickets)
          .set({ status: "in_progress", version: ticket.version + 1, updatedAt: new Date() })
          .where(eq(tickets.id, ticket.id))
          .returning()
      )[0],
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
    const current = requireRow(
      (
        await ctx.db
          .select()
          .from(claims)
          .where(and(eq(claims.id, input.claimId), eq(claims.ticketId, ticket.id)))
      )[0],
    );
    if (current.ownerId !== ctx.actor.ownerId || current.expiresAt <= new Date())
      fail(409, "claim_conflict", "Only the current worker can renew an unexpired claim");
    const claim = requireRow(
      (
        await ctx.db
          .update(claims)
          .set({ expiresAt: new Date(Date.now() + input.leaseSeconds * 1000) })
          .where(eq(claims.id, current.id))
          .returning()
      )[0],
    );
    await publish(ctx, "claim.renewed", ticket.id, {
      claimId: claim.id,
      expiresAt: claim.expiresAt.toISOString(),
    });
    return claim;
  },
  async release_claim(ctx, input) {
    const ticket = await getTicket(ctx, input.ticketId);
    const current = requireRow(
      (
        await ctx.db
          .select()
          .from(claims)
          .where(and(eq(claims.id, input.claimId), eq(claims.ticketId, ticket.id)))
      )[0],
    );
    if (current.ownerId !== ctx.actor.ownerId)
      fail(403, "forbidden", "Only the owning worker can release this claim");
    await ctx.db.delete(claims).where(eq(claims.id, current.id));
    await publish(ctx, "claim.released", ticket.id, { claimId: current.id });
    return { ok: true };
  },
  async recover_claim(ctx, input) {
    const ticket = await getTicket(ctx, input.ticketId);
    const current = requireRow(
      (
        await ctx.db
          .select()
          .from(claims)
          .where(and(eq(claims.id, input.claimId), eq(claims.ticketId, ticket.id)))
      )[0],
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
