import { authenticationPolicySchema } from "./instance.ts";
import type { palettes } from "./theme.ts";
import { z } from "zod";

export const states = ["backlog", "todo", "in_progress", "in_review", "done", "cancelled"] as const;
// Statuses that end work; "open" everywhere means not one of these.
export const closedStates = ["done", "cancelled"] as const;
export const priorities = ["urgent", "high", "medium", "low", "none"] as const;
export const kinds = ["feature", "bug", "chore", "research", "documentation"] as const;
export const difficulties = ["low", "med", "high"] as const;
export const roles = ["reader", "writer", "admin"] as const;
export const projectIconColors = [
  "default",
  "red",
  "orange",
  "amber",
  "yellow",
  "lime",
  "green",
  "emerald",
  "teal",
  "cyan",
  "sky",
  "blue",
  "indigo",
  "violet",
  "purple",
  "fuchsia",
  "pink",
  "rose",
  "gray",
] as const;
// A preset name or a custom hex color such as #1e90ff. Custom colors used on a label are kept in
// the site-wide palette (`list_label_colors`).
export const hexColor = z
  .string()
  .regex(/^#[0-9a-f]{6}$/i)
  .overwrite((value) => value.toLowerCase());
export const labelColor = z.union([z.enum(projectIconColors), hexColor]);
export type LabelColor = z.output<typeof labelColor>;
export const isPresetColor = (value: string): value is (typeof projectIconColors)[number] =>
  projectIconColors.some((tone) => tone === value);
export const isHexColor = (value: string) => hexColor.safeParse(value).success;
export const hasAdminRole = (role: string | null | undefined) =>
  role?.split(",").includes("admin") ?? false;
export const scopes = ["read", "write", "claim", "admin"] as const;
export const attachmentLimit = 10_000_000;
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
export const stateTones: Record<(typeof states)[number], keyof typeof palettes.light> = {
  backlog: "muted",
  todo: "foreground",
  in_progress: "warning",
  in_review: "accent",
  done: "success",
  cancelled: "muted",
};

const id = z.string().min(1).max(80);
const timestamp = z.iso.datetime();
// PostgreSQL rejects year 0, which the ISO grammar allows.
export const dueDate = z.iso
  .datetime()
  .refine((value) => new Date(value).getUTCFullYear() >= 1, "Due date must be in year 1 or later");
const version = z.number().int().positive();
const text = z.string().trim().min(1);
const tags = z
  .array(text.max(40))
  .max(30)
  .overwrite((values) => [...new Set(values)]);
export const projectLabelSchema = z.object({
  id: z.uuid(),
  projectId: z.uuid(),
  name: text.max(40),
  color: labelColor,
  version,
});
export type ProjectLabel = z.output<typeof projectLabelSchema>;
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
    // A user id, or "none" for unassigned tickets.
    assigneeId: z.union([id, z.literal("none")]).optional(),
    parentId: id.optional(),
    archived: z.enum(["include", "only", "exclude"]).default("exclude"),
    due: z.enum(["overdue", "today", "week", "scheduled", "none"]).optional(),
    sort: z
      .enum([
        "priority",
        "updated",
        "created",
        "title",
        "labels",
        "due",
        "number",
        "status",
        "difficulty",
        "kind",
        "assignee",
      ])
      .default("priority"),
    order: z.enum(["asc", "desc"]).optional(),
  })
  .strict();
export const sortLabels: Record<z.output<typeof ticketFilter>["sort"], string> = {
  priority: "Priority",
  updated: "Recently updated",
  created: "Recently created",
  title: "Title",
  labels: "Labels",
  due: "Due date",
  number: "Ticket number",
  status: "Status",
  difficulty: "Difficulty",
  kind: "Kind",
  assignee: "Assignee",
};
// The direction each sort uses unless the caller sets `order`.
export const defaultOrder: Record<z.output<typeof ticketFilter>["sort"], "asc" | "desc"> = {
  priority: "asc",
  updated: "desc",
  created: "desc",
  title: "asc",
  labels: "asc",
  due: "asc",
  number: "asc",
  status: "asc",
  difficulty: "asc",
  kind: "asc",
  assignee: "asc",
};
export const dueFilterLabels: Record<NonNullable<z.output<typeof ticketFilter>["due"]>, string> = {
  overdue: "Overdue",
  today: "Due today",
  week: "Due this week",
  scheduled: "Has a due date",
  none: "No due date",
};
export const ticketFields = z
  .object({
    title: text.max(500).overwrite((value) => value.replace(/\s+/gu, " ")),
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
    dueAt: dueDate.nullable(),
    archived: z.boolean(),
  })
  .strict();
export const ticketChanges = ticketFields
  .partial()
  .refine((value) => Object.keys(value).length > 0, "Provide at least one change");
export const workspaceSchema = z.object({
  id: z.uuid(),
  slug: text.max(80),
  name: text.max(120),
  description: z.string(),
  version,
  createdAt: timestamp,
  updatedAt: timestamp,
  role: z.enum(roles).nullable(),
});
export type Workspace = z.output<typeof workspaceSchema>;
export const memberSchema = z.object({
  userId: z.string(),
  name: z.string(),
  email: z.string(),
  role: z.enum(roles),
  image: z.string().nullable().optional(),
  source: z.enum(["project", "workspace"]).optional(),
  inheritedRole: z.enum(roles).nullable().optional(),
});
export const projectSchema = z.object({
  iconName: z.string().nullable().default(null),
  iconColor: z.enum(projectIconColors).default("default"),
  image: z.string().nullable().default(null),
  workspaceId: z.uuid(),
  visibility: z.enum(["workspace", "private"]),
  id: z.uuid(),
  key: z.string(),
  name: z.string(),
  description: z.string(),
  version,
  createdAt: timestamp,
  updatedAt: timestamp,
});
export const ticketSchema = ticketFields.extend({
  claimRequired: z.boolean(),
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
export const checkpointSchema = z.object({ cursor: z.string().regex(/^\d+$/) });
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
  type: z.enum(["blocks", "related", "duplicate", "causes", "clones", "implements", "reviews"]),
  sourceKey: z.string().optional(),
  sourceTitle: z.string().optional(),
  targetKey: z.string().optional(),
  targetTitle: z.string().optional(),
});
export const relationDirections = z.enum(["outgoing", "incoming"]);
const relationLabels: Record<z.output<typeof relationSchema>["type"], [string, string]> = {
  blocks: ["Blocks", "Is blocked by"],
  related: ["Related to", "Related to"],
  duplicate: ["Duplicates", "Is duplicated by"],
  causes: ["Causes", "Is caused by"],
  clones: ["Clones", "Is cloned by"],
  implements: ["Implements", "Is implemented by"],
  reviews: ["Reviews", "Is reviewed by"],
};
export const relationChoices = relationSchema.shape.type.options.flatMap((type) =>
  (type === "related" ? ["outgoing" as const] : relationDirections.options).map((direction) => ({
    value: `${type}:${direction}`,
    label: relationLabels[type][direction === "outgoing" ? 0 : 1],
    type,
    direction,
  })),
);
export function parseRelationChoice(value: unknown) {
  const [type, direction] = z
    .tuple([relationSchema.shape.type, relationDirections])
    .parse(z.string().parse(value).split(":"));
  return { type, direction };
}
export function relationReference(relation: z.output<typeof relationSchema>, ticketId: string) {
  const outgoing = relation.sourceId === ticketId;
  const referenceId = outgoing ? relation.targetId : relation.sourceId;
  const key = (outgoing ? relation.targetKey : relation.sourceKey) ?? referenceId;
  const title = outgoing ? relation.targetTitle : relation.sourceTitle;
  const label = relationLabels[relation.type][outgoing ? 0 : 1];
  return { id: referenceId, label, title: `${key}${title ? ` · ${title}` : ""}` };
}
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
export const infoSchema = z.object({
  authentication: authenticationPolicySchema.default(() => authenticationPolicySchema.parse({})),
  name: z.string(),
  description: z.string().default(""),
  version: z.string(),
  setupRequired: z.boolean(),
  oidc: z.object({ id: z.string(), name: z.string() }).nullable(),
  push: z.boolean().default(false),
});
export const notificationsSchema = z.array(
  z.object({
    id: z.uuid(),
    readAt: timestamp.nullable(),
    event: eventSchema,
  }),
);
export const notificationPreferencesSchema = z.object({
  inApp: z.boolean().default(true),
  push: z.boolean().default(false),
});
export const notificationPreferencesInput = z
  .object({ inApp: z.boolean(), push: z.boolean().optional() })
  .strict();
export const pushDeviceInput = z.object({ token: z.string().min(1).max(250) }).strict();
export const credentialsSchema = z.array(
  z.object({
    id: z.string(),
    name: z.string().nullable(),
    start: z.string().nullable(),
    enabled: z.boolean(),
    expiresAt: timestamp.nullable(),
    createdAt: timestamp,
    permissions: z.string().nullable(),
    metadata: z.string().nullable(),
  }),
);
export const createdCredentialSchema = z.object({
  id: z.string(),
  key: z.string(),
  name: z.string().nullable(),
  expiresAt: timestamp.nullable(),
});
export const okSchema = z.object({ ok: z.literal(true) });
export type ChangeEvent = z.output<typeof eventSchema>;
const eventLabels: Record<string, string> = {
  "label.created": "Label created",
  "label.updated": "Label updated",
  "label.deleted": "Label deleted",
  "ticket.created": "Ticket created",
  "ticket.updated": "Ticket updated",
  "ticket.deleted": "Ticket deleted",
  "ticket.claimed": "Work claimed",
  "claim.renewed": "Claim renewed",
  "claim.released": "Claim released",
  "claim.recovered": "Claim recovered",
  "comment.created": "Comment added",
  "comment.updated": "Comment edited",
  "comment.deleted": "Comment deleted",
  "relation.added": "Relationship added",
  "relation.removed": "Relationship removed",
  "attachment.created": "File attached",
  "attachment.deleted": "File removed",
  "evidence.added": "Evidence attached",
  "project.created": "Project created",
  "project.updated": "Project updated",
  "membership.updated": "Project access changed",
};
export function formatEvent(event: ChangeEvent, includeTicket = false): string {
  const fallback = event.type.replaceAll(".", " ").replaceAll("_", " "),
    label = eventLabels[event.type] ?? fallback.charAt(0).toUpperCase() + fallback.slice(1);
  if (!includeTicket || !event.ticketId) return label;
  const key = typeof event.data.key === "string" ? event.data.key : event.ticketId;
  return `${label} · ${key}${typeof event.data.title === "string" ? ` · ${event.data.title}` : ""}`;
}
export const page = <T extends z.ZodType>(item: T) =>
  z.object({ items: z.array(item), total: z.number().int().nonnegative() });
const op = <I extends z.ZodObject, O extends z.ZodType>(
  input: I,
  output: O,
  method: "GET" | "POST" | "PATCH" | "DELETE",
  path: string,
  scope: (typeof scopes)[number],
  description: string,
) => ({ input, output, method, path, scope, description });

export const operations = {
  list_workspaces: op(
    z.object({}),
    z.array(workspaceSchema),
    "GET",
    "/workspaces",
    "read",
    "List accessible workspaces and the current membership role.",
  ),
  create_workspace: op(
    z
      .object({
        ...mutation,
        name: text.max(120),
        slug: z
          .string()
          .trim()
          .regex(/^[a-z0-9][a-z0-9-]{1,79}$/),
        description: z.string().max(5000).default(""),
      })
      .strict(),
    workspaceSchema,
    "POST",
    "/workspaces",
    "write",
    "Create a workspace and become its administrator.",
  ),
  update_workspace: op(
    z
      .object({
        ...mutation,
        workspaceId: z.uuid(),
        expectedVersion: version,
        name: text.max(120),
        description: z.string().max(5000),
      })
      .strict(),
    workspaceSchema,
    "PATCH",
    "/workspaces/{workspaceId}",
    "admin",
    "Update workspace details with version checks.",
  ),
  list_workspace_members: op(
    z.object({ workspaceId: z.uuid() }),
    z.array(memberSchema),
    "GET",
    "/workspaces/{workspaceId}/members",
    "read",
    "List members of a workspace you belong to.",
  ),
  set_workspace_member: op(
    z
      .object({
        ...mutation,
        workspaceId: z.uuid(),
        email: z.email(),
        role: z.enum(roles).nullable(),
      })
      .strict(),
    okSchema,
    "POST",
    "/workspaces/{workspaceId}/members",
    "admin",
    "Manage workspace access; removal also revokes direct project access in this workspace.",
  ),
  list_projects: op(
    z.object({ workspaceId: z.uuid().optional() }),
    z.array(
      projectSchema.extend({
        openTickets: z.number().int().nonnegative(),
        overdueTickets: z.number().int().nonnegative(),
        role: z.enum(roles),
      }),
    ),
    "GET",
    "/projects",
    "read",
    "List projects accessible to the current identity, each with its open and overdue ticket counts.",
  ),
  create_project: op(
    z
      .object({
        ...mutation,
        workspaceId: z.uuid().optional(),
        visibility: z.enum(["workspace", "private"]).default("private"),
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
  get_project: op(
    projectInput,
    projectSchema,
    "GET",
    "/projects/{projectId}",
    "read",
    "Read project details, workspace identity, and appearance.",
  ),
  set_project_icon: op(
    projectInput
      .extend({
        ...mutation,
        expectedVersion: version,
        icon: z.union([
          z
            .object({
              kind: z.literal("library"),
              name: z.string().regex(/^[a-z0-9-]{1,80}$/),
              color: z.enum(projectIconColors).default("default"),
            })
            .strict(),
          z
            .object({
              kind: z.literal("image"),
              contentType: z.enum(["image/png", "image/jpeg", "image/webp"]),
              data: z.string().max(700000),
            })
            .strict(),
          z.null(),
        ]),
      })
      .strict(),
    projectSchema,
    "POST",
    "/projects/{projectId}/icon",
    "admin",
    "Choose an installed library icon, upload an image, or reset the project icon.",
  ),
  update_project: op(
    projectInput
      .extend({
        ...mutation,
        expectedVersion: version,
        visibility: z.enum(["workspace", "private"]).optional(),
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
    z.array(memberSchema),
    "GET",
    "/projects/{projectId}/members",
    "read",
    "List project members.",
  ),
  set_member: op(
    projectInput.extend({ ...mutation, email: z.email(), role: z.enum(roles).nullable() }).strict(),
    okSchema,
    "POST",
    "/projects/{projectId}/members",
    "admin",
    "Add or update an existing user's membership, or remove it with a null role.",
  ),
  list_tickets: op(
    projectInput.extend({
      ...ticketFilter.shape,
      ...pagination,
      // A ticket ID or key: only tickets linked to it by a relationship, in either direction.
      relatedTo: id.optional(),
    }),
    page(ticketSchema),
    "GET",
    "/projects/{projectId}/tickets",
    "read",
    "Search tickets with server-side filters, stable ordering, and pagination.",
  ),
  list_ticket_labels: op(
    projectInput.extend({ archived: ticketFilter.shape.archived }),
    z.array(z.object({ name: z.string(), count: z.number().int().nonnegative() })),
    "GET",
    "/projects/{projectId}/labels",
    "read",
    "List distinct ticket labels and usage counts across the authorized project, independent of ticket pagination.",
  ),
  list_project_labels: op(
    projectInput,
    z.array(projectLabelSchema.extend({ count: z.number().int().nonnegative() })),
    "GET",
    "/projects/{projectId}/labels/catalog",
    "read",
    "List project label definitions, colors, and ticket counts, including unused labels and archived tickets.",
  ),
  create_project_label: op(
    projectInput
      .extend({
        ...mutation,
        name: text.max(40),
        color: labelColor.default("gray"),
      })
      .strict(),
    projectLabelSchema,
    "POST",
    "/projects/{projectId}/labels",
    "admin",
    "Create a reusable project label. Label names are unique within the project.",
  ),
  update_project_label: op(
    projectInput
      .extend({
        ...mutation,
        labelId: z.uuid(),
        expectedVersion: version,
        name: text.max(40),
        color: labelColor,
      })
      .strict(),
    projectLabelSchema,
    "PATCH",
    "/projects/{projectId}/labels/{labelId}",
    "admin",
    "Rename or recolor a project label. Renames update tickets and saved-view filters atomically.",
  ),
  delete_project_label: op(
    projectInput.extend({ ...mutation, labelId: z.uuid(), expectedVersion: version }).strict(),
    okSchema,
    "DELETE",
    "/projects/{projectId}/labels/{labelId}",
    "admin",
    "Delete a project label and remove it from tickets and saved-view filters atomically.",
  ),
  list_label_colors: op(
    z.object({}),
    z.array(z.object({ value: hexColor, createdAt: timestamp })),
    "GET",
    "/label-colors",
    "read",
    "List the site-wide custom label colors, newest first. A custom color joins the list when a label is saved with it.",
  ),
  remove_label_color: op(
    z.object({ ...mutation, value: hexColor }).strict(),
    okSchema,
    "POST",
    "/label-colors/remove",
    "write",
    "Remove a custom color from the site-wide palette; instance administrators and the person who added it may do so. Labels already using it keep their color.",
  ),
  get_ticket: op(
    ticketInput,
    z.object({
      ticket: ticketSchema,
      readiness: readinessSchema,
      claim: claimSchema.nullable(),
      subscribed: z.boolean(),
      canReleaseClaim: z.boolean(),
    }),
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
        dueAt: dueDate.nullable().default(null),
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
    okSchema,
    "DELETE",
    "/projects/{projectId}/tickets/{ticketId}",
    "admin",
    "Delete a ticket and publish a deletion event.",
  ),
  search_tickets: op(
    z
      .object({
        q: z.string().trim().min(1).max(200),
        workspaceId: z.uuid().optional(),
        limit: z.coerce.number().int().min(1).max(50).default(20),
      })
      .strict(),
    z.object({
      items: z.array(
        z.object({
          ticket: ticketSchema,
          project: z.object({ id: z.uuid(), key: z.string(), name: z.string() }),
        }),
      ),
    }),
    "GET",
    "/tickets/search",
    "read",
    "Search unarchived tickets by key or text across every accessible project, optionally within one workspace.",
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
      .extend({
        ...mutation,
        targetId: z.uuid(),
        type: relationSchema.shape.type,
        direction: relationDirections.optional(),
      })
      .strict(),
    relationSchema,
    "POST",
    "/projects/{projectId}/tickets/{ticketId}/relations",
    "write",
    "Relate tickets while rejecting dependency cycles.",
  ),
  remove_relation: op(
    projectInput.extend({ ...mutation, relationId: z.uuid() }).strict(),
    okSchema,
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
    okSchema,
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
  upload_attachment: op(
    ticketInput
      .extend({
        ...mutation,
        name: text.max(255).refine((value) => {
          for (const character of value)
            if (character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127) return false;
          return true;
        }, "Use a filename without control characters"),
        contentType: z
          .string()
          .max(120)
          .regex(/^[a-z0-9][a-z0-9.+-]*\/[a-z0-9][a-z0-9.+-]*$/i)
          .default("application/octet-stream"),
        data: z.string().max(Math.ceil(attachmentLimit / 3) * 4),
      })
      .strict(),
    attachmentSchema,
    "POST",
    "/projects/{projectId}/tickets/{ticketId}/attachments",
    "write",
    "Upload up to 10 MB of base64-encoded bytes. The original filename is metadata, never a filesystem path.",
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
    okSchema,
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
    okSchema,
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
    okSchema,
    "POST",
    "/projects/{projectId}/tickets/{ticketId}/claim/recover",
    "admin",
    "Recover an expired claim only after confirming the worker stopped.",
  ),
  set_subscription: op(
    ticketInput.extend({ ...mutation, enabled: z.boolean() }).strict(),
    okSchema,
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
    okSchema,
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
export const streamErrorSchema = z.object({
  status: z.number().int().min(400).max(599),
  code: z.string(),
  message: z.string(),
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

export function errorMessage(error: unknown): string {
  if (
    error instanceof Error &&
    /fetch failed|failed to fetch|network request failed|could not connect to the server/i.test(
      error.message,
    )
  )
    return "Could not reach Kanvil. Check your connection and retry.";
  if (error instanceof z.ZodError)
    return error.issues
      .slice(0, 3)
      .map((issue) => `${issue.path.join(".") || "Input"}: ${issue.message}`)
      .join("; ");
  if (error instanceof ApiError && Array.isArray(error.details)) {
    const details = z
      .array(z.object({ path: z.string(), message: z.string() }))
      .safeParse(error.details);
    if (details.success)
      return details.data
        .slice(0, 3)
        .map((issue) => `${issue.path || "Input"}: ${issue.message}`)
        .join("; ");
  }
  return error instanceof Error
    ? error.message
    : typeof error === "string"
      ? error
      : "The request could not be completed";
}

export function formatTimestamp(value: string): string {
  return new Date(value).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}
