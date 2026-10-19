import { createHash } from "node:crypto";
import { and, eq, inArray, isNull, notInArray, or, sql } from "drizzle-orm";
import { z } from "zod";
import {
  ApiError,
  closedStates,
  operations,
  repositoryProviderDefinitions,
  type IssueContent,
  type SyncRule,
} from "@kanvil/contracts";
import { user } from "./auth-schema.ts";
import {
  comments,
  deliveries,
  events,
  issueLinks,
  projects,
  repositoryConnections,
  syncedComments,
  tickets,
  workspaceLabels,
} from "./schema.ts";
import {
  appendEvents,
  assertVersion,
  complete,
  fail,
  one,
  project,
  publish,
  type Context,
  type Handlers,
} from "./domain.ts";
import { createTicketRow, updateTicketRow } from "./ticket-operations.ts";
import { addComment } from "./collaboration-operations.ts";
import {
  connectionEvent,
  driverFor,
  linkTicket,
  ownConnection,
  presentOne,
  providerOf,
  readRepositorySettings,
} from "./repository-operations.ts";
import { connectionWriter, finish, quiet, recordHealth, retry, type Job } from "./outbox.ts";
import { DeliveryError } from "./adapters/outbound.ts";
import type {
  OutboundRequest,
  OutboundSenders,
  RemoteComment,
  RemoteIssue,
  RepositoryChange,
  RepositoryDrivers,
} from "./adapters/ports.ts";
import type { Database } from "./database.ts";
import type { Sealer } from "./sealing.ts";

// Issue sync keeps a ticket's title, description, and open state equal to one issue's, and copies
// new comments both ways. Each link stores `base`, the content both sides last agreed on: a side
// that differs from it changed, so a change on one side is copied to the other and a change on both
// stops the link for review. A link only resumes from review with an administrator's chosen side.
type Connection = typeof repositoryConnections.$inferSelect;
type Link = typeof issueLinks.$inferSelect;
type Ticket = typeof tickets.$inferSelect;
type Db = Context["db"];
const fields = ["title", "description", "open"] as const;
const stored = ({ title, description, open }: IssueContent): IssueContent => ({
  title,
  description,
  open,
});
// Hosts and Kanvil normalize whitespace differently; such differences are not changes.
const normal = {
  title: (value: string) => value.replace(/\s+/gu, " ").trim(),
  description: (value: string) => value.replaceAll("\r\n", "\n").trim(),
};
type Field = (typeof fields)[number];
const same = (field: Field, a: IssueContent, b: IssueContent) =>
  field === "open" ? a.open === b.open : normal[field](a[field]) === normal[field](b[field]);
function copy(target: Partial<IssueContent>, field: Field, source: IssueContent) {
  if (field === "open") target.open = source.open;
  else target[field] = source[field];
}
const differs = (a: IssueContent, b: IssueContent) => fields.filter((field) => !same(field, a, b));
export const localContent = (ticket: Ticket): IssueContent => ({
  title: ticket.title,
  description: ticket.description,
  open: !complete(ticket.status),
});
// The ticket update that writes issue content, validated whole. Content a ticket cannot hold is
// refused, never shortened: a shortened copy would read as a Kanvil edit and overwrite the issue.
const issueUpdate = (ticket: Ticket, content: Partial<IssueContent>) =>
  operations.update_ticket.input.safeParse({
    projectId: ticket.projectId,
    ticketId: ticket.id,
    expectedVersion: ticket.version,
    changes: {
      ...(content.title !== undefined && { title: content.title }),
      ...(content.description !== undefined && { description: content.description }),
      ...(content.open !== undefined && { status: content.open ? "todo" : "done" }),
    },
  });

// An exported issue's body ends with a hidden marker naming its ticket. When the host's answer to the
// creation is lost, the issue's own webhook still finds the waiting link by it; copied comments carry
// one too, so their webhooks are recognized as Kanvil's own.
const ticketMarker = /\s*<!-- kanvil:ticket:([0-9a-f-]{36}) -->\s*$/;
const commentMarker = /<!-- kanvil:comment:([0-9a-f-]{36}) -->/;
const issueBody = (ticketId: string, description: string) =>
  `${description}\n\n<!-- kanvil:ticket:${ticketId} -->`;
function remoteContent(issue: RemoteIssue) {
  const marker = ticketMarker.exec(issue.description);
  return {
    content: {
      title: issue.title,
      description: marker ? issue.description.slice(0, marker.index) : issue.description,
      open: issue.open,
      labels: issue.labels,
    },
    ticketId: marker?.[1] ?? null,
  };
}

// Rules name workspace labels by ID; tickets and issues carry names, compared without case.
async function labelNames(db: Db, workspaceId: string, rules: SyncRule[]) {
  const ids = [...new Set(rules.flatMap((rule) => rule.labels))];
  if (!ids.length) return new Map<string, string>();
  const rows = await db
    .select({ id: workspaceLabels.id, name: workspaceLabels.name })
    .from(workspaceLabels)
    .where(and(eq(workspaceLabels.workspaceId, workspaceId), inArray(workspaceLabels.id, ids)));
  return new Map(rows.map((row) => [row.id, row.name]));
}
type Names = Map<string, string>;
function matches(rule: SyncRule, names: Names, labels: readonly string[]) {
  if (!rule.enabled) return false;
  if (!rule.labels.length) return true;
  const carried = new Set(labels.map((label) => label.toLowerCase()));
  const has = (id: string) => carried.has(names.get(id)?.toLowerCase() ?? "\u0000");
  return rule.match === "all" ? rule.labels.every(has) : rule.labels.some(has);
}
// A link keeps syncing while the rule of the side it started from still covers it: an exported
// ticket by its labels, an imported issue by its labels on the host.
const qualifies = (
  rules: Pick<Connection, "inbound" | "outbound">,
  names: Names,
  link: Pick<Link, "origin" | "remote">,
  ticket: Ticket,
) =>
  link.origin === "outbound"
    ? matches(rules.outbound, names, ticket.labels)
    : matches(rules.inbound, names, link.remote?.labels ?? []);
const workspaceOf = async (db: Db, projectId: string) =>
  one(
    await db
      .select({ workspaceId: projects.workspaceId })
      .from(projects)
      .where(eq(projects.id, projectId)),
  ).workspaceId;

// Updates links and records one event per link whose state or reason changed. Every update moves the
// version, so a comparison read before it is refused. Events are project settings activity, not
// ticket activity, so they reach no follower or destination.
async function setLinks(
  db: Db,
  projectId: string,
  links: Link[],
  changes: Partial<typeof issueLinks.$inferInsert>,
) {
  if (!links.length) return [];
  const rows = await db
    .update(issueLinks)
    .set({ ...changes, version: sql`${issueLinks.version} + 1`, updatedAt: new Date() })
    .where(
      inArray(
        issueLinks.id,
        links.map((link) => link.id),
      ),
    )
    .returning();
  const changed = rows.filter((row) => {
    const before = links.find((link) => link.id === row.id);
    return before?.state !== row.state || before.reason !== row.reason;
  });
  if (changed.length)
    await appendEvents(
      db,
      changed.map((row) => ({
        projectId,
        ticketId: null,
        actorId: null,
        type: "issue_link.updated",
        data: {
          connectionId: row.connectionId,
          linkId: row.id,
          ticketId: row.ticketId,
          state: row.state,
          reason: row.reason,
          version: row.version,
          source: { kind: "repository", id: row.connectionId },
        },
      })),
    );
  return rows;
}
const setLink = async (
  db: Db,
  projectId: string,
  link: Link,
  changes: Partial<typeof issueLinks.$inferInsert>,
) => one(await setLinks(db, projectId, [link], changes));
// Queues the link's content sync; one waits per link and reads the latest content when it runs.
async function queueSync(db: Db, links: Pick<Link, "id" | "connectionId">[]) {
  if (links.length)
    await db
      .insert(deliveries)
      .values(links.map((link) => ({ connectionId: link.connectionId, issueLinkId: link.id })))
      .onConflictDoNothing();
}
// After a connection resumes, links pick up the Kanvil changes made while it was paused.
export const requeueLinks = (db: Db, connectionId: string) =>
  db.execute(sql`INSERT INTO ${deliveries} (connection_id, issue_link_id)
    SELECT connection_id, id FROM ${issueLinks}
    WHERE connection_id = ${connectionId} AND state IN ('active', 'creating')
    ON CONFLICT DO NOTHING`);

// Runs with every appended event, like destination fan-out: a ticket change exports a newly
// qualifying ticket, pauses a link whose ticket lost its labels, holds a requalifying one for review,
// and queues the content sync; a new comment queues its copy.
export async function queueIssueSync(db: Db, rows: (typeof events.$inferSelect)[]) {
  const relevant = rows.filter(
    (event) =>
      event.ticketId && (event.type.startsWith("ticket.") || event.type === "comment.created"),
  );
  if (!relevant.length) return;
  const ticketIds = [...new Set(relevant.map((event) => event.ticketId ?? ""))],
    projectIds = [...new Set(relevant.map((event) => event.projectId))];
  const links = await db.select().from(issueLinks).where(inArray(issueLinks.ticketId, ticketIds));
  const connections = await db
    .select()
    .from(repositoryConnections)
    .where(
      or(
        and(
          inArray(repositoryConnections.projectId, projectIds),
          sql`(${repositoryConnections.outbound}->>'enabled')::boolean`,
        ),
        links.length
          ? inArray(
              repositoryConnections.id,
              links.map((link) => link.connectionId),
            )
          : undefined,
      ),
    );
  if (!connections.length) return;
  const found = await db.select().from(tickets).where(inArray(tickets.id, ticketIds));
  const names = new Map<string, Names>();
  for (const connection of connections)
    names.set(
      connection.id,
      await labelNames(db, await workspaceOf(db, connection.projectId), [
        connection.inbound,
        connection.outbound,
      ]),
    );
  const commentEvents = relevant.filter((event) => event.type === "comment.created");
  // Comments already on an issue, or copied from it, by link.
  const copied = new Set(
    commentEvents.length
      ? (
          await db
            .select({ linkId: syncedComments.linkId, id: syncedComments.commentId })
            .from(syncedComments)
            .where(
              inArray(
                syncedComments.commentId,
                commentEvents.map((event) => String(event.data.commentId)),
              ),
            )
        ).map((row) => `${row.linkId}:${row.id}`)
      : [],
  );
  for (const ticket of found)
    for (const connection of connections) {
      const link = links.find(
          (item) => item.connectionId === connection.id && item.ticketId === ticket.id,
        ),
        labelled = names.get(connection.id) ?? new Map<string, string>();
      if (!link) {
        if (
          connection.projectId === ticket.projectId &&
          !ticket.archived &&
          !complete(ticket.status) &&
          matches(connection.outbound, labelled, ticket.labels)
        ) {
          const created = await db
            .insert(issueLinks)
            .values({
              connectionId: connection.id,
              ticketId: ticket.id,
              origin: "outbound",
              state: "creating",
            })
            .onConflictDoNothing()
            .returning();
          await queueSync(db, created);
        }
        continue;
      }
      // A ticket that moved to another project leaves this repository's issue behind; the link
      // goes, so nothing of the ticket stays readable from its old project.
      if (ticket.projectId !== connection.projectId) {
        await db.delete(issueLinks).where(eq(issueLinks.id, link.id));
        continue;
      }
      const qualified = qualifies(connection, labelled, link, ticket);
      if (link.state === "active" && !qualified)
        await setLink(db, connection.projectId, link, { state: "paused", reason: "labels" });
      else if (link.state === "paused" && link.reason === "labels" && qualified)
        await setLink(db, connection.projectId, link, { state: "review", reason: "labels" });
      else if (link.state === "active" && !connection.paused) {
        await queueSync(db, [link]);
        const fresh = commentEvents.filter(
          (event) =>
            event.ticketId === ticket.id &&
            !copied.has(`${link.id}:${String(event.data.commentId)}`),
        );
        if (fresh.length)
          await db
            .insert(deliveries)
            .values(
              fresh.map((event) => ({
                connectionId: connection.id,
                issueLinkId: link.id,
                eventId: event.id,
              })),
            )
            .onConflictDoNothing();
      }
    }
}

// ---- Webhooks: what the host reports, applied inside the webhook's write transaction ----

const linkByNumber = async (db: Db, connectionId: string, number: number) =>
  (
    await db
      .select()
      .from(issueLinks)
      .where(and(eq(issueLinks.connectionId, connectionId), eq(issueLinks.number, number)))
  )[0];
// A delivery older than the issue state already recorded changes nothing.
const stale = (link: Link, issue: RemoteIssue) =>
  !!(link.remoteAt && issue.updatedAt && issue.updatedAt < link.remoteAt);
const reported = (issue: RemoteIssue, content: Link["remote"]) => ({
  remote: content,
  remoteAt: issue.updatedAt ?? new Date(),
  url: issue.url,
});

// While the connection is paused nothing applies, but the issue as reported is kept, and an active
// link whose issue changed waits for review instead of overwriting either side when it resumes.
export async function recordPausedIssue(db: Db, connection: Connection, issue: RemoteIssue) {
  const link = await linkByNumber(db, connection.id, issue.number);
  if (!link || stale(link, issue)) return;
  const { content } = remoteContent(issue);
  const changed = link.state === "active" && link.base && differs(content, link.base).length > 0;
  await setLink(db, connection.projectId, link, {
    ...reported(issue, content),
    ...(changed && { state: "review", reason: "changed_while_paused" }),
  });
}

// Applies an issue event: confirms a created issue by its marker, imports a newly qualifying issue as
// a ticket, or merges the issue's change into its linked ticket.
export async function receiveIssue(
  ctx: Context,
  connection: Connection,
  issue: RemoteIssue,
  change: RepositoryChange | null,
  occurredAt: Date,
): Promise<{ key: string; result: string } | null> {
  const db = ctx.db,
    names = await labelNames(db, project(ctx).workspaceId, [
      connection.inbound,
      connection.outbound,
    ]);
  const { content, ticketId: marked } = remoteContent(issue);
  let link = await linkByNumber(db, connection.id, issue.number);
  if (!link && marked) {
    const waiting = (
      await db
        .select()
        .from(issueLinks)
        .where(
          and(
            eq(issueLinks.connectionId, connection.id),
            eq(issueLinks.ticketId, marked),
            isNull(issueLinks.number),
          ),
        )
    )[0];
    // The issue was created from this content, so it is the starting point both sides agree on.
    if (waiting)
      link = await setLink(db, connection.projectId, waiting, {
        ...reported(issue, content),
        number: issue.number,
        base: stored(content),
        state: "active",
        reason: null,
        syncedFrom: new Date(),
      });
  }
  if (!link) {
    if (!issue.open || !matches(connection.inbound, names, content.labels)) return null;
    // Import: the rule's labels the issue carries come along, spelled as the workspace spells them.
    const carried = new Set(content.labels.map((label) => label.toLowerCase()));
    const labels = connection.inbound.labels
      .map((id) => names.get(id))
      .filter((name): name is string => !!name && carried.has(name.toLowerCase()));
    const input = operations.create_ticket.input.safeParse({
      projectId: connection.projectId,
      title: content.title.trim() || `Issue #${issue.number}`,
      description: content.description,
      status: "todo",
      labels,
    });
    if (!input.success) return { key: `#${issue.number}`, result: "invalid_content" };
    const { row: ticket, event } = await createTicketRow(ctx, input.data);
    await publish(ctx, event.type, event.ticketId, event.data);
    // The creation's own event may already have queued an export of the new ticket; the import
    // takes that link over before anything is sent.
    await db
      .insert(issueLinks)
      .values({
        connectionId: connection.id,
        ticketId: ticket.id,
        origin: "inbound",
        state: "active",
        number: issue.number,
        url: issue.url,
        base: stored(content),
        remote: content,
        remoteAt: issue.updatedAt ?? new Date(),
      })
      .onConflictDoUpdate({
        target: [issueLinks.connectionId, issueLinks.ticketId],
        set: {
          origin: "inbound",
          state: "active",
          reason: null,
          number: issue.number,
          url: issue.url,
          base: stored(content),
          remote: content,
          remoteAt: issue.updatedAt ?? new Date(),
          version: sql`${issueLinks.version} + 1`,
        },
      });
    if (change) await linkTicket(ctx, connection, ticket, change, occurredAt);
    return { key: ticket.key, result: "imported" };
  }
  const ticket = one(await db.select().from(tickets).where(eq(tickets.id, link.ticketId)));
  if (stale(link, issue)) return { key: ticket.key, result: "stale" };
  const recorded = reported(issue, content);
  if (link.state !== "active" || ticket.projectId !== connection.projectId) {
    const requalified =
      link.state === "paused" &&
      link.reason === "labels" &&
      qualifies(connection, names, { ...link, remote: content }, ticket);
    await setLink(db, connection.projectId, link, {
      ...recorded,
      ...(requalified && { state: "review", reason: "labels" }),
    });
    return { key: ticket.key, result: requalified ? "review" : link.state };
  }
  if (!qualifies(connection, names, { ...link, remote: content }, ticket)) {
    await setLink(db, connection.projectId, link, {
      ...recorded,
      state: "paused",
      reason: "labels",
    });
    return { key: ticket.key, result: "paused" };
  }
  const local = localContent(ticket),
    base = link.base ?? stored(content),
    next = { ...base },
    apply: Partial<IssueContent> = {};
  for (const field of fields) {
    if (same(field, local, content)) copy(next, field, local);
    else if (same(field, content, base)) continue;
    else if (same(field, local, base)) copy(apply, field, content);
    else {
      await setLink(db, connection.projectId, link, {
        ...recorded,
        state: "review",
        reason: "conflict",
      });
      return { key: ticket.key, result: "conflict" };
    }
  }
  if (Object.keys(apply).length) {
    // The normal ticket update: version, claim, and workflow checks, and its event. The connection
    // writes as a worker without a claim, so a claimed ticket stops the link for review instead.
    const input = issueUpdate(ticket, apply);
    try {
      if (!input.success) fail(400, "invalid_content", "The issue does not fit a ticket");
      const { event } = await updateTicketRow(ctx, input.data);
      await publish(ctx, event.type, event.ticketId, event.data);
    } catch (error) {
      if (!(error instanceof ApiError)) throw error;
      await setLink(db, connection.projectId, link, {
        ...recorded,
        state: "review",
        reason: error.code,
      });
      return { key: ticket.key, result: error.code };
    }
    Object.assign(next, apply);
  }
  const saved = await setLink(db, connection.projectId, link, { ...recorded, base: next });
  // Kanvil changes the issue does not have yet go out with the queued sync.
  if (differs(local, next).length && !Object.keys(apply).length) await queueSync(db, [saved]);
  return { key: ticket.key, result: "synced" };
}

// Copies a person's new issue comment to the linked ticket. Kanvil's own copies, repeats, comments
// older than the link, and comments while the link is stopped are not copied.
export async function receiveComment(
  ctx: Context,
  connection: Connection,
  comment: RemoteComment,
): Promise<{ key: string; result: string } | null> {
  const db = ctx.db,
    link = await linkByNumber(db, connection.id, comment.issue);
  if (!link) return null;
  const ticket = one(await db.select().from(tickets).where(eq(tickets.id, link.ticketId)));
  const result = (value: string) => ({ key: ticket.key, result: value });
  const own = commentMarker.exec(comment.body)?.[1];
  if (own) {
    const local = (
      await db
        .select({ id: comments.id })
        .from(comments)
        .where(and(eq(comments.id, own), eq(comments.ticketId, ticket.id)))
    )[0];
    await db
      .insert(syncedComments)
      .values({ linkId: link.id, commentId: local?.id ?? null, remoteId: comment.id })
      .onConflictDoNothing();
    return result("echo");
  }
  const known = await db
    .select({ id: syncedComments.remoteId })
    .from(syncedComments)
    .where(and(eq(syncedComments.linkId, link.id), eq(syncedComments.remoteId, comment.id)));
  if (known.length) return result("duplicate");
  if (link.state !== "active" || ticket.projectId !== connection.projectId)
    return result(link.state);
  if (comment.createdAt && comment.createdAt < link.syncedFrom) return result("historical");
  const host = repositoryProviderDefinitions[providerOf(connection)].label;
  const header = `**${comment.author || "Someone"}** commented on ${host}:\n\n`;
  const row = await addComment(
    ctx,
    operations.add_comment.input.parse({
      projectId: ticket.projectId,
      ticketId: ticket.id,
      body: (header + comment.body).slice(0, 50_000),
    }),
  );
  await db
    .insert(syncedComments)
    .values({ linkId: link.id, commentId: row.id, remoteId: comment.id })
    .onConflictDoNothing();
  return result("commented");
}

// ---- Outbox: writes to the host, verified from the host's answer ----

type Sent = { ok: true; body: string } | { ok: false; error: DeliveryError };
async function call(senders: OutboundSenders, request: OutboundRequest): Promise<Sent> {
  try {
    const { status, body = "" } = await senders.http(request);
    if (status >= 300 && status < 400)
      return { ok: false, error: new DeliveryError("redirect_blocked", false) };
    if (status >= 400)
      return {
        ok: false,
        error: new DeliveryError(
          `http_${status}`,
          status === 408 || status === 429 || status >= 500,
        ),
      };
    return { ok: true, body };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof DeliveryError ? error : new DeliveryError("delivery_failed", true),
    };
  }
}
// Failures where the host never acted on the request, so sending it again cannot repeat a write.
const unsent = (error: DeliveryError) =>
  ["http_429", "dns_error", "blocked_address", "invalid_endpoint", "redirect_blocked"].includes(
    error.code,
  ) ||
  (error.code.startsWith("http_4") && error.code !== "http_408");
// Serialized with webhooks and operations, so a link's state is never written from two places.
const locked = <T>(database: Database, run: (db: Db) => Promise<T>) =>
  database.db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(7361080)`);
    return run(tx);
  });
const fresh = async (db: Db, id: string) =>
  (await db.select().from(issueLinks).where(eq(issueLinks.id, id)).for("update"))[0];

export async function sendIssueSync(
  database: Database,
  senders: OutboundSenders,
  secrets: Sealer,
  drivers: RepositoryDrivers,
  job: Job,
  event: typeof events.$inferSelect | null,
) {
  const loaded = (
    await database.db
      .select({
        link: issueLinks,
        ticket: tickets,
        connection: repositoryConnections,
        archivedAt: projects.archivedAt,
        writer: connectionWriter,
      })
      .from(issueLinks)
      .innerJoin(tickets, eq(tickets.id, issueLinks.ticketId))
      .innerJoin(repositoryConnections, eq(repositoryConnections.id, issueLinks.connectionId))
      .innerJoin(projects, eq(projects.id, repositoryConnections.projectId))
      .where(eq(issueLinks.id, job.issueLinkId ?? ""))
  )[0];
  if (!loaded) return finish(database.db, job, "link_removed");
  const { link, ticket, connection } = loaded;
  // Writes act for the connecting administrator, so they stop with that person's write access.
  const skip = connection.paused
    ? "paused"
    : !loaded.writer
      ? "access_revoked"
      : loaded.archivedAt
        ? "project_archived"
        : ticket.projectId !== connection.projectId
          ? "moved"
          : null;
  // Lost access and archiving end without a resume that would send the change, so the link stops
  // for review instead of claiming to sync; a paused connection queues its links again on resume.
  if (skip === "access_revoked" || skip === "project_archived")
    return locked(database, async (db) => {
      await finish(db, job, skip);
      const current = await fresh(db, link.id);
      if (current?.state === "active" || current?.state === "creating")
        await setLink(db, connection.projectId, current, {
          state: current.state === "active" ? "review" : "paused",
          reason: skip,
        });
    });
  if (skip) return finish(database.db, job, skip);
  const driver = driverFor(drivers, connection),
    { token } = readRepositorySettings(secrets, connection.settings),
    projectId = connection.projectId;
  const settle = async (sent: Sent) => {
    await recordHealth(database, job, sent.ok ? null : sent.error.code);
    return sent;
  };

  if (job.eventId) {
    const commentId = z.uuid().safeParse(event?.data.commentId);
    const comment = commentId.success
      ? (
          await database.db
            .select({ comment: comments, author: user.name })
            .from(comments)
            .leftJoin(user, eq(user.id, comments.actorId))
            .where(and(eq(comments.id, commentId.data), eq(comments.ticketId, ticket.id)))
        )[0]
      : undefined;
    if (!comment) return finish(database.db, job, "comment_removed");
    const copied = await database.db
      .select({ id: syncedComments.remoteId })
      .from(syncedComments)
      .where(
        and(eq(syncedComments.linkId, link.id), eq(syncedComments.commentId, comment.comment.id)),
      );
    if (copied.length) return finish(database.db, job, null);
    if (link.state !== "active" || link.number === null) return finish(database.db, job, "paused");
    const sent = await settle(
      await call(
        senders,
        driver.comment(
          connection,
          token,
          { kind: "issue", number: link.number },
          `${quiet(comment.comment.body)}\n\n— ${quiet(comment.author ?? "Someone")} in Kanvil\n\n<!-- kanvil:comment:${comment.comment.id} -->`,
        ),
      ),
    );
    if (!sent.ok)
      // A comment the host may have taken is not sent again; its webhook records it by the marker.
      return sent.error.retry && unsent(sent.error)
        ? retry(database, job, sent.error.code)
        : finish(database.db, job, sent.error.code);
    const answer = z
      .object({ id: z.union([z.number(), z.string()]) })
      .safeParse(safeJson(sent.body));
    if (answer.success)
      await database.db
        .insert(syncedComments)
        .values({
          linkId: link.id,
          commentId: comment.comment.id,
          remoteId: String(answer.data.id),
        })
        .onConflictDoNothing();
    return finish(database.db, job, answer.success ? null : "unverified");
  }

  if (link.state === "creating") {
    const content = localContent(ticket);
    const sent = await settle(
      await call(
        senders,
        driver.createIssue(connection, token, {
          title: content.title,
          description: issueBody(ticket.id, content.description),
        }),
      ),
    );
    if (!sent.ok) {
      if (unsent(sent.error)) {
        if (sent.error.retry && job.attempts < 4) return retry(database, job, sent.error.code);
        // Refused outright: no issue exists, and creating it again is the administrator's call.
        return locked(database, async (db) => {
          await finish(db, job, sent.error.code);
          const current = await fresh(db, link.id);
          if (current?.state === "creating")
            await setLink(db, projectId, current, { state: "paused", reason: sent.error.code });
        });
      }
      // The host may have created the issue: never create it blindly again.
      return locked(database, async (db) => {
        await finish(db, job, sent.error.code);
        const current = await fresh(db, link.id);
        if (current?.state === "creating")
          await setLink(db, projectId, current, { state: "unknown", reason: sent.error.code });
      });
    }
    const issue = readIssue(driver, sent.body);
    return locked(database, async (db) => {
      await finish(db, job, issue ? null : "unverified");
      const current = await fresh(db, link.id);
      // The issue's webhook may have confirmed it first.
      if (current?.state !== "creating") return;
      if (!issue) {
        await setLink(db, projectId, current, { state: "unknown", reason: "unverified" });
        return;
      }
      const base = { ...content, open: true };
      const saved = await setLink(db, projectId, current, {
        ...reported(issue, remoteContent(issue).content),
        number: issue.number,
        base,
        state: "active",
        reason: null,
        syncedFrom: new Date(),
      });
      const now = one(await db.select().from(tickets).where(eq(tickets.id, ticket.id)));
      if (differs(localContent(now), base).length) await queueSync(db, [saved]);
    });
  }

  if (link.state !== "active" || link.number === null || !link.base)
    return finish(database.db, job, link.state === "active" ? null : "paused");
  const local = localContent(ticket),
    changed = differs(local, link.base);
  if (!changed.length) return finish(database.db, job, null);
  const sent = await settle(
    await call(
      senders,
      driver.updateIssue(connection, token, link.number, {
        ...(changed.includes("title") && { title: local.title }),
        ...(changed.includes("description") && {
          description: issueBody(ticket.id, local.description),
        }),
        ...(changed.includes("open") && { open: local.open }),
      }),
    ),
  );
  if (!sent.ok) {
    // An update sets whole values, so repeating it is safe. A missing issue pauses the link.
    if (sent.error.code === "http_404" || sent.error.code === "http_410")
      return locked(database, async (db) => {
        await finish(db, job, sent.error.code);
        const current = await fresh(db, link.id);
        if (current?.state === "active")
          await setLink(db, projectId, current, { state: "paused", reason: sent.error.code });
      });
    if (sent.error.retry && job.attempts < 4) return retry(database, job, sent.error.code);
    // Out of retries, or refused: the edit would otherwise wait unsent for the next ticket change.
    return locked(database, async (db) => {
      await finish(db, job, sent.error.code);
      const current = await fresh(db, link.id);
      if (current?.state === "active")
        await setLink(db, projectId, current, { state: "review", reason: sent.error.code });
    });
  }
  const issue = readIssue(driver, sent.body);
  return locked(database, async (db) => {
    await finish(db, job, issue ? null : "unverified");
    const current = await fresh(db, link.id);
    if (!current) return;
    const content = issue && remoteContent(issue).content;
    const newer = !!issue && !stale(current, issue);
    if (current.state !== "active" || !current.base) {
      if (issue && newer) await setLink(db, projectId, current, reported(issue, content));
      return;
    }
    // The host's answer must show what was sent; anything else stops the link for review.
    if (!content || changed.some((field) => !same(field, content, local))) {
      await setLink(db, projectId, current, {
        ...(issue && newer && reported(issue, content)),
        state: "review",
        reason: "unverified",
      });
      return;
    }
    const base = { ...current.base };
    for (const field of changed) copy(base, field, local);
    const saved = await setLink(db, projectId, current, {
      ...(newer && reported(issue, content)),
      base,
    });
    // A Kanvil edit made while this request was out goes in the next sync.
    const now = one(await db.select().from(tickets).where(eq(tickets.id, ticket.id)));
    if (differs(localContent(now), base).length) await queueSync(db, [saved]);
  });
}
const safeJson = (body: string): unknown => {
  try {
    return JSON.parse(body);
  } catch {
    return null;
  }
};
function readIssue(driver: RepositoryDrivers[keyof RepositoryDrivers], body: string) {
  try {
    return driver.issue(body);
  } catch {
    return null;
  }
}

// ---- Operations ----

const presentLink = (link: Link, ticket: Pick<Ticket, "key" | "title">) => ({
  id: link.id,
  connectionId: link.connectionId,
  ticketId: link.ticketId,
  ticketKey: ticket.key,
  ticketTitle: ticket.title,
  origin: link.origin,
  state: link.state,
  reason: link.reason,
  number: link.number,
  url: link.url,
  version: link.version,
  updatedAt: link.updatedAt,
});
// Link counts by state for each connection.
export async function linkCounts(db: Db, connectionIds: string[]) {
  const counts = new Map<string, Record<string, number>>();
  if (!connectionIds.length) return counts;
  const rows = await db
    .select({
      connectionId: issueLinks.connectionId,
      state: issueLinks.state,
      total: sql<number>`count(*)::int`,
    })
    .from(issueLinks)
    .where(inArray(issueLinks.connectionId, connectionIds))
    .groupBy(issueLinks.connectionId, issueLinks.state);
  for (const row of rows)
    counts.set(row.connectionId, { ...counts.get(row.connectionId), [row.state]: row.total });
  return counts;
}
type Rules = { inbound: SyncRule; outbound: SyncRule };
const ids = (items: { id: string }[]) => items.map((item) => item.id).toSorted();
// What applying `rules` would change, with a fingerprint of exactly those sets.
async function plan(ctx: Context, connection: Connection, { inbound, outbound }: Rules) {
  const rules = { inbound, outbound };
  const names = await labelNames(ctx.db, project(ctx).workspaceId, [inbound, outbound]);
  // A rule that is off may keep labels that were deleted since; turning it off must still work.
  for (const [side, rule] of Object.entries(rules))
    if (rule.enabled)
      rule.labels.forEach((id, index) => {
        if (!names.has(id))
          fail(400, "validation_error", "Choose labels of this workspace", [
            { path: `${side}.labels.${index}`, message: "Choose labels of this workspace" },
          ]);
      });
  const rows = await ctx.db
    .select({ link: issueLinks, ticket: tickets })
    .from(issueLinks)
    .innerJoin(tickets, eq(tickets.id, issueLinks.ticketId))
    .where(eq(issueLinks.connectionId, connection.id));
  const matching: Link[] = [],
    pause: Link[] = [],
    review: Link[] = [];
  for (const { link, ticket } of rows) {
    if (ticket.projectId !== connection.projectId) continue;
    const qualified = qualifies(rules, names, link, ticket);
    if (link.state === "active") (qualified ? matching : pause).push(link);
    else if (link.state === "paused" && link.reason === "labels" && qualified) review.push(link);
  }
  const exported = rules.outbound.enabled
    ? (
        await ctx.db
          .select()
          .from(tickets)
          .where(
            and(
              eq(tickets.projectId, connection.projectId),
              eq(tickets.archived, false),
              notInArray(tickets.status, [...closedStates]),
              notInArray(
                tickets.id,
                ctx.db
                  .select({ id: issueLinks.ticketId })
                  .from(issueLinks)
                  .where(eq(issueLinks.connectionId, connection.id)),
              ),
            ),
          )
      ).filter((ticket) => matches(rules.outbound, names, ticket.labels))
    : [];
  const fingerprint = createHash("sha256")
    .update(
      JSON.stringify([
        connection.version,
        rules,
        ids(matching),
        ids(pause),
        ids(review),
        ids(exported),
      ]),
    )
    .digest("hex");
  return { matching, pause, review, exported, fingerprint };
}
async function ownLink(ctx: Context, linkId: string) {
  return one(
    await ctx.db
      .select({ link: issueLinks, ticket: tickets, connection: repositoryConnections })
      .from(issueLinks)
      .innerJoin(tickets, eq(tickets.id, issueLinks.ticketId))
      .innerJoin(repositoryConnections, eq(repositoryConnections.id, issueLinks.connectionId))
      .where(
        and(
          eq(issueLinks.id, linkId),
          eq(repositoryConnections.projectId, project(ctx).id),
          eq(tickets.projectId, project(ctx).id),
        ),
      ),
  );
}

export const issueSyncHandlers: Pick<
  Handlers,
  | "preview_repository_sync"
  | "apply_repository_sync"
  | "list_issue_links"
  | "compare_issue_link"
  | "reconcile_issue_link"
> = {
  async preview_repository_sync(ctx, input) {
    const connection = await ownConnection(ctx, input.connectionId);
    const result = await plan(ctx, connection, input);
    return {
      matching: result.matching.length,
      export: result.exported.length,
      pause: result.pause.length,
      review: result.review.length,
      fingerprint: result.fingerprint,
    };
  },
  async apply_repository_sync(ctx, input) {
    const connection = await ownConnection(ctx, input.connectionId, input.expectedVersion);
    const result = await plan(ctx, connection, input);
    if (result.fingerprint !== input.fingerprint)
      fail(409, "version_conflict", "What these rules change is different now; preview again", {
        currentVersion: connection.version,
      });
    const row = one(
      await ctx.db
        .update(repositoryConnections)
        .set({
          inbound: input.inbound,
          outbound: input.outbound,
          version: connection.version + 1,
          updatedAt: new Date(),
        })
        .where(eq(repositoryConnections.id, connection.id))
        .returning(),
    );
    await setLinks(ctx.db, row.projectId, result.pause, { state: "paused", reason: "labels" });
    await setLinks(ctx.db, row.projectId, result.review, { state: "review", reason: "labels" });
    for (let at = 0; at < result.exported.length; at += 1000) {
      const created = await ctx.db
        .insert(issueLinks)
        .values(
          result.exported.slice(at, at + 1000).map((ticket) => ({
            connectionId: row.id,
            ticketId: ticket.id,
            origin: "outbound",
            state: "creating",
          })),
        )
        .onConflictDoNothing()
        .returning();
      await queueSync(ctx.db, created);
    }
    await publish(ctx, "repository.updated", null, connectionEvent(row));
    return presentOne(ctx, row);
  },
  async list_issue_links(ctx, input) {
    const connection = await ownConnection(ctx, input.connectionId);
    const rows = await ctx.db
      .select({ link: issueLinks, ticket: { key: tickets.key, title: tickets.title } })
      .from(issueLinks)
      .innerJoin(tickets, eq(tickets.id, issueLinks.ticketId))
      .where(
        and(
          eq(issueLinks.connectionId, connection.id),
          eq(tickets.projectId, connection.projectId),
        ),
      )
      .orderBy(tickets.number);
    return rows.map(({ link, ticket }) => presentLink(link, ticket));
  },
  async compare_issue_link(ctx, input) {
    const { link, ticket } = await ownLink(ctx, input.linkId);
    return {
      link: presentLink(link, ticket),
      ticketVersion: ticket.version,
      local: localContent(ticket),
      remote: link.remote && stored(link.remote),
      base: link.base,
    };
  },
  async reconcile_issue_link(ctx, input) {
    const { link, ticket, connection } = await ownLink(ctx, input.linkId);
    assertVersion(link, input.expectedVersion, "issue link", "reconciling it");
    assertVersion(ticket, input.ticketVersion, "ticket", "reconciling it");
    const projectId = connection.projectId;
    if (input.resolution === "unlink") {
      await ctx.db.delete(issueLinks).where(eq(issueLinks.id, link.id));
      await publish(ctx, "issue_link.updated", null, {
        connectionId: connection.id,
        linkId: link.id,
        ticketId: link.ticketId,
        state: "unlinked",
      });
      return { ok: true };
    }
    if (link.state === "creating")
      fail(409, "issue_creation_pending", "The host has not answered this issue's creation yet");
    const names = await labelNames(ctx.db, project(ctx).workspaceId, [
      connection.inbound,
      connection.outbound,
    ]);
    if (ticket.projectId !== projectId || !qualifies(connection, names, link, ticket))
      fail(
        409,
        "sync_not_qualified",
        "The sync rules no longer cover this link; change its labels or the rules, or unlink it",
      );
    if (input.resolution === "kanvil") {
      // Starting from the issue as reported, every Kanvil difference is written to it. Without a
      // confirmed issue, this is the administrator's explicit decision to create it again.
      const saved =
        link.number === null
          ? await setLink(ctx.db, projectId, link, { state: "creating", reason: null })
          : await setLink(ctx.db, projectId, link, {
              state: "active",
              reason: null,
              base: link.remote ? stored(link.remote) : link.base,
              syncedFrom: new Date(),
            });
      await queueSync(ctx.db, [saved]);
      return { ok: true };
    }
    if (!link.remote || link.number === null)
      fail(409, "remote_unknown", "The host has not reported this issue yet");
    const remote = stored(link.remote),
      changed = differs(localContent(ticket), remote);
    if (changed.length) {
      const write = issueUpdate(
        ticket,
        Object.fromEntries(changed.map((field) => [field, remote[field]])),
      );
      if (!write.success)
        fail(
          400,
          "validation_error",
          "The issue's title or description is longer than a ticket allows; keep Kanvil or unlink",
        );
      const { event } = await updateTicketRow(ctx, write.data);
      await publish(ctx, event.type, event.ticketId, event.data);
    }
    await setLink(ctx.db, projectId, link, {
      state: "active",
      reason: null,
      base: remote,
      syncedFrom: new Date(),
    });
    return { ok: true };
  },
};
