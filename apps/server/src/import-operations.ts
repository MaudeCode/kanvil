// Ticket export and the import-run engine. An export is a `kanvil.tickets` bundle; an import
// previews a bundle into a staged run with one record per source item, then the background job
// writes each record through `domain.execute` as the person who started it. A record's request ID
// derives from the run and its place, so the mutation receipt answers a retry after a restart and
// nothing is written twice. Every write carries the run as provenance, so it notifies no one and
// reaches no destination. Linear and Jira are read into the same bundle (adapters/import-sources.ts).
import { createHash } from "node:crypto";
import {
  and,
  asc,
  count,
  desc,
  eq,
  inArray,
  isNotNull,
  lt,
  ne,
  sql,
  type AnyColumn,
} from "drizzle-orm";
import { z } from "zod";
import {
  ApiError,
  customFieldValue,
  customFieldValueSchema,
  defaultWorkflow,
  stagedUploadLifetime,
  ticketExportFormat,
  ticketImportSchema,
  type ImportRun,
  type Operation,
  type ParsedInput,
  type TicketExport,
} from "@kanvil/contracts";
import { user } from "./auth-schema.ts";
import {
  attachments,
  claims,
  comments,
  events,
  evidence,
  importRecords,
  importRuns,
  projectLabels,
  projects,
  relations,
  resources,
  subscriptions,
  tickets,
  workspaceLabels,
  workspaceMembers,
} from "./schema.ts";
import {
  assertVersion,
  fail,
  insertAll,
  one,
  project,
  projectMatch,
  workspace,
  type Actor,
  type Context,
  type Domain,
  type Handlers,
} from "./domain.ts";
import { projectRoleSQL } from "./project-access.ts";
import { projectStates } from "./workflow-operations.ts";
import { projectCustomFields } from "./custom-field-operations.ts";

type Issue = ImportRun["issues"][number];
type Run = typeof importRuns.$inferSelect;

async function exportBundle(ctx: Context) {
  const current = project(ctx);
  // Comments and files follow their ticket, so they are selected through it.
  const inProject = (column: AnyColumn) =>
    inArray(
      column,
      ctx.db.select({ id: tickets.id }).from(tickets).where(eq(tickets.projectId, current.id)),
    );
  const rows = await ctx.db
    .select()
    .from(tickets)
    .where(eq(tickets.projectId, current.id))
    .orderBy(asc(tickets.number));
  const used = new Set(rows.flatMap((row) => row.labels));
  const labels = [
    ...(await ctx.db
      .select({ name: projectLabels.name, color: projectLabels.color })
      .from(projectLabels)
      .where(eq(projectLabels.projectId, current.id))),
    ...(
      await ctx.db
        .select({ name: workspaceLabels.name, color: workspaceLabels.color })
        .from(workspaceLabels)
        .where(eq(workspaceLabels.workspaceId, current.workspaceId))
    ).filter((label) => used.has(label.name)),
  ];
  const links = await ctx.db
    .select()
    .from(relations)
    .where(inProject(relations.sourceId))
    .orderBy(asc(relations.id));
  const notes = await ctx.db
    .select()
    .from(comments)
    .where(inProject(comments.ticketId))
    .orderBy(asc(comments.createdAt), asc(comments.id));
  const reports = await ctx.db
    .select()
    .from(evidence)
    .where(inProject(evidence.ticketId))
    .orderBy(asc(evidence.createdAt), asc(evidence.id));
  const sites = await ctx.db
    .select()
    .from(resources)
    .where(inProject(resources.ticketId))
    .orderBy(asc(resources.createdAt), asc(resources.id));
  const people = [
    ...new Set(
      [
        ...rows.flatMap((row) => [row.assigneeId, row.createdBy]),
        ...notes.map((row) => row.actorId),
        ...reports.map((row) => row.actorId),
      ].filter((id): id is string => !!id),
    ),
  ];
  const tally = async (column: AnyColumn) =>
    one(await ctx.db.select({ count: count() }).from(column.table).where(inProject(column))).count;
  const omitted = [
    {
      content: "attachments",
      count: await tally(attachments.ticketId),
      reason: "Files stay in the source project; text that embeds them keeps their old addresses.",
    },
    {
      content: "activity",
      count: one(
        await ctx.db
          .select({ count: count() })
          .from(events)
          .where(eq(events.projectId, current.id)),
      ).count,
      reason: "Activity history stays with the source project; an import never replays it.",
    },
    {
      content: "claims",
      count: await tally(claims.ticketId),
      reason: "Agent ownership is live state; imported tickets start unclaimed.",
    },
    {
      content: "follows",
      count: await tally(subscriptions.ticketId),
      reason: "Follows are personal; the importer and assignees follow imported tickets.",
    },
  ].filter((item) => item.count > 0);
  return {
    format: ticketExportFormat,
    version: 1,
    exportedAt: new Date(),
    project: {
      ref: current.id,
      key: current.key,
      name: current.name,
      description: current.description,
    },
    completeness: {
      omitted: [
        ...omitted,
        {
          content: "project settings",
          count: null,
          reason:
            "Access, saved views, calendar feeds, destinations, the public link, icon, and background stay with the source project.",
        },
      ],
    },
    members: await exportedPeople(ctx, people),
    workflow: (await projectStates(ctx)).map((state) => ({
      ref: state.id,
      name: state.name,
      category: state.category,
      color: state.color,
    })),
    customFields: (await projectCustomFields(ctx)).map(
      ({ id, projectId: _projectId, version: _version, ...field }) => ({
        ...field,
        ref: id,
      }),
    ),
    labels,
    tickets: rows.map((row) => ({
      ref: row.id,
      key: row.key,
      title: row.title,
      description: row.description,
      acceptanceCriteria: row.acceptanceCriteria,
      priority: row.priority,
      kind: row.kind,
      difficulty: row.difficulty,
      labels: row.labels,
      scopes: row.scopes,
      automationReady: row.automationReady,
      holdReason: row.holdReason,
      startAt: row.startAt,
      dueAt: row.dueAt,
      archived: row.archived,
      stateRef: row.stateId,
      assigneeRef: row.assigneeId,
      parentRef: row.parentId,
      customFields: row.customFields,
      createdByRef: row.createdBy,
      createdAt: row.createdAt,
    })),
    relations: links.map((row) => ({
      sourceRef: row.sourceId,
      targetRef: row.targetId,
      type: row.type,
    })),
    comments: notes.map((row) => ({
      ref: row.id,
      ticketRef: row.ticketId,
      authorRef: row.actorId,
      body: row.body,
      createdAt: row.createdAt,
    })),
    evidence: reports.map((row) => ({
      ref: row.id,
      ticketRef: row.ticketId,
      authorRef: row.actorId,
      kind: row.kind,
      title: row.title,
      url: row.url,
      commit: row.commit,
      outcome: row.outcome,
      note: row.note,
      createdAt: row.createdAt,
    })),
    resources: sites.map((row) => ({
      ref: row.id,
      ticketRef: row.ticketId,
      url: row.url,
      title: row.title,
      createdAt: row.createdAt,
    })),
  };
}

// The people records name. Like the member list, only current members show their name and
// email; anyone else reads as a former member.
async function exportedPeople(ctx: Context, ids: string[]) {
  const current = ids.length
    ? await ctx.db
        .select({ ref: user.id, name: user.name, email: user.email })
        .from(user)
        .where(and(inArray(user.id, ids), isNotNull(projectRoleSQL(user.id, project(ctx).id))))
        .orderBy(asc(user.name))
    : [];
  return [
    ...current,
    ...ids
      .filter((id) => !current.some((person) => person.ref === id))
      .map((ref) => ({ ref, name: "Former member", email: "" })),
  ];
}
const list = (items: string[], limit = 5) =>
  items.length > limit
    ? `${items.slice(0, limit).join(", ")} and ${items.length - limit} more`
    : items.join(", ");
// Values that occur more than once, in linear time for large bundles.
function repeated(values: string[]) {
  const seen = new Set<string>(),
    again = new Set<string>();
  for (const value of values) (seen.has(value) ? again : seen).add(value);
  return [...again];
}
// Collects findings by subject and reports each once with the records it names.
function findings() {
  const found = new Map<string, Issue & { items: string[] }>();
  return {
    add(severity: Issue["severity"], code: string, subject: string, item?: string) {
      const entry = found.get(subject) ?? { severity, code, message: subject, items: [] };
      if (item !== undefined) entry.items.push(item);
      found.set(subject, entry);
    },
    issues: (): Issue[] =>
      [...found.values()]
        .map(({ items, ...issue }) => ({
          ...issue,
          message: items.length ? `${issue.message}: ${list(items)}` : issue.message,
        }))
        .toSorted((a, b) => (a.severity === b.severity ? 0 : a.severity === "error" ? -1 : 1)),
  };
}
// Comments and evidence are written as the importer and keep their source attribution in text.
const attribution = (author: string | undefined, at: string) =>
  `Originally by ${author ?? "an unknown author"} on ${at.slice(0, 10)}.\n\n`;

// Whether a field fills new tickets itself; an empty default is none, as on the server.
const defaulted = (field: TicketExport["customFields"][number]) =>
  (customFieldValueSchema(field).safeParse(field.defaultValue).data ?? null) !== null;
// The default state a source state of the same name lands on.
const defaults = (state: { name: string }) =>
  defaultWorkflow.find((item) => item.name.toLowerCase() === state.name.toLowerCase());
// Checks a bundle against the workspace without writing tickets, and stages it as a run.
async function previewImport(ctx: Context, input: ParsedInput<"preview_import">) {
  const space = workspace(ctx),
    bundle = input.bundle,
    found = findings();
  const error = (code: string, subject: string, item?: string) =>
      found.add("error", code, subject, item),
    warn = (code: string, subject: string, item?: string) =>
      found.add("warning", code, subject, item);
  if (
    (await ctx.db.select({ id: projects.id }).from(projects).where(projectMatch(input.key))).length
  )
    error("duplicate_prefix", `${input.key} is in use or reserved by another project`);
  const refLists: [string, { ref: string }[]][] = [
    ["workflow states", bundle.workflow],
    ["custom fields", bundle.customFields],
    ["tickets", bundle.tickets],
    ["people", bundle.members],
    ["comments", bundle.comments],
    ["evidence", bundle.evidence],
    ["links", bundle.resources],
  ];
  for (const [subject, items] of refLists)
    for (const ref of repeated(items.map((item) => item.ref)))
      error("duplicate_ref", `References repeat among ${subject}`, ref);

  // Workflow: states that match a default by category and name take it; the rest are added.
  for (const name of repeated(bundle.workflow.map((state) => state.name.toLowerCase())))
    error("duplicate_state", "Workflow state names repeat", name);
  for (const state of bundle.workflow) {
    const taken = defaults(state);
    if (taken && taken.category !== state.category)
      error(
        "duplicate_state",
        "Workflow states reuse a default state's name under another category",
        state.name,
      );
  }
  const added = bundle.workflow.filter((state) => !defaults(state)).length;
  if (added + defaultWorkflow.length > 50)
    error(
      "validation_error",
      `The workflow needs ${added + defaultWorkflow.length} states; a project holds 50`,
    );
  const states = new Map(bundle.workflow.map((state) => [state.ref, state]));

  // Custom fields keep their option IDs, so select values carry over unchanged.
  for (const name of repeated(bundle.customFields.map((field) => field.name.toLowerCase())))
    error("duplicate_field", "Custom field names repeat", name);
  for (const field of bundle.customFields) {
    const choice = field.type === "select" || field.type === "multiselect";
    if (field.options.length && !choice)
      error("validation_error", "Only select fields have options", field.name);
    if (field.required && field.type === "checkbox")
      error("validation_error", "A checkbox cannot be required", field.name);
    if (
      repeated(field.options.map((option) => option.id)).length ||
      repeated(field.options.map((option) => option.name.toLowerCase())).length
    )
      error("validation_error", "Option IDs and names must be unique", field.name);
    if (!customFieldValueSchema(field).safeParse(field.defaultValue).success)
      error("validation_error", "Defaults that do not fit their field", field.name);
  }
  const fields = new Map(bundle.customFields.map((field) => [field.ref, field]));

  // People: an assignee keeps their tickets when an account with their email can open the project.
  const accounts = await ctx.db
    .select({ id: user.id, email: user.email, role: workspaceMembers.role })
    .from(workspaceMembers)
    .innerJoin(user, eq(user.id, workspaceMembers.userId))
    .where(eq(workspaceMembers.workspaceId, space.id));
  const reachable = accounts.filter(
    (account) =>
      input.visibility === "workspace" || account.role === "admin" || account.id === ctx.actor.id,
  );
  const me = one(
    await ctx.db
      .select({ id: user.id, email: user.email })
      .from(user)
      .where(eq(user.id, ctx.actor.id)),
  );
  const members = bundle.members.map((person) => ({
    ...person,
    userId:
      (person.email &&
        [me, ...reachable].find(
          (account) => account.email.toLowerCase() === person.email.toLowerCase(),
        )?.id) ||
      null,
  }));
  const assignee = new Map(members.map((person) => [person.ref, person.userId]));
  const authors = new Map(bundle.members.map((person) => [person.ref, person.name]));
  const attributed = (
    item: { authorRef: string | null; createdAt: string; ticketRef: string },
    text: string,
    limit: number,
  ) => {
    const full =
      attribution(item.authorRef ? authors.get(item.authorRef) : undefined, item.createdAt) + text;
    if (full.length > limit)
      warn(
        "truncated",
        "Long comments or evidence notes lose their end to the attribution line",
        item.ticketRef,
      );
    return full.slice(0, limit);
  };

  // Tickets: references, field values, and a parent order with no cycle.
  const byRef = new Map(bundle.tickets.map((ticket) => [ticket.ref, ticket]));
  for (const ticket of bundle.tickets) {
    if (!states.has(ticket.stateRef))
      error(
        "unknown_state",
        "Tickets name a workflow state the import does not define",
        ticket.key,
      );
    if (ticket.assigneeRef && !assignee.get(ticket.assigneeRef))
      warn("unassigned", "Tickets lose an assignee who cannot open the new project", ticket.key);
    if (ticket.parentRef && !byRef.has(ticket.parentRef))
      warn("missing_parent", "Tickets lose a parent the import does not include", ticket.key);
    // Values are judged as normalized: an empty text or choice list is no value.
    const filled = new Set<string>();
    for (const [ref, value] of Object.entries(ticket.customFields)) {
      const field = fields.get(ref),
        parsed = field && customFieldValueSchema(field).safeParse(value);
      if (!field)
        error(
          "unknown_field",
          "Tickets hold values of a field the import does not define",
          ticket.key,
        );
      else if (!parsed?.success)
        error("invalid_field_value", `Values that do not fit ${field.name}`, ticket.key);
      else if (parsed.data !== null) filled.add(ref);
    }
    for (const field of bundle.customFields)
      if (field.required && !defaulted(field) && !filled.has(field.ref))
        error(
          "missing_required_field",
          `Tickets without a value for required ${field.name}`,
          ticket.key,
        );
  }
  const keyOf = (ref: string) => byRef.get(ref)?.key ?? ref;
  const links = new Map<string, TicketExport["relations"][number]>();
  for (const relation of bundle.relations) {
    if (!byRef.has(relation.sourceRef) || !byRef.has(relation.targetRef)) {
      warn(
        "missing_relation",
        "Relationships to tickets outside the import are left out",
        keyOf(relation.sourceRef),
      );
      continue;
    }
    if (relation.sourceRef === relation.targetRef) continue;
    const [sourceRef, targetRef] =
      relation.type === "related"
        ? [relation.sourceRef, relation.targetRef].toSorted()
        : [relation.sourceRef, relation.targetRef];
    if (sourceRef && targetRef)
      links.set(`${sourceRef} ${relation.type} ${targetRef}`, {
        sourceRef,
        targetRef,
        type: relation.type,
      });
  }
  // Parents and blockers form one dependency graph, as `assertNoCycle` checks it.
  // Iterative, so long chains cannot exhaust the stack: tickets left with an incoming edge after
  // peeling every edge-free one lie on a cycle or after one.
  const edges = new Map<string, string[]>(),
    incoming = new Map(bundle.tickets.map((ticket) => [ticket.ref, 0]));
  const connect = (from: string, to: string) => {
    const targets = edges.get(from) ?? [];
    targets.push(to);
    edges.set(from, targets);
    incoming.set(to, (incoming.get(to) ?? 0) + 1);
  };
  for (const ticket of bundle.tickets)
    if (ticket.parentRef && byRef.has(ticket.parentRef)) connect(ticket.ref, ticket.parentRef);
  for (const link of links.values())
    if (link.type === "blocks") connect(link.sourceRef, link.targetRef);
  const free = [...incoming].flatMap(([ref, waiting]) => (waiting ? [] : [ref]));
  for (let at = 0; at < free.length; at++)
    for (const to of edges.get(free[at] ?? "") ?? []) {
      const left = (incoming.get(to) ?? 0) - 1;
      incoming.set(to, left);
      if (!left) free.push(to);
    }
  for (const ticket of bundle.tickets)
    if (incoming.get(ticket.ref))
      error("dependency_cycle", "Parents or blockers form a cycle among", ticket.key);
  // Parents are written before their children.
  const ordered: TicketExport["tickets"] = [],
    placed = new Set<string>();
  for (const ticket of bundle.tickets) {
    const chain: TicketExport["tickets"] = [];
    for (
      let at: TicketExport["tickets"][number] | undefined = ticket;
      at && !placed.has(at.ref);
      at = at.parentRef ? byRef.get(at.parentRef) : undefined
    ) {
      placed.add(at.ref);
      chain.push(at);
    }
    ordered.push(...chain.toReversed());
  }

  // Labels the workspace already shares keep its color; the rest become project labels.
  const shared = new Set(
    (
      await ctx.db
        .select({ name: workspaceLabels.name })
        .from(workspaceLabels)
        .where(eq(workspaceLabels.workspaceId, space.id))
    ).map((label) => label.name),
  );
  const labels = [...new Map(bundle.labels.map((label) => [label.name, label])).values()];
  for (const label of labels)
    if (shared.has(label.name))
      warn("shared_label", "Labels the workspace already shares", label.name);
  const attached = <T extends { ticketRef: string }>(items: T[], subject: string) =>
    items.filter((item) => {
      if (byRef.has(item.ticketRef)) return true;
      warn(
        "missing_ticket",
        `${subject} on tickets outside the import are left out`,
        item.ticketRef,
      );
      return false;
    });
  const notes = attached(bundle.comments, "Comments"),
    reports = attached(bundle.evidence, "Evidence"),
    sites = attached(bundle.resources, "Links");
  if (ordered.length)
    warn(
      "new_keys",
      `Tickets get new ${input.key} keys, and you become their creator as of the import`,
    );
  if (notes.length || reports.length)
    warn(
      "authorship",
      "Comments and evidence are written as you and begin with their original author and date",
    );
  for (const item of bundle.completeness.omitted)
    warn(
      "omitted",
      `Not imported: ${item.content}${item.count === null ? "" : ` (${item.count})`}. ${item.reason}`,
    );

  const records = [
    {
      kind: "project",
      ref: bundle.project.ref,
      label: input.key,
      payload: {
        key: input.key,
        name: input.name,
        description: bundle.project.description,
        visibility: input.visibility,
      },
    },
    ...bundle.workflow.map(({ ref, ...state }) => ({
      kind: "state",
      ref,
      label: state.name,
      payload: state,
    })),
    ...bundle.customFields.map(({ ref, ...field }) => ({
      kind: "field",
      ref,
      label: field.name,
      payload: field,
    })),
    ...labels
      .filter((label) => !shared.has(label.name))
      .map((label) => ({ kind: "label", ref: label.name, label: label.name, payload: label })),
    ...ordered.map(
      ({ ref, key, assigneeRef, createdByRef: _createdBy, createdAt: _createdAt, ...ticket }) => ({
        kind: "ticket",
        ref,
        label: key,
        payload: {
          ...ticket,
          parentRef: ticket.parentRef && byRef.has(ticket.parentRef) ? ticket.parentRef : null,
          assigneeId: assigneeRef ? (assignee.get(assigneeRef) ?? null) : null,
        },
      }),
    ),
    ...[...links].map(([ref, link]) => ({
      kind: "relation",
      ref,
      label: `${keyOf(link.sourceRef)} ${link.type} ${keyOf(link.targetRef)}`,
      payload: link,
    })),
    ...notes.map((note) => ({
      kind: "comment",
      ref: note.ref,
      label: keyOf(note.ticketRef),
      payload: {
        ticketRef: note.ticketRef,
        body: attributed(note, note.body, 50_000),
      },
    })),
    ...reports.map(({ ref, authorRef, createdAt, ...report }) => ({
      kind: "evidence",
      ref,
      label: keyOf(report.ticketRef),
      payload: {
        ...report,
        note: attributed(
          { authorRef, createdAt, ticketRef: report.ticketRef },
          report.note,
          20_000,
        ),
      },
    })),
    ...sites.map(({ ref, createdAt: _createdAt, ...site }) => ({
      kind: "resource",
      ref,
      label: keyOf(site.ticketRef),
      payload: site,
    })),
  ];
  const issues = found.issues();
  const run = one(
    await ctx.db
      .insert(importRuns)
      .values({
        workspaceId: space.id,
        actorId: ctx.actor.id,
        key: input.key,
        name: input.name,
        visibility: input.visibility,
        status: "previewed",
        counts: {
          tickets: ordered.length,
          workflow: bundle.workflow.length,
          fields: bundle.customFields.length,
          labels: labels.length,
          relations: links.size,
          comments: notes.length,
          evidence: reports.length,
          links: sites.length,
        },
        members,
        issues,
      })
      .returning(),
  );
  // A run with errors cannot start, so its records are never staged.
  if (issues.some((issue) => issue.severity === "error")) return toRun(ctx.db, run);
  await insertAll(
    records.map((record, seq) => ({ ...record, runId: run.id, seq })),
    (batch) => ctx.db.insert(importRecords).values(batch).returning({ seq: importRecords.seq }),
  );
  return toRun(ctx.db, run);
}

// A run with its progress and first failures, tallied from its records.
async function toRun(db: Context["db"], row: Run) {
  const tallies = await db
    .select({ status: importRecords.status, count: count() })
    .from(importRecords)
    .where(eq(importRecords.runId, row.id))
    .groupBy(importRecords.status);
  const failed = await db
    .select({ kind: importRecords.kind, label: importRecords.label, error: importRecords.error })
    .from(importRecords)
    .where(and(eq(importRecords.runId, row.id), eq(importRecords.status, "failed")))
    .orderBy(asc(importRecords.seq))
    .limit(100);
  const tally = (status: string) => tallies.find((item) => item.status === status)?.count ?? 0;
  return {
    ...row,
    progress: {
      total: tallies.reduce((sum, item) => sum + item.count, 0),
      done: tally("done"),
      failed: tally("failed"),
    },
    errors: failed.map(({ error, ...record }) => ({
      ...record,
      code: error?.code ?? "internal_error",
      message: error?.message ?? "The record could not be written",
    })),
  };
}
// Runs belong to the person who previewed them; anyone else's read as not found.
async function ownRun(ctx: Context, importId: string, expectedVersion?: number) {
  const row = one(
    await ctx.db
      .select()
      .from(importRuns)
      .where(
        and(
          eq(importRuns.id, importId),
          eq(importRuns.workspaceId, workspace(ctx).id),
          eq(importRuns.actorId, ctx.actor.id),
        ),
      ),
  );
  if (expectedVersion !== undefined) assertVersion(row, expectedVersion, "import", "changing it");
  return row;
}
async function setStatus(ctx: Context, run: Run, status: Run["status"]) {
  return one(
    await ctx.db
      .update(importRuns)
      .set({ status, version: run.version + 1, updatedAt: new Date() })
      .where(eq(importRuns.id, run.id))
      .returning(),
  );
}

export const importHandlers: Pick<
  Handlers,
  | "export_project"
  | "preview_import"
  | "list_import_source_projects"
  | "preview_source_import"
  | "list_imports"
  | "get_import"
  | "start_import"
  | "cancel_import"
> = {
  async export_project(ctx) {
    // One snapshot, so tickets and the records that point at them agree.
    return ctx.db.transaction((tx) => exportBundle({ ...ctx, db: tx }), {
      isolationLevel: "repeatable read",
      accessMode: "read only",
    });
  },
  preview_import: previewImport,
  async list_import_source_projects(ctx, input) {
    return ctx.sources.projects(input.source);
  },
  // Stages what `sourceReads` read before the write lock, like a file. The source and its
  // credentials never reach the run: it holds only the bundle's records.
  async preview_source_import(
    ctx,
    { source: _source, sourceProject: _project, includeComments: _comments, ...target },
  ) {
    const read = ticketImportSchema.safeParse(ctx.read);
    if (!read.success)
      fail(400, "validation_error", "The source holds content an import cannot take", {
        issues: read.error.issues.slice(0, 20).map(({ path, message }) => ({ path, message })),
      });
    return previewImport(ctx, { ...target, bundle: read.data });
  },
  async list_imports(ctx) {
    const rows = await ctx.db
      .select()
      .from(importRuns)
      .where(
        and(
          eq(importRuns.workspaceId, workspace(ctx).id),
          eq(importRuns.actorId, ctx.actor.id),
          ne(importRuns.status, "previewed"),
        ),
      )
      .orderBy(desc(importRuns.createdAt))
      .limit(20);
    return Promise.all(rows.map((row) => toRun(ctx.db, row)));
  },
  async get_import(ctx, input) {
    return toRun(ctx.db, await ownRun(ctx, input.importId));
  },
  async start_import(ctx, input) {
    const run = await ownRun(ctx, input.importId, input.expectedVersion);
    if (run.status !== "previewed")
      fail(409, "import_closed", "This import already started or ended");
    const blocking = run.issues.filter((issue) => issue.severity === "error");
    if (blocking.length)
      fail(409, "import_blocked", "Correct the file's errors and preview it again", {
        issues: blocking,
      });
    return toRun(ctx.db, await setStatus(ctx, run, "running"));
  },
  async cancel_import(ctx, input) {
    const run = await ownRun(ctx, input.importId, input.expectedVersion);
    if (run.status !== "previewed" && run.status !== "running")
      fail(409, "import_closed", "This import already ended");
    await ctx.db
      .update(importRecords)
      .set({ payload: null })
      .where(and(eq(importRecords.runId, run.id), eq(importRecords.status, "pending")));
    return toRun(ctx.db, await setStatus(ctx, run, "cancelled"));
  },
};

// Writes that read another tracker first. `read` runs outside the write lock with the request's
// credentials, so a slow source holds up no one; the handler then stages what it read under the
// lock, with the request's receipt. Receipts compare the request without its token.
export const sourceReads: {
  [K in Operation]?: {
    read: (ctx: Context, input: ParsedInput<K>) => Promise<unknown>;
    receipt: (input: ParsedInput<K>) => unknown;
  };
} = {
  preview_source_import: {
    read: (ctx, { source, sourceProject, includeComments }) =>
      ctx.sources.bundle(source, sourceProject, { includeComments }),
    receipt: ({ source: { token: _token, ...source }, ...input }) => ({ ...input, source }),
  },
};

// A stable request ID per record and attempt, so a retried write replays its receipt.
function requestId(runId: string, seq: number, attempt = "") {
  const hex = createHash("sha256").update(`${runId}:${seq}:${attempt}`).digest("hex");
  const variant = ((Number.parseInt(hex.charAt(16), 16) & 3) | 8).toString(16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}
const ticketPayload = z
  .object({
    stateRef: z.string(),
    parentRef: z.string().nullable(),
    customFields: z.record(z.string(), customFieldValue),
    // Set once the record falls back to no assignee; every retry then repeats that write.
    unassigned: z.boolean().default(false),
  })
  .loose();
const linkedPayload = z.object({ ticketRef: z.string() }).loose();
const relationPayload = z.object({
  sourceRef: z.string(),
  targetRef: z.string(),
  type: z.string(),
});
const statePayload = z.object({ name: z.string(), category: z.string() }).loose();
// Records written per pass; the job runs passes until the queue is empty or the server stops.
const passSize = 50;

// Writes the next records of the oldest running import. Returns whether work remains.
export async function processImports(domain: Domain) {
  const { db } = domain.database;
  await db
    .delete(importRuns)
    .where(
      and(
        eq(importRuns.status, "previewed"),
        lt(importRuns.createdAt, new Date(Date.now() - stagedUploadLifetime)),
      ),
    );
  const [run] = await db
    .select()
    .from(importRuns)
    .where(eq(importRuns.status, "running"))
    .orderBy(asc(importRuns.createdAt))
    .limit(1);
  if (!run) return false;
  const pending = await db
    .select()
    .from(importRecords)
    .where(and(eq(importRecords.runId, run.id), eq(importRecords.status, "pending")))
    .orderBy(asc(importRecords.seq))
    .limit(passSize);
  const finish = async (status: "completed" | "failed") => {
    await db
      .update(importRecords)
      .set({ payload: null })
      .where(and(eq(importRecords.runId, run.id), eq(importRecords.status, "pending")));
    await db
      .update(importRuns)
      .set({ status, version: sql`${importRuns.version} + 1`, updatedAt: new Date() })
      .where(and(eq(importRuns.id, run.id), eq(importRuns.status, "running")));
  };
  if (!pending.length) {
    await finish("completed");
    return true;
  }
  let projectId = run.projectId;
  const settle = (seq: number, outcome: Partial<typeof importRecords.$inferInsert>) =>
    db
      .update(importRecords)
      .set({ ...outcome, payload: null })
      .where(and(eq(importRecords.runId, run.id), eq(importRecords.seq, seq)));
  let actor: Actor;
  try {
    actor = await domain.actor(run.actorId);
  } catch (error) {
    if (!(error instanceof ApiError)) throw error;
    await settle(pending[0]?.seq ?? 0, {
      status: "failed",
      error: { code: error.code, message: error.message },
    });
    await finish("failed");
    return true;
  }
  const targets = async (kind: string, refs: string[]) =>
    new Map(
      refs.length
        ? (
            await db
              .select({ ref: importRecords.ref, targetId: importRecords.targetId })
              .from(importRecords)
              .where(
                and(
                  eq(importRecords.runId, run.id),
                  eq(importRecords.kind, kind),
                  eq(importRecords.status, "done"),
                  inArray(importRecords.ref, refs),
                ),
              )
          ).map((row) => [row.ref, row.targetId])
        : [],
    );
  const reachable = (id: string | null) =>
    id
      ? domain.execute("get_project", { projectId: id }, actor).then(
          () => true,
          (error: unknown) => {
            if (error instanceof ApiError) return false;
            throw error;
          },
        )
      : Promise.resolve(false);
  const ticketOf = async (ref: string) =>
    (await targets("ticket", [ref])).get(ref) ??
    fail(404, "not_found", "Its ticket was not imported");
  for (const record of pending) {
    // A cancellation stops the run at the next record.
    const [current] = await db
      .select({ status: importRuns.status })
      .from(importRuns)
      .where(eq(importRuns.id, run.id));
    if (current?.status !== "running") return true;
    const write = <K extends Operation>(name: K, input: Record<string, unknown>, attempt = "") =>
      domain.execute(
        name,
        {
          ...input,
          ...(projectId && { projectId }),
          requestId: requestId(run.id, record.seq, attempt),
        },
        actor,
        { importRun: run.id },
      );
    const payload = record.payload ?? {};
    const create = async (): Promise<string> => {
      switch (record.kind) {
        case "project": {
          const created = await write("create_project", {
            ...payload,
            workspaceId: run.workspaceId,
          });
          projectId = created.id;
          await db.update(importRuns).set({ projectId }).where(eq(importRuns.id, run.id));
          return created.id;
        }
        case "state": {
          const state = statePayload.parse(payload);
          // The new project's default states stand in for the source's states of the same name.
          const existing = (
            await domain.execute("list_workflow_states", { projectId }, actor)
          ).find(
            (item) =>
              item.category === state.category &&
              item.name.toLowerCase() === state.name.toLowerCase(),
          );
          return existing?.id ?? (await write("create_workflow_state", payload)).id;
        }
        case "field":
          return (await write("create_custom_field", payload)).id;
        case "label":
          return (await write("create_project_label", payload)).id;
        case "ticket": {
          const { stateRef, parentRef, customFields, unassigned, ...ticket } =
            ticketPayload.parse(payload);
          const fieldIds = await targets("field", Object.keys(customFields));
          const input = {
            ...ticket,
            stateId:
              (await targets("state", [stateRef])).get(stateRef) ??
              fail(404, "not_found", "Its workflow state was not imported"),
            parentId: parentRef
              ? ((await targets("ticket", [parentRef])).get(parentRef) ?? null)
              : null,
            customFields: Object.fromEntries(
              Object.entries(customFields).flatMap(([ref, value]) => {
                const id = fieldIds.get(ref);
                return id ? [[id, value]] : [];
              }),
            ),
          };
          const unassign = () =>
            write("create_ticket", { ...input, assigneeId: null }, "unassigned");
          if (unassigned) return (await unassign()).id;
          try {
            return (await write("create_ticket", input)).id;
          } catch (error) {
            // The assignee lost access since the preview; the ticket still arrives. The choice is
            // stored before the write, so a retry repeats the request that may have committed.
            if (!(error instanceof ApiError && error.code === "invalid_assignee")) throw error;
            await db
              .update(importRecords)
              .set({ payload: { ...payload, unassigned: true } })
              .where(and(eq(importRecords.runId, run.id), eq(importRecords.seq, record.seq)));
            return (await unassign()).id;
          }
        }
        case "relation": {
          const relation = relationPayload.parse(payload);
          return (
            await write("add_relation", {
              ticketId: await ticketOf(relation.sourceRef),
              targetId: await ticketOf(relation.targetRef),
              type: relation.type,
            })
          ).id;
        }
        case "comment":
        case "evidence":
        case "resource": {
          const { ticketRef, ...fields } = linkedPayload.parse(payload);
          const name =
            record.kind === "comment"
              ? "add_comment"
              : record.kind === "evidence"
                ? "add_evidence"
                : "add_resource";
          return (await write(name, { ...fields, ticketId: await ticketOf(ticketRef) })).id;
        }
        default:
          return fail(400, "validation_error", `Unknown import record ${record.kind}`);
      }
    };
    try {
      await settle(record.seq, { status: "done", targetId: await create() });
    } catch (error) {
      // Rejections are the record's own; anything else is retried on the next pass.
      const rejection =
        error instanceof ApiError
          ? { code: error.code, message: error.message }
          : error instanceof z.ZodError
            ? { code: "validation_error", message: error.issues[0]?.message ?? "Invalid record" }
            : undefined;
      if (!rejection) throw error;
      await settle(record.seq, { status: "failed", error: rejection });
      // Without its project, or once the importer can no longer write there, the run stops
      // instead of failing every remaining record.
      const stopped =
        record.kind === "project" ||
        ["forbidden", "project_archived"].includes(rejection.code) ||
        (rejection.code === "not_found" && !(await reachable(projectId)));
      if (stopped) {
        await finish("failed");
        return true;
      }
    }
  }
  return true;
}
