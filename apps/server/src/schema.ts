import {
  bigint,
  customType,
  boolean,
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
export const projects = pgTable("projects", {
  id: uuid("id").primaryKey().defaultRandom(),
  key: text("key").notNull().unique(),
  name: text("name").notNull(),
  description: text("description").notNull().default(""),
  nextNumber: integer("next_number").notNull().default(1),
  version: integer("version").notNull().default(1),
  createdAt: time("created_at"),
  updatedAt: time("updated_at"),
});
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
    status: text("status").notNull().default("todo"),
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
    archived: boolean("archived").notNull().default(false),
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
  ],
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
    actorId: actor(),
    type: text("type").notNull(),
    data: jsonb("data").$type<Record<string, unknown>>().notNull(),
    createdAt: time("created_at"),
  },
  (table) => [
    index("event_project_cursor").on(table.projectId, table.id),
    index("event_ticket").on(table.ticketId, table.id),
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
export const attachments = pgTable("attachments", {
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
});
export const notifications = pgTable("notifications", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  projectId: uuid("project_id")
    .notNull()
    .references(() => projects.id, { onDelete: "cascade" }),
  eventId: bigint("event_id", { mode: "bigint" }).notNull(),
  readAt: timestamp("read_at", { withTimezone: true }),
  inbox: boolean("inbox").notNull().default(true),
  createdAt: time("created_at"),
});
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
export const pushDeliveries = pgTable(
  "push_deliveries",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    notificationId: uuid("notification_id")
      .notNull()
      .references(() => notifications.id, { onDelete: "cascade" }),
    deviceId: uuid("device_id")
      .notNull()
      .references(() => pushDevices.id, { onDelete: "cascade" }),
    attempts: integer("attempts").notNull().default(0),
    availableAt: time("available_at"),
    receiptId: text("receipt_id"),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    error: text("error"),
  },
  (table) => [
    index("push_pending_idx").on(table.finishedAt, table.availableAt),
    unique().on(table.notificationId, table.deviceId),
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
