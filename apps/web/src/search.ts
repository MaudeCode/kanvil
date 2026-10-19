import { z } from "zod";
import { ticketFilter } from "@kanvil/contracts";
export const searchSchema = ticketFilter.extend({
  offset: z.coerce.number().int().min(0).catch(0).default(0),
  // The ticket open in the list's preview sheet, and its project on lists that span projects.
  peek: z.string().min(1).max(80).optional().catch(undefined),
  peekProject: z.string().min(1).max(80).optional().catch(undefined),
});
export type TicketSearch = z.output<typeof searchSchema>;
// My work spans projects, so only search and ordering apply; project filters are dropped.
export const workSearchSchema = searchSchema.transform(
  ({ q, sort, order, peek, peekProject }): TicketSearch =>
    searchSchema.parse({ q, sort, order, peek, peekProject }),
);
export const ticketDensitySchema = z.enum(["compact", "comfortable"]);
export type TicketDensity = z.output<typeof ticketDensitySchema>;
export const ticketLabelDisplaySchema = z.enum(["compact", "all"]);
export type TicketLabelDisplay = z.output<typeof ticketLabelDisplaySchema>;
export const ticketGroupingSchema = z.enum(["status", "none"]);
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
  dueAt: "Due",
  createdAt: "Created",
  updatedAt: "Updated",
};

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

export const workspaceSections = ["general", "members"] as const;
export const projectSections = ["general", "members", "labels"] as const;
export const groupSettingsSearchSchema = z.object({
  section: z.enum(workspaceSections).catch("general").default("general"),
});
export const projectSettingsSearchSchema = groupSettingsSearchSchema.extend({
  section: z.enum(projectSections).catch("general").default("general"),
});
