import {
  bigint,
  check,
  customType,
  boolean,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { session, user } from "./auth-schema.ts";

const time = (name: string) => timestamp(name, { withTimezone: true }).notNull().defaultNow();
const actor = () =>
  text("actor_id")
    .notNull()
    .references(() => user.id);
export const workspaces = pgTable("workspaces", {
  id: uuid("id").primaryKey().defaultRandom(),
  slug: text("slug").notNull().unique(),
  name: text("name").notNull(),
  description: text("description").notNull().default(""),
  // An active administrator member; only a transfer changes it, and the handlers refuse to remove,
  // demote, disable, or delete the account while it owns a live workspace. Null only on a
  // workspace that had no active administrator when ownership was introduced.
  ownerId: text("owner_id").references(() => user.id, { onDelete: "set null" }),
  version: integer("version").notNull().default(1),
  // A deleted workspace keeps this row, its URL key, and its projects' tombstones.
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
  createdAt: time("created_at"),
  updatedAt: time("updated_at"),
});
export const workspaceMembers = pgTable(
  "workspace_members",
  {
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    role: text("role").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.workspaceId, table.userId] }),
    index("workspace_member_user").on(table.userId),
  ],
);
// Only a SHA-256 hash of each one-time token is stored; resending replaces it. `projectIds` null
// grants the role on the workspace itself.
export const invitations = pgTable(
  "invitations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    email: text("email").notNull(),
    role: text("role").notNull(),
    projectIds: uuid("project_ids").array(),
    tokenHash: text("token_hash").notNull().unique(),
    status: text("status").notNull().default("pending"),
    invitedBy: text("invited_by").references(() => user.id, { onDelete: "set null" }),
    acceptedBy: text("accepted_by").references(() => user.id, { onDelete: "set null" }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    sentAt: time("sent_at"),
    version: integer("version").notNull().default(1),
    createdAt: time("created_at"),
    updatedAt: time("updated_at"),
  },
  (table) => [index("invitation_workspace").on(table.workspaceId, table.status)],
);
export const projects = pgTable(
  "projects",
  {
    iconName: text("icon_name"),
    iconColor: text("icon_color").notNull().default("default"),
    image: text("image"),
    iconObjectId: uuid("icon_object_id").references(() => blobObjects.id),
    background: text("background"),
    backgroundObjectId: uuid("background_object_id").references(() => blobObjects.id),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id),
    visibility: text("visibility").notNull().default("private"),
    // Anonymous read-only access through /api/public; independent of membership and visibility.
    publicReadEnabled: boolean("public_read_enabled").notNull().default(false),
    id: uuid("id").primaryKey().defaultRandom(),
    key: text("key").notNull().unique(),
    name: text("name").notNull(),
    description: text("description").notNull().default(""),
    nextNumber: integer("next_number").notNull().default(1),
    // Place in the workspace's shared project order; see ordering.ts.
    position: bigint("position", { mode: "number" }).notNull().default(0),
    version: integer("version").notNull().default(1),
    // Archived projects leave default lists, search, My work, feeds, and agent queues and are read
    // only; restoring clears it.
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    // A deleted project keeps this row, its prefix, and its event history; no one can open it.
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    createdAt: time("created_at"),
    updatedAt: time("updated_at"),
  },
  (table) => [index("project_workspace").on(table.workspaceId)],
);
// Every prefix a project has had, its current one included. A prefix never passes to another
// project, so every key issued under it keeps naming the same ticket (see `ticketMatch`).
export const projectPrefixes = pgTable(
  "project_prefixes",
  {
    prefix: text("prefix").primaryKey(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
  },
  (table) => [index("project_prefix_project").on(table.projectId)],
);
export const members = pgTable(
  "project_members",
  {
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    role: text("role").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.projectId, table.userId] }),
    index("member_user").on(table.userId),
  ],
);
export const projectLabels = pgTable(
  "project_labels",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    color: text("color").notNull().default("gray"),
    version: integer("version").notNull().default(1),
  },
  (table) => [unique("project_label_name").on(table.projectId, table.name)],
);
// Labels every project in the workspace can use. A name lives here or in project_labels within
// one workspace, never both; the label handlers keep that invariant.
export const workspaceLabels = pgTable(
  "workspace_labels",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    color: text("color").notNull().default("gray"),
    version: integer("version").notNull().default(1),
  },
  (table) => [unique("workspace_label_name").on(table.workspaceId, table.name)],
);
// A project's typed ticket field. Option IDs stay stable so ticket values survive renames; tickets
// keep values in `tickets.custom_fields` by field ID.
export const customFields = pgTable(
  "custom_fields",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    type: text("type").notNull(),
    options: jsonb("options")
      .$type<{ id: string; name: string; color: string }[]>()
      .notNull()
      .default([]),
    required: boolean("required").notNull().default(false),
    defaultValue: jsonb("default_value").$type<string | number | boolean | string[]>(),
    // Display order within the project; see ordering.ts.
    position: bigint("position", { mode: "number" }).notNull().default(0),
    version: integer("version").notNull().default(1),
  },
  (table) => [
    unique("custom_field_name").on(table.projectId, table.name),
    index("custom_field_project_position").on(table.projectId, table.position),
  ],
);
// Site-wide palette of custom label colors; a hex value joins it when any label is saved with it.
export const labelColors = pgTable("label_colors", {
  value: text("value").primaryKey(),
  createdBy: text("created_by").references(() => user.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
// A project's named ticket states, each mapped to a canonical category (`states` in contracts).
export const workflowStates = pgTable(
  "workflow_states",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    slug: text("slug").notNull(),
    name: text("name").notNull(),
    category: text("category").notNull(),
    color: text("color").notNull().default("default"),
    position: integer("position").notNull(),
    version: integer("version").notNull().default(1),
  },
  (table) => [
    unique("workflow_state_slug").on(table.projectId, table.slug),
    // The target of tickets' state key, which carries the category into `tickets.status`.
    unique("workflow_state_category").on(table.projectId, table.id, table.category),
    check(
      "workflow_state_category_check",
      sql`${table.category} IN ('backlog', 'todo', 'in_progress', 'in_review', 'done', 'cancelled')`,
    ),
  ],
);
export const tickets = pgTable(
  "tickets",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    key: text("key").notNull().unique(),
    number: integer("number").notNull(),
    title: text("title").notNull(),
    description: text("description").notNull().default(""),
    acceptanceCriteria: text("acceptance_criteria").notNull().default(""),
    // The category of `stateId`, kept equal to it by the foreign key below: a state's category
    // change cascades here, and a write naming a state of another category is rejected.
    status: text("status").notNull(),
    stateId: uuid("state_id").notNull(),
    priority: text("priority").notNull().default("medium"),
    kind: text("kind").notNull().default("feature"),
    difficulty: text("difficulty"),
    labels: text("labels").array().notNull().default([]),
    scopes: text("scopes").array().notNull().default([]),
    assigneeId: text("assignee_id").references(() => user.id, { onDelete: "set null" }),
    parentId: uuid("parent_id"),
    automationReady: boolean("automation_ready").notNull().default(false),
    claimRequired: boolean("claim_required").notNull().default(false),
    holdReason: text("hold_reason"),
    startAt: timestamp("start_at", { withTimezone: true }),
    dueAt: timestamp("due_at", { withTimezone: true }),
    archived: boolean("archived").notNull().default(false),
    // Values of the project's custom fields by field ID; see custom-field-operations.ts.
    customFields: jsonb("custom_fields")
      .$type<Record<string, string | number | boolean | string[]>>()
      .notNull()
      .default({}),
    // Place in the project's manual order; see ordering.ts.
    position: bigint("position", { mode: "number" }).notNull().default(0),
    createdBy: text("created_by")
      .notNull()
      .references(() => user.id),
    version: integer("version").notNull().default(1),
    createdAt: time("created_at"),
    updatedAt: time("updated_at"),
  },
  (table) => [
    unique("ticket_project_number").on(table.projectId, table.number),
    index("ticket_project_status").on(table.projectId, table.status),
    index("ticket_parent").on(table.parentId),
    index("ticket_project_position").on(table.projectId, table.position),
    index("ticket_state").on(table.stateId),
    foreignKey({
      name: "ticket_workflow_state",
      columns: [table.projectId, table.stateId, table.status],
      foreignColumns: [workflowStates.projectId, workflowStates.id, workflowStates.category],
    }).onUpdate("cascade"),
  ],
);
// Keys a ticket held in projects it moved out of. Keys under its own project's earlier prefixes
// resolve through `project_prefixes` and the ticket number instead.
export const ticketAliases = pgTable(
  "ticket_aliases",
  {
    key: text("key").primaryKey(),
    ticketId: uuid("ticket_id")
      .notNull()
      .references(() => tickets.id, { onDelete: "cascade" }),
  },
  (table) => [index("ticket_alias_ticket").on(table.ticketId)],
);
export const relations = pgTable(
  "ticket_relations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    sourceId: uuid("source_id")
      .notNull()
      .references(() => tickets.id, { onDelete: "cascade" }),
    targetId: uuid("target_id")
      .notNull()
      .references(() => tickets.id, { onDelete: "cascade" }),
    type: text("type").notNull(),
  },
  (table) => [
    unique("ticket_relation_edge").on(table.sourceId, table.targetId, table.type),
    index("relation_target").on(table.targetId),
  ],
);
export const comments = pgTable(
  "comments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    ticketId: uuid("ticket_id")
      .notNull()
      .references(() => tickets.id, { onDelete: "cascade" }),
    actorId: actor(),
    body: text("body").notNull(),
    version: integer("version").notNull().default(1),
    createdAt: time("created_at"),
    updatedAt: time("updated_at"),
  },
  (table) => [index("comment_ticket").on(table.ticketId)],
);
export const claims = pgTable("claims", {
  id: uuid("id").primaryKey().defaultRandom(),
  projectId: uuid("project_id")
    .notNull()
    .references(() => projects.id, { onDelete: "cascade" }),
  ticketId: uuid("ticket_id")
    .notNull()
    .unique()
    .references(() => tickets.id, { onDelete: "cascade" }),
  actorId: actor(),
  ownerId: text("owner_id").notNull(),
  workerId: text("worker_id").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: time("created_at"),
});
export const events = pgTable(
  "events",
  {
    id: bigint("id", { mode: "bigint" }).primaryKey(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    ticketId: uuid("ticket_id"),
    // Null when the server raises the event on its own clock; `data.source` names the job.
    actorId: text("actor_id").references(() => user.id),
    type: text("type").notNull(),
    data: jsonb("data").$type<Record<string, unknown>>().notNull(),
    createdAt: time("created_at"),
  },
  (table) => [
    index("event_project_cursor").on(table.projectId, table.id),
    index("event_ticket").on(table.ticketId, table.id),
  ],
);
// Who may still replay an event of a project they can no longer read: the readers a deletion or
// move cut off, recorded when it happened so later membership changes grant nothing.
export const eventAudiences = pgTable(
  "event_audiences",
  {
    eventId: bigint("event_id", { mode: "bigint" })
      .notNull()
      .references(() => events.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
  },
  (table) => [
    primaryKey({ columns: [table.eventId, table.userId] }),
    index("event_audience_user").on(table.userId, table.eventId),
  ],
);
export const eventClock = pgTable("event_clock", {
  id: integer("id").primaryKey(),
  value: bigint("value", { mode: "bigint" })
    .notNull()
    .default(sql`0`),
  floor: bigint("floor", { mode: "bigint" })
    .notNull()
    .default(sql`0`),
});
export const receipts = pgTable(
  "mutation_receipts",
  {
    actorId: actor(),
    requestId: uuid("request_id").notNull(),
    operation: text("operation").notNull(),
    hash: text("hash").notNull(),
    result: jsonb("result").notNull(),
    createdAt: time("created_at"),
  },
  (table) => [primaryKey({ columns: [table.actorId, table.requestId] })],
);
export const storageBackends = pgTable("storage_backends", {
  id: uuid("id").primaryKey().defaultRandom(),
  identity: text("identity").notNull().unique(),
  config: text("config").notNull(),
  createdAt: time("created_at"),
});
const binary = customType<{ data: Buffer }>({ dataType: () => "bytea" });
export const blobObjects = pgTable(
  "blob_objects",
  {
    id: uuid("id").primaryKey(),
    backendId: uuid("backend_id").references(() => storageBackends.id),
    objectKey: text("object_key"),
    data: binary("data"),
    contentType: text("content_type").notNull(),
    size: integer("size").notNull(),
    sha256: text("sha256").notNull(),
    createdAt: time("created_at"),
  },
  (table) => [index("blob_objects_created").on(table.createdAt)],
);
export const profilePhotos = pgTable("profile_photos", {
  userId: text("user_id")
    .primaryKey()
    .references(() => user.id, { onDelete: "cascade" }),
  objectId: uuid("object_id")
    .notNull()
    .references(() => blobObjects.id),
});
export const instanceSettings = pgTable("instance_settings", {
  id: integer("id").primaryKey().default(1),
  identity: uuid("identity").notNull().defaultRandom(),
  version: integer("version").notNull().default(1),
  name: text("name").notNull().default("Kanvil"),
  description: text("description").notNull().default("Ticketing for people and agents"),
  storageBackendId: uuid("storage_backend_id").references(() => storageBackends.id),
  searchConfig: text("search_config"),
  brokerConfig: text("broker_config"),
  emailPasswordEnabled: boolean("email_password_enabled").notNull().default(true),
  ssoAutoProvision: boolean("sso_auto_provision").notNull().default(false),
});
export const deliveryCheckpoints = pgTable("delivery_checkpoints", {
  destination: text("destination").primaryKey(),
  cursor: bigint("cursor", { mode: "bigint" })
    .notNull()
    .default(sql`0`),
});
export const searchState = pgTable("search_state", {
  id: integer("id").primaryKey().default(1),
  configHash: text("config_hash").notNull().default(""),
  cursor: bigint("cursor", { mode: "bigint" })
    .notNull()
    .default(sql`0`),
  error: text("error"),
});
export const attachments = pgTable("attachments", {
  objectId: uuid("object_id").references(() => blobObjects.id),
  id: uuid("id").primaryKey().defaultRandom(),
  projectId: uuid("project_id")
    .notNull()
    .references(() => projects.id, { onDelete: "cascade" }),
  ticketId: uuid("ticket_id")
    .notNull()
    .references(() => tickets.id, { onDelete: "cascade" }),
  actorId: actor(),
  name: text("name").notNull(),
  contentType: text("content_type").notNull(),
  size: integer("size").notNull(),
  createdAt: time("created_at"),
});
// Inline files a person uploaded while composing a ticket that does not exist yet. Only the
// uploader can read or claim one; create_ticket turns it into an attachment with the same ID.
export const stagedUploads = pgTable(
  "staged_uploads",
  {
    id: uuid("id")
      .primaryKey()
      .references(() => blobObjects.id),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    actorId: actor(),
    name: text("name").notNull(),
    contentType: text("content_type").notNull(),
    size: integer("size").notNull(),
    createdAt: time("created_at"),
  },
  (table) => [index("staged_uploads_created").on(table.createdAt)],
);
const bytea = customType<{ data: Buffer }>({ dataType: () => "bytea" });
export const attachmentContent = pgTable("attachment_content", {
  id: uuid("id")
    .primaryKey()
    .references(() => attachments.id, { onDelete: "cascade" }),
  data: bytea("data").notNull(),
});
export const evidence = pgTable("evidence", {
  id: uuid("id").primaryKey().defaultRandom(),
  projectId: uuid("project_id")
    .notNull()
    .references(() => projects.id, { onDelete: "cascade" }),
  ticketId: uuid("ticket_id")
    .notNull()
    .references(() => tickets.id, { onDelete: "cascade" }),
  actorId: actor(),
  title: text("title").notNull(),
  kind: text("kind").notNull(),
  url: text("url").notNull(),
  commit: text("commit"),
  outcome: text("outcome").notNull(),
  note: text("note").notNull(),
  createdAt: time("created_at"),
});
export const resources = pgTable(
  "resources",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    ticketId: uuid("ticket_id")
      .notNull()
      .references(() => tickets.id, { onDelete: "cascade" }),
    actorId: actor(),
    url: text("url").notNull(),
    title: text("title").notNull().default(""),
    provider: text("provider"),
    // Written only by a configured connection; null means the remote state is unknown.
    remoteKind: text("remote_kind"),
    remoteState: text("remote_state"),
    remoteCheckedAt: timestamp("remote_checked_at", { withTimezone: true }),
    version: integer("version").notNull().default(1),
    createdAt: time("created_at"),
    updatedAt: time("updated_at"),
  },
  (table) => [index("resource_ticket").on(table.ticketId)],
);
// A project's shared iCalendar link. Only the token's SHA-256 hash is kept; revoking deletes the row.
export const calendarFeeds = pgTable(
  "calendar_feeds",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    createdBy: text("created_by")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    labels: text("labels").array().notNull().default([]),
    timeZone: text("time_zone").notNull(),
    tokenHash: text("token_hash").notNull().unique(),
    createdAt: time("created_at"),
  },
  (table) => [index("calendar_feed_project").on(table.projectId)],
);
export const subscriptions = pgTable(
  "subscriptions",
  {
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    ticketId: uuid("ticket_id")
      .notNull()
      .references(() => tickets.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
  },
  (table) => [primaryKey({ columns: [table.ticketId, table.userId] })],
);
export const notificationPreferences = pgTable("notification_preferences", {
  userId: text("user_id")
    .primaryKey()
    .references(() => user.id, { onDelete: "cascade" }),
  inApp: boolean("in_app").notNull().default(true),
  push: boolean("push").notNull().default(false),
  // Category flags that are absent read as enabled.
  categories: jsonb("categories").$type<Record<string, boolean>>().notNull().default({}),
  reminderAmount: integer("reminder_amount").notNull().default(1),
  reminderUnit: text("reminder_unit").notNull().default("days"),
});
export const notifications = pgTable(
  "notifications",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    eventId: bigint("event_id", { mode: "bigint" }).notNull(),
    category: text("category").notNull().default("update"),
    // Set on due-date reminders: kind, ticket, and due date, so each follower gets each at most once.
    reminderKey: text("reminder_key"),
    readAt: timestamp("read_at", { withTimezone: true }),
    // Dismissal hides the entry from the Inbox; the row and its event stay as recorded.
    dismissedAt: timestamp("dismissed_at", { withTimezone: true }),
    inbox: boolean("inbox").notNull().default(true),
    createdAt: time("created_at"),
  },
  (table) => [
    unique("notification_event_user").on(table.eventId, table.userId),
    unique("notification_reminder").on(table.userId, table.reminderKey),
  ],
);
export const pushDevices = pgTable("push_devices", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  sessionId: text("session_id")
    .notNull()
    .references(() => session.id, { onDelete: "cascade" }),
  token: text("token").notNull().unique(),
  createdAt: time("created_at"),
});
// Delivery health shared by account channels and project destinations.
const health = () => ({
  lastAttemptAt: timestamp("last_attempt_at", { withTimezone: true }),
  lastSuccessAt: timestamp("last_success_at", { withTimezone: true }),
  lastError: text("last_error"),
});
// One person's outbound channel. `settings` is sealed: it holds the endpoint and its secrets.
export const notificationChannels = pgTable(
  "notification_channels",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(),
    name: text("name").notNull(),
    settings: text("settings").notNull(),
    paused: boolean("paused").notNull().default(false),
    routes: jsonb("routes")
      .$type<{ workspaceId: string; mode: string; projectIds: string[] }[]>()
      .notNull()
      .default([]),
    version: integer("version").notNull().default(1),
    createdAt: time("created_at"),
    updatedAt: time("updated_at"),
    ...health(),
  },
  (table) => [index("notification_channel_user").on(table.userId)],
);
// A project's outbound activity feed; `events` lists the enabled destination events.
export const projectDestinations = pgTable(
  "project_destinations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(),
    name: text("name").notNull(),
    settings: text("settings").notNull(),
    paused: boolean("paused").notNull().default(false),
    events: text("events").array().notNull().default([]),
    createdBy: text("created_by").references(() => user.id, { onDelete: "set null" }),
    version: integer("version").notNull().default(1),
    createdAt: time("created_at"),
    updatedAt: time("updated_at"),
    ...health(),
  },
  (table) => [index("project_destination_project").on(table.projectId)],
);
// A project's code-host repository. `settings` is sealed: it holds the access token and the webhook
// signing secret. Webhook transitions act as `createdBy`, so they stop if that account loses access.
export const repositoryConnections = pgTable(
  "repository_connections",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    provider: text("provider").notNull(),
    repository: text("repository").notNull(),
    // A self-managed Gitea or GitLab instance; null for GitHub.
    baseUrl: text("base_url"),
    settings: text("settings").notNull(),
    paused: boolean("paused").notNull().default(false),
    commentOnLink: boolean("comment_on_link").notNull().default(false),
    transitions: jsonb("transitions").$type<Record<string, string>>().notNull().default({}),
    createdBy: text("created_by").references(() => user.id, { onDelete: "set null" }),
    version: integer("version").notNull().default(1),
    createdAt: time("created_at"),
    updatedAt: time("updated_at"),
    lastEventAt: timestamp("last_event_at", { withTimezone: true }),
    lastEventError: text("last_event_error"),
    ...health(),
  },
  (table) => [
    unique("repository_connection_name")
      .on(table.projectId, table.provider, table.baseUrl, table.repository)
      .nullsNotDistinct(),
  ],
);
// Webhook deliveries already handled, so a redelivery or replay applies nothing twice.
export const receivedWebhooks = pgTable(
  "received_webhooks",
  {
    connectionId: uuid("connection_id")
      .notNull()
      .references(() => repositoryConnections.id, { onDelete: "cascade" }),
    deliveryId: text("delivery_id").notNull(),
    event: text("event").notNull(),
    outcome: text("outcome").notNull(),
    receivedAt: time("received_at"),
  },
  (table) => [primaryKey({ columns: [table.connectionId, table.deliveryId] })],
);
// The shared outbox. Each row targets one push device, account channel, project destination, or
// repository connection; a row without a notification or event is a test message or access check.
export const deliveries = pgTable(
  "deliveries",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    notificationId: uuid("notification_id").references(() => notifications.id, {
      onDelete: "cascade",
    }),
    eventId: bigint("event_id", { mode: "bigint" }).references(() => events.id, {
      onDelete: "cascade",
    }),
    deviceId: uuid("device_id").references(() => pushDevices.id, { onDelete: "cascade" }),
    channelId: uuid("channel_id").references(() => notificationChannels.id, {
      onDelete: "cascade",
    }),
    destinationId: uuid("destination_id").references(() => projectDestinations.id, {
      onDelete: "cascade",
    }),
    connectionId: uuid("connection_id").references(() => repositoryConnections.id, {
      onDelete: "cascade",
    }),
    attempts: integer("attempts").notNull().default(0),
    availableAt: time("available_at"),
    receiptId: text("receipt_id"),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    error: text("error"),
    createdAt: time("created_at"),
  },
  (table) => [
    index("delivery_pending").on(table.finishedAt, table.availableAt),
    unique("delivery_device").on(table.notificationId, table.deviceId),
    unique("delivery_channel").on(table.notificationId, table.channelId),
    unique("delivery_destination").on(table.eventId, table.destinationId),
    unique("delivery_connection").on(table.eventId, table.connectionId),
    check(
      "delivery_one_target",
      sql`num_nonnulls(${table.deviceId}, ${table.channelId}, ${table.destinationId}, ${table.connectionId}) = 1`,
    ),
  ],
);
// A staged import into a new project; see import-operations.ts. The preview fields hold what the
// person reviewed before starting it.
export const importRuns = pgTable(
  "import_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    // The person the run writes as; every record re-checks their access.
    actorId: actor(),
    projectId: uuid("project_id").references(() => projects.id),
    key: text("key").notNull(),
    name: text("name").notNull(),
    visibility: text("visibility").notNull(),
    status: text("status").notNull(),
    counts: jsonb("counts").$type<Record<string, number>>().notNull(),
    members: jsonb("members")
      .$type<{ ref: string; name: string; email: string; userId: string | null }[]>()
      .notNull(),
    issues: jsonb("issues")
      .$type<{ severity: "error" | "warning"; code: string; message: string }[]>()
      .notNull(),
    version: integer("version").notNull().default(1),
    createdAt: time("created_at"),
    updatedAt: time("updated_at"),
  },
  (table) => [
    index("import_run_actor").on(table.workspaceId, table.actorId),
    index("import_run_status").on(table.status),
  ],
);
// One source record of an import run in write order, and its receipt: the record it became, or
// why it failed. The payload is dropped once the record is settled.
export const importRecords = pgTable(
  "import_records",
  {
    runId: uuid("run_id")
      .notNull()
      .references(() => importRuns.id, { onDelete: "cascade" }),
    seq: integer("seq").notNull(),
    kind: text("kind").notNull(),
    ref: text("ref").notNull(),
    // The source key or name, for progress and error reports.
    label: text("label").notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>(),
    status: text("status").notNull().default("pending"),
    targetId: text("target_id"),
    error: jsonb("error").$type<{ code: string; message: string }>(),
  },
  (table) => [
    primaryKey({ columns: [table.runId, table.seq] }),
    unique("import_record_ref").on(table.runId, table.kind, table.ref),
    index("import_record_pending").on(table.runId, table.status, table.seq),
  ],
);
export const views = pgTable("saved_views", {
  id: uuid("id").primaryKey().defaultRandom(),
  projectId: uuid("project_id")
    .notNull()
    .references(() => projects.id, { onDelete: "cascade" }),
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  filters: jsonb("filters").notNull(),
});
