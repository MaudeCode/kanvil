import { z } from "zod";
import { ticketFilter } from "@kanvil/contracts";
export const searchSchema = ticketFilter.extend({
  offset: z.coerce.number().int().min(0).catch(0).default(0),
});
export type TicketSearch = z.output<typeof searchSchema>;
export const ticketDensitySchema = z.enum(["compact", "comfortable"]);
export type TicketDensity = z.output<typeof ticketDensitySchema>;
export const ticketLabelDisplaySchema = z.enum(["compact", "all"]);
export type TicketLabelDisplay = z.output<typeof ticketLabelDisplaySchema>;
export const ticketGroupingSchema = z.enum(["status", "none"]);
export type TicketGrouping = z.output<typeof ticketGroupingSchema>;

export const accountSections = ["account", "appearance", "credentials", "notifications"] as const;
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

export const groupSettingsSearchSchema = z.object({
  section: z.enum(["general", "members"]).catch("general").default("general"),
});
export const projectSettingsSearchSchema = groupSettingsSearchSchema.extend({
  section: z.enum(["general", "members", "labels"]).catch("general").default("general"),
});
