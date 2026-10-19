import { z } from "zod";
import {
  filterKey,
  filterList,
  searchResultTypes,
  ticketFilter,
  ticketPredicates,
  type FilterField,
} from "@kanvil/contracts";
// The ticket open in a preview sheet, and its project on pages that span projects.
const previewFields = {
  peek: z.string().min(1).max(80).optional().catch(undefined),
  peekProject: z.string().min(1).max(80).optional().catch(undefined),
};
// The day a calendar or timeline shows, as yyyy-MM-dd. Like the preview, it never changes which
// tickets a saved view matches.
const periodFields = {
  period: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional()
    .catch(undefined),
};
export const searchSchema = ticketFilter.extend({
  offset: z.coerce.number().int().min(0).catch(0).default(0),
  ...previewFields,
  ...periodFields,
});
export type TicketSearch = z.output<typeof searchSchema>;
// Two filters mean the same thing when their normalized predicates and options match, so a view
// saved with a single value still matches the same filter chosen as a one-item list.
export function filterIdentity(input: unknown) {
  const { q, parentId, archived, due, sort, order, ...values } = ticketFilter.parse(
    Object.fromEntries(
      Object.entries(z.record(z.string(), z.unknown()).parse(input)).filter(
        ([key]) => key !== "offset",
      ),
    ),
  );
  // Values within a predicate are a set: order of selection does not change the filter.
  const predicates = ticketPredicates(values).map((predicate) => ({
    ...predicate,
    values: predicate.values.toSorted(),
  }));
  return JSON.stringify([predicates, q, parentId, archived, due, sort, order]);
}
// Whether a value passes one field's include and exclude lists.
export function matchesFilter(search: TicketSearch, field: FilterField, value: string) {
  const included: string[] = filterList(search[field]),
    excluded: string[] = filterList(search[filterKey(field, "none")]);
  return (!included.length || included.includes(value)) && !excluded.includes(value);
}
export const resultsSearchSchema = z.object({
  q: z.string().trim().max(200).optional().catch(undefined),
  type: z.enum(searchResultTypes).optional().catch(undefined),
  offset: z.coerce.number().int().min(0).max(1000).catch(0).default(0),
});
// My work spans projects, so only search and ordering apply; project filters are dropped.
export const workSearchSchema = searchSchema.transform(
  ({ q, sort, order, peek, peekProject }): TicketSearch =>
    searchSchema.parse({ q, sort, order, peek, peekProject }),
);
// Inbox: which entries show and the ticket open in its preview sheet.
export const inboxSearchSchema = z.object({
  ...previewFields,
  view: z.enum(["unread", "mentions", "all"]).catch("unread").default("unread"),
});
export type InboxSearch = z.output<typeof inboxSearchSchema>;
export const ticketDensitySchema = z.enum(["compact", "comfortable"]);
export type TicketDensity = z.output<typeof ticketDensitySchema>;
export const ticketLabelDisplaySchema = z.enum(["compact", "all"]);
export type TicketLabelDisplay = z.output<typeof ticketLabelDisplaySchema>;
export const ticketGroupingSchema = z.enum(["status", "none"]);
// Project lists render as a table, a board of status lanes, a month calendar, or a timeline.
export const ticketLayoutSchema = z.enum(["list", "board", "calendar", "timeline"]);
export type TicketLayout = z.output<typeof ticketLayoutSchema>;
// My work spans projects, so it groups by due date or project instead of status.
export const workGroupingSchema = z.enum(["due", "project", "none"]);
export type TicketGrouping =
  | z.output<typeof ticketGroupingSchema>
  | z.output<typeof workGroupingSchema>;
// Ticket list columns a person can show or hide, in table order.
export const ticketColumnLabels = {
  key: "Ticket",
  labels: "Labels",
  scopes: "Scopes",
  status: "Status",
  priority: "Priority",
  difficulty: "Difficulty",
  kind: "Kind",
  assigneeId: "Assignee",
  startAt: "Start",
  dueAt: "Due",
  createdAt: "Created",
  updatedAt: "Updated",
};

// A custom field's list column; its visibility is kept with the built-in columns.
export const customFieldColumn = (fieldId: string) => `field:${fieldId}`;

export const accountSections = [
  "account",
  "appearance",
  "preferences",
  "credentials",
  "notifications",
] as const;
export const adminSections = [
  "general",
  "storage",
  "search",
  "events",
  "users",
  "workspaces",
  "authentication",
] as const;
export const authSearchSchema = z.object({
  error: z.string().optional().catch(undefined),
});
export const settingsSearchSchema = authSearchSchema.extend({
  section: z.enum(accountSections).catch("account").default("account"),
});
export const adminSearchSchema = z.object({
  section: z.enum(adminSections).catch("general").default("general"),
});

export const workspaceSections = ["general", "members", "labels"] as const;
export const projectSections = [
  "general",
  "members",
  "workflow",
  "labels",
  "fields",
  "integrations",
  "calendar",
] as const;
export const groupSettingsSearchSchema = z.object({
  section: z.enum(workspaceSections).catch("general").default("general"),
});
export const projectSettingsSearchSchema = groupSettingsSearchSchema.extend({
  section: z.enum(projectSections).catch("general").default("general"),
});
