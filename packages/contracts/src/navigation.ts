import { t } from "./i18n/index.ts";

// Both renderers expose the same settings destinations, with platform-native navigation.
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
export const workspaceSections = ["general", "members", "roles", "labels"] as const;
export const projectSections = [
  "general",
  "members",
  "workflow",
  "labels",
  "fields",
  "integrations",
  "calendar",
] as const;
export const ticketLayouts = ["list", "board", "calendar", "timeline"] as const;
export type TicketLayout = (typeof ticketLayouts)[number];
export type SettingsSection = (
  | typeof accountSections
  | typeof adminSections
  | typeof workspaceSections
  | typeof projectSections
)[number];
export const settingsSectionLabel = (section: SettingsSection) =>
  t(`shell.settingsNav.section.${section === "account" ? "profile" : section}`);
