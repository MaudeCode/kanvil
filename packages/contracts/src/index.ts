import { z } from "zod";

export const states = ["backlog", "todo", "in_progress", "in_review", "done", "cancelled"] as const;
export const priorities = ["urgent", "high", "medium", "low", "none"] as const;
export const kinds = ["feature", "bug", "chore", "research", "documentation"] as const;
export const difficulties = ["low", "med", "high"] as const;
export const roles = ["reader", "writer", "admin"] as const;
export const scopes = ["read", "write", "claim", "admin"] as const;
export const stateLabels: Record<(typeof states)[number], string> = {
  backlog: "Backlog",
  todo: "To do",
  in_progress: "In progress",
  in_review: "In review",
  done: "Done",
  cancelled: "Cancelled",
};
export const priorityLabels: Record<(typeof priorities)[number], string> = {
  urgent: "Urgent",
  high: "High",
  medium: "Medium",
  low: "Low",
  none: "No priority",
};
export const stateTones: Record<(typeof states)[number], string> = {
  backlog: "muted",
  todo: "neutral",
  in_progress: "warning",
  in_review: "accent",
  done: "success",
  cancelled: "muted",
};

const id = z.string().min(1).max(80);
const timestamp = z.iso.datetime();
const version = z.number().int().positive();
const text = z.string().trim().min(1);
const tags = z
  .array(text.max(40))
  .max(30)
  .overwrite((values) => [...new Set(values)]);
const pagination = {
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).default(0),
};
const mutation = { requestId: z.uuid().optional() };
const projectInput = z.object({ projectId: id });
const ticketInput = projectInput.extend({ ticketId: id });
export const ticketFilter = z
  .object({
    q: z.string().trim().max(200).optional(),
    status: z.enum(states).optional(),
    priority: z.enum(priorities).optional(),
    kind: z.enum(kinds).optional(),
    difficulty: z.enum(difficulties).optional(),
    label: z.string().max(40).optional(),
    assigneeId: id.optional(),
    archived: z.enum(["include", "only", "exclude"]).default("exclude"),
    sort: z.enum(["priority", "updated", "created", "title"]).default("priority"),
  })
  .strict();
export const ticketFields = z
  .object({
    title: text.max(500),
    description: z.string().max(100_000),
    acceptanceCriteria: z.string().max(50_000),
    status: z.enum(states),
    priority: z.enum(priorities),
    kind: z.enum(kinds),
    difficulty: z.enum(difficulties).nullable(),
    labels: tags,
    scopes: tags,
    assigneeId: z.string().nullable(),
    parentId: z.uuid().nullable(),
    automationReady: z.boolean(),
    holdReason: z.string().trim().max(2000).nullable(),
    archived: z.boolean(),
  })
  .strict();
export const ticketChanges = ticketFields
  .partial()
  .refine((value) => Object.keys(value).length > 0, "Provide at least one change");
export const projectSchema = z.object({
  id: z.uuid(),
  key: z.string(),
  name: z.string(),
  description: z.string(),
  version,
  createdAt: timestamp,
  updatedAt: timestamp,
});
export const ticketSchema = ticketFields.extend({
  id: z.uuid(),
  projectId: z.uuid(),
  key: z.string(),
  number: z.number().int().positive(),
  version,
  createdBy: z.string(),
  createdAt: timestamp,
  updatedAt: timestamp,
});
export type Ticket = z.output<typeof ticketSchema>;
export type Project = z.output<typeof projectSchema>;
export const snapshotSchema = z.object({
  project: projectSchema,
  tickets: z.array(ticketSchema),
  cursor: z.string().regex(/^\d+$/),
});
export const readinessSchema = z.object({
  ready: z.boolean(),
  reasons: z.array(
    z.object({ code: z.string(), message: z.string(), ticketId: z.uuid().optional() }),
  ),
});
export const claimSchema = z.object({
  id: z.uuid(),
  projectId: z.uuid(),
  ticketId: z.uuid(),
  actorId: z.string(),
  workerId: z.string(),
  expiresAt: timestamp,
  createdAt: timestamp,
});
export const relationSchema = z.object({
  id: z.uuid(),
  projectId: z.uuid(),
  sourceId: z.uuid(),
  targetId: z.uuid(),
  type: z.enum(["blocks", "related", "duplicate"]),
});
export const commentSchema = z.object({
  id: z.uuid(),
  projectId: z.uuid(),
  ticketId: z.uuid(),
  actorId: z.string(),
  body: z.string(),
  version,
  createdAt: timestamp,
  updatedAt: timestamp,
});
export const attachmentSchema = z.object({
  id: z.uuid(),
  projectId: z.uuid(),
  ticketId: z.uuid(),
  actorId: z.string(),
  name: z.string(),
  contentType: z.string(),
  size: z.number().int().nonnegative(),
  createdAt: timestamp,
});
export const evidenceFields = z.object({
  kind: z.enum(["pull_request", "test", "review", "deployment", "device", "other"]),
  title: text.max(200),
  url: z.url().regex(/^https?:\/\//i, "Use an HTTP or HTTPS URL"),
  commit: z
    .string()
    .regex(/^[a-f0-9]{40,64}$/i)
    .nullable()
    .default(null),
  outcome: z.enum(["reported", "pending", "passed", "failed"]).default("reported"),
  note: z.string().max(20_000).default(""),
});
export const evidenceSchema = evidenceFields.extend({
  id: z.uuid(),
  projectId: z.uuid(),
  ticketId: z.uuid(),
  actorId: z.string(),
  createdAt: timestamp,
});
export const eventSchema = z.object({
  id: z.string().regex(/^\d+$/),
  projectId: z.uuid(),
  ticketId: z.uuid().nullable(),
  actorId: z.string(),
  type: z.string(),
  data: z.record(z.string(), z.unknown()),
  createdAt: timestamp,
});
export type ChangeEvent = z.output<typeof eventSchema>;
export const page = <T extends z.ZodType>(item: T) =>
  z.object({ items: z.array(item), total: z.number().int().nonnegative() });
const ok = z.object({ ok: z.literal(true) });
const op = <I extends z.ZodObject, O extends z.ZodType>(
  input: I,
  output: O,
  method: "GET" | "POST" | "PATCH" | "DELETE",
  path: string,
  scope: (typeof scopes)[number],
  description: string,
) => ({ input, output, method, path, scope, description });

export const operations = {
  list_projects: op(
    z.object({}),
    z.array(projectSchema),
    "GET",
    "/projects",
    "read",
    "List projects accessible to the current identity.",
  ),
  create_project: op(
    z
      .object({
        ...mutation,
        key: z
          .string()
          .trim()
          .regex(/^[A-Z][A-Z0-9]{1,9}$/),
        name: text.max(120),
        description: z.string().max(5000).default(""),
      })
      .strict(),
    projectSchema,
    "POST",
    "/projects",
    "write",
    "Create a project with a permanent ticket prefix.",
  ),
  update_project: op(
    projectInput
      .extend({
        ...mutation,
        expectedVersion: version,
        name: text.max(120),
        description: z.string().max(5000),
      })
      .strict(),
    projectSchema,
    "PATCH",
    "/projects/{projectId}",
    "admin",
    "Update project details without changing its prefix.",
  ),
  list_members: op(
    projectInput,
    z.array(
      z.object({ userId: z.string(), name: z.string(), email: z.string(), role: z.enum(roles) }),
    ),
    "GET",
    "/projects/{projectId}/members",
    "read",
    "List project members.",
  ),
  set_member: op(
    projectInput.extend({ ...mutation, email: z.email(), role: z.enum(roles).nullable() }).strict(),
    ok,
    "POST",
    "/projects/{projectId}/members",
    "admin",
    "Add or update an existing user's membership, or remove it with a null role.",
  ),
  list_tickets: op(
    projectInput.extend({ ...ticketFilter.shape, ...pagination }),
    page(ticketSchema),
    "GET",
    "/projects/{projectId}/tickets",
    "read",
    "Search tickets with server-side filters, stable ordering, and pagination.",
  ),
  get_ticket: op(
    ticketInput,
    z.object({ ticket: ticketSchema, readiness: readinessSchema, claim: claimSchema.nullable() }),
    "GET",
    "/projects/{projectId}/tickets/{ticketId}",
    "read",
    "Read a ticket by ID or key, with readiness and ownership.",
  ),
  create_ticket: op(
    projectInput
      .extend({
        ...mutation,
        title: ticketFields.shape.title,
        description: z.string().max(100_000).default(""),
        acceptanceCriteria: z.string().max(50_000).default(""),
        status: z.enum(states).default("todo"),
        priority: z.enum(priorities).default("medium"),
        kind: z.enum(kinds).default("feature"),
        difficulty: z.enum(difficulties).nullable().default(null),
        labels: tags.default([]),
        scopes: tags.default([]),
        assigneeId: z.string().nullable().default(null),
        parentId: z.uuid().nullable().default(null),
        automationReady: z.boolean().default(false),
        holdReason: z.string().trim().max(2000).nullable().default(null),
        archived: z.boolean().default(false),
      })
      .strict(),
    ticketSchema,
    "POST",
    "/projects/{projectId}/tickets",
    "write",
    "Create a ticket. Reuse requestId when retrying this write.",
  ),
  update_ticket: op(
    ticketInput
      .extend({
        ...mutation,
        expectedVersion: version,
        changes: ticketChanges,
        claimId: z.uuid().optional(),
      })
      .strict(),
    ticketSchema,
    "PATCH",
    "/projects/{projectId}/tickets/{ticketId}",
    "write",
    "Update a ticket with optimistic concurrency. Worker completion requires its active claim.",
  ),
  bulk_update_tickets: op(
    projectInput
      .extend({
        ...mutation,
        tickets: z
          .array(z.object({ ticketId: id, expectedVersion: version }))
          .min(1)
          .max(100)
          .refine(
            (values) => new Set(values.map((v) => v.ticketId)).size === values.length,
            "Tickets must be unique",
          ),
        changes: ticketChanges,
      })
      .strict(),
    z.array(ticketSchema),
    "POST",
    "/projects/{projectId}/tickets/bulk",
    "write",
    "Apply an atomic bulk edit using each ticket's current version.",
  ),
  delete_ticket: op(
    ticketInput.extend({ ...mutation, expectedVersion: version }).strict(),
    ok,
    "DELETE",
    "/projects/{projectId}/tickets/{ticketId}",
    "admin",
    "Delete a ticket and publish a deletion event.",
  ),
  list_eligible_tickets: op(
    projectInput.extend(pagination),
    page(z.object({ ticket: ticketSchema, readiness: readinessSchema })),
    "GET",
    "/projects/{projectId}/eligibility",
    "read",
    "Inspect eligibility and explicit blocking reasons for open tickets.",
  ),
  list_relations: op(
    ticketInput,
    z.array(relationSchema),
    "GET",
    "/projects/{projectId}/tickets/{ticketId}/relations",
    "read",
    "List incoming and outgoing ticket relationships.",
  ),
  add_relation: op(
    ticketInput
      .extend({ ...mutation, targetId: z.uuid(), type: relationSchema.shape.type })
      .strict(),
    relationSchema,
    "POST",
    "/projects/{projectId}/tickets/{ticketId}/relations",
    "write",
    "Relate tickets while rejecting dependency cycles.",
  ),
  remove_relation: op(
    projectInput.extend({ ...mutation, relationId: z.uuid() }).strict(),
    ok,
    "DELETE",
    "/projects/{projectId}/relations/{relationId}",
    "write",
    "Remove a ticket relationship.",
  ),
  list_comments: op(
    ticketInput.extend(pagination),
    page(commentSchema),
    "GET",
    "/projects/{projectId}/tickets/{ticketId}/comments",
    "read",
    "Read ticket discussion.",
  ),
  add_comment: op(
    ticketInput.extend({ ...mutation, body: text.max(50_000) }).strict(),
    commentSchema,
    "POST",
    "/projects/{projectId}/tickets/{ticketId}/comments",
    "write",
    "Add a comment with authenticated attribution.",
  ),
  update_comment: op(
    projectInput
      .extend({
        ...mutation,
        commentId: z.uuid(),
        expectedVersion: version,
        body: text.max(50_000),
      })
      .strict(),
    commentSchema,
    "PATCH",
    "/projects/{projectId}/comments/{commentId}",
    "write",
    "Edit your own comment or moderate as a project administrator.",
  ),
  delete_comment: op(
    projectInput.extend({ ...mutation, commentId: z.uuid(), expectedVersion: version }).strict(),
    ok,
    "DELETE",
    "/projects/{projectId}/comments/{commentId}",
    "write",
    "Delete your own comment or moderate as a project administrator.",
  ),
  list_activity: op(
    ticketInput.extend(pagination),
    page(eventSchema),
    "GET",
    "/projects/{projectId}/tickets/{ticketId}/activity",
    "read",
    "Read durable ticket activity.",
  ),
  list_attachments: op(
    ticketInput,
    z.array(attachmentSchema),
    "GET",
    "/projects/{projectId}/tickets/{ticketId}/attachments",
    "read",
    "List authorized attachment metadata.",
  ),
  delete_attachment: op(
    projectInput.extend({ ...mutation, attachmentId: z.uuid() }).strict(),
    ok,
    "DELETE",
    "/projects/{projectId}/attachments/{attachmentId}",
    "write",
    "Remove an attachment.",
  ),
  list_evidence: op(
    ticketInput,
    z.array(evidenceSchema),
    "GET",
    "/projects/{projectId}/tickets/{ticketId}/evidence",
    "read",
    "Read attributed evidence. Outcomes are reports from the submitting identity.",
  ),
  add_evidence: op(
    ticketInput
      .extend({ ...mutation, ...evidenceFields.shape, claimId: z.uuid().optional() })
      .strict(),
    evidenceSchema,
    "POST",
    "/projects/{projectId}/tickets/{ticketId}/evidence",
    "write",
    "Attach evidence with its commit and provenance.",
  ),
  claim_ticket: op(
    ticketInput
      .extend({
        ...mutation,
        workerId: text.max(200),
        expectedVersion: version,
        leaseSeconds: z.number().int().min(30).max(3600).default(300),
      })
      .strict(),
    claimSchema,
    "POST",
    "/projects/{projectId}/tickets/{ticketId}/claim",
    "claim",
    "Atomically claim ready work. Expired claims require explicit recovery.",
  ),
  renew_claim: op(
    ticketInput
      .extend({
        ...mutation,
        claimId: z.uuid(),
        leaseSeconds: z.number().int().min(30).max(3600).default(300),
      })
      .strict(),
    claimSchema,
    "POST",
    "/projects/{projectId}/tickets/{ticketId}/claim/renew",
    "claim",
    "Renew the caller's unexpired claim.",
  ),
  release_claim: op(
    ticketInput.extend({ ...mutation, claimId: z.uuid() }).strict(),
    ok,
    "POST",
    "/projects/{projectId}/tickets/{ticketId}/claim/release",
    "claim",
    "Release the caller's claim.",
  ),
  recover_claim: op(
    ticketInput
      .extend({
        ...mutation,
        claimId: z.uuid(),
        reason: text.min(10).max(2000),
        confirmedStopped: z.literal(true),
      })
      .strict(),
    ok,
    "POST",
    "/projects/{projectId}/tickets/{ticketId}/claim/recover",
    "admin",
    "Recover an expired claim only after confirming the worker stopped.",
  ),
  set_subscription: op(
    ticketInput.extend({ ...mutation, enabled: z.boolean() }).strict(),
    ok,
    "POST",
    "/projects/{projectId}/tickets/{ticketId}/subscription",
    "read",
    "Subscribe to ticket updates or unsubscribe.",
  ),
  list_views: op(
    projectInput,
    z.array(z.object({ id: z.uuid(), name: z.string(), filters: ticketFilter })),
    "GET",
    "/projects/{projectId}/views",
    "read",
    "List your saved project views.",
  ),
  save_view: op(
    projectInput.extend({ ...mutation, name: text.max(80), filters: ticketFilter }).strict(),
    z.object({ id: z.uuid() }),
    "POST",
    "/projects/{projectId}/views",
    "read",
    "Save a personal filtered view.",
  ),
  delete_view: op(
    projectInput.extend({ ...mutation, viewId: z.uuid() }).strict(),
    ok,
    "DELETE",
    "/projects/{projectId}/views/{viewId}",
    "read",
    "Delete your own saved view.",
  ),
} as const;

export type Operation = keyof typeof operations;
export type Input<K extends Operation> = z.input<(typeof operations)[K]["input"]>;
export type ParsedInput<K extends Operation> = z.output<(typeof operations)[K]["input"]>;
export type Output<K extends Operation> = z.output<(typeof operations)[K]["output"]>;
export function isOperation(name: string): name is Operation {
  return Object.hasOwn(operations, name);
}
export const errorSchema = z.object({
  error: z.object({ code: z.string(), message: z.string(), details: z.unknown().optional() }),
});

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: unknown;
  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export function parseOutput<K extends Operation>(name: K, value: unknown): Output<K> {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- The registry key selects and validates the generic result schema.
  return operations[name].output.parse(value) as Output<K>;
}
