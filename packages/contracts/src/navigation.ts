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

export const settingsSectionSymbols = {
  account: "user-round",
  appearance: "palette",
  preferences: "settings-2",
  credentials: "key-round",
  notifications: "bell",
  general: "settings-2",
  members: "users",
  roles: "user-cog",
  labels: "tags",
  workflow: "workflow",
  fields: "rows-3",
  integrations: "webhook",
  calendar: "calendar-sync",
  storage: "hard-drive",
  search: "search",
  events: "network",
  users: "users",
  workspaces: "building-2",
  authentication: "shield-check",
} as const satisfies Record<SettingsSection, string>;
