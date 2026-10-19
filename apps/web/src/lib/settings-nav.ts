import {
  Bell,
  Building2,
  CalendarSync,
  HardDrive,
  KeyRound,
  Network,
  Palette,
  Search,
  Settings2,
  ShieldCheck,
  Tags,
  UserRound,
  Users,
  Webhook,
  type LucideIcon,
} from "lucide-react";
import { accountSections, adminSections, projectSections, workspaceSections } from "../search.ts";
// Every settings destination, shared by the settings navigation, breadcrumbs and the palette.
type Sections<T extends readonly string[]> = Record<T[number], { label: string; icon: LucideIcon }>;
type SettingsSection = (
  | typeof accountSections
  | typeof adminSections
  | typeof projectSections
  | typeof workspaceSections
)[number];
const account: Sections<typeof accountSections> = {
  account: { label: "Profile & security", icon: UserRound },
  appearance: { label: "Appearance", icon: Palette },
  preferences: { label: "Preferences", icon: Settings2 },
  credentials: { label: "API keys", icon: KeyRound },
  notifications: { label: "Notifications", icon: Bell },
};
const workspace: Sections<typeof workspaceSections> = {
  general: { label: "General", icon: Settings2 },
  members: { label: "Members", icon: Users },
};
const project: Sections<typeof projectSections> = {
  ...workspace,
  labels: { label: "Labels", icon: Tags },
  integrations: { label: "Integrations", icon: Webhook },
  calendar: { label: "Calendar feeds", icon: CalendarSync },
};
const admin: Sections<typeof adminSections> = {
  general: { label: "General", icon: Settings2 },
  storage: { label: "File storage", icon: HardDrive },
  search: { label: "Search", icon: Search },
  events: { label: "Event delivery", icon: Network },
  users: { label: "Users", icon: Users },
  workspaces: { label: "Workspaces", icon: Building2 },
  authentication: { label: "Authentication", icon: ShieldCheck },
};
export type SettingsEntry<P = never> = {
  to: string;
  section: SettingsSection;
  label: string;
  icon?: LucideIcon;
  project?: P;
  children?: SettingsEntry<P>[];
};
export type SettingsGroup<P = never> = {
  id: "account" | "workspace" | "projects" | "admin";
  label: string;
  title: string;
  entries: SettingsEntry<P>[];
};
const entries = <T extends SettingsSection>(
  to: string,
  ids: readonly T[],
  sections: Record<T, { label: string; icon: LucideIcon }>,
) => ids.map((section) => ({ to, section, ...sections[section] }));
// Groups appear only for what the server already granted: a workspace role, the projects listed
// for this user, and the instance administrator role from the session.
export function settingsGroups<P extends { id: string; name: string }>(scope: {
  workspace?: { id: string } | undefined;
  projects: readonly P[];
  admin: boolean;
}): SettingsGroup<P>[] {
  const groups: SettingsGroup<P>[] = [
    {
      id: "account",
      label: "Account",
      title: "Settings",
      entries: entries("/settings", accountSections, account),
    },
  ];
  if (scope.workspace)
    groups.push({
      id: "workspace",
      label: "Workspace",
      title: "Workspace settings",
      entries: entries(`/workspaces/${scope.workspace.id}/settings`, workspaceSections, workspace),
    });
  if (scope.projects.length)
    groups.push({
      id: "projects",
      label: "Projects",
      title: "Project settings",
      entries: scope.projects.map((item) => {
        const to = `/projects/${item.id}/settings`;
        return {
          to,
          section: "general" as const,
          label: item.name,
          project: item,
          children: entries(to, projectSections, project),
        };
      }),
    });
  if (scope.admin)
    groups.push({
      id: "admin",
      label: "Administration",
      title: "Administration",
      entries: entries("/admin", adminSections, admin),
    });
  return groups;
}
// A project expands to its sections while one of them is open.
export const expanded = <P>(entry: SettingsEntry<P>, pathname: string): SettingsEntry<P>[] =>
  entry.children && entry.to === pathname ? entry.children : [];
export const settingsEntries = <P>(groups: SettingsGroup<P>[]) =>
  groups.flatMap((group) => group.entries.flatMap((entry) => [entry, ...(entry.children ?? [])]));
export function settingsLocation<P>(
  groups: SettingsGroup<P>[],
  pathname: string,
  section: string | undefined,
) {
  for (const group of groups) {
    const entry = settingsEntries([group]).find(
      (candidate) =>
        candidate.to === pathname && candidate.section === section && !candidate.children,
    );
    if (entry) return { group, entry };
  }
  return undefined;
}
export const settingsHref = (entry: SettingsEntry<unknown>) =>
  `${entry.to}?section=${entry.section}`;
