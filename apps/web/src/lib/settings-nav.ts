import {
  Bell,
  Building2,
  CalendarSync,
  HardDrive,
  KeyRound,
  Network,
  Palette,
  Rows3,
  Search,
  Settings2,
  ShieldCheck,
  Tags,
  UserCog,
  UserRound,
  Users,
  Webhook,
  Workflow,
  type LucideIcon,
} from "lucide-react";
import { t } from "@kanvil/contracts/i18n";
import { accountSections, adminSections, projectSections, workspaceSections } from "../search.ts";
// Every settings destination, shared by the settings navigation, breadcrumbs and the palette.
// Labels read the interface language each time they are read.
type Section = { label: string; icon: LucideIcon };
type Sections<T extends readonly string[]> = Record<T[number], Section>;
type SettingsSection = (
  | typeof accountSections
  | typeof adminSections
  | typeof projectSections
  | typeof workspaceSections
)[number];
const sectionOf = (label: () => string, icon: LucideIcon): Section => ({
  get label() {
    return label();
  },
  icon,
});
const account: Sections<typeof accountSections> = {
  account: sectionOf(() => t("shell.settingsNav.section.profile"), UserRound),
  appearance: sectionOf(() => t("shell.settingsNav.section.appearance"), Palette),
  preferences: sectionOf(() => t("shell.settingsNav.section.preferences"), Settings2),
  credentials: sectionOf(() => t("shell.settingsNav.section.credentials"), KeyRound),
  notifications: sectionOf(() => t("shell.settingsNav.section.notifications"), Bell),
};
const workspace: Sections<typeof workspaceSections> = {
  general: sectionOf(() => t("shell.settingsNav.section.general"), Settings2),
  members: sectionOf(() => t("shell.settingsNav.section.members"), Users),
  roles: sectionOf(() => t("shell.settingsNav.section.roles"), UserCog),
  labels: sectionOf(() => t("shell.settingsNav.section.labels"), Tags),
};
const project: Sections<typeof projectSections> = {
  general: workspace.general,
  members: workspace.members,
  labels: workspace.labels,
  workflow: sectionOf(() => t("shell.settingsNav.section.workflow"), Workflow),
  fields: sectionOf(() => t("shell.settingsNav.section.fields"), Rows3),
  integrations: sectionOf(() => t("shell.settingsNav.section.integrations"), Webhook),
  calendar: sectionOf(() => t("shell.settingsNav.section.calendar"), CalendarSync),
};
const admin: Sections<typeof adminSections> = {
  general: workspace.general,
  storage: sectionOf(() => t("shell.settingsNav.section.storage"), HardDrive),
  search: sectionOf(() => t("shell.settingsNav.section.search"), Search),
  events: sectionOf(() => t("shell.settingsNav.section.events"), Network),
  users: sectionOf(() => t("shell.settingsNav.section.users"), Users),
  workspaces: sectionOf(() => t("shell.settingsNav.section.workspaces"), Building2),
  authentication: sectionOf(() => t("shell.settingsNav.section.authentication"), ShieldCheck),
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
  sections: Record<T, Section>,
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
      label: t("shell.settingsNav.account"),
      title: t("shell.settingsNav.settings"),
      entries: entries("/settings", accountSections, account),
    },
  ];
  if (scope.workspace)
    groups.push({
      id: "workspace",
      label: t("shell.settingsNav.workspace"),
      title: t("shell.settingsNav.workspaceSettings"),
      entries: entries(`/workspaces/${scope.workspace.id}/settings`, workspaceSections, workspace),
    });
  if (scope.projects.length)
    groups.push({
      id: "projects",
      label: t("shell.settingsNav.projects"),
      title: t("shell.settingsNav.projectSettings"),
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
      label: t("shell.settingsNav.administration"),
      title: t("shell.settingsNav.administration"),
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
