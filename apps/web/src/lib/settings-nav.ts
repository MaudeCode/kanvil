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
import { settingsSectionLabel, settingsSectionSymbols } from "@kanvil/contracts/navigation";
import { accountSections, adminSections, projectSections, workspaceSections } from "../search.ts";
// Every settings destination, shared by the settings navigation, breadcrumbs and the palette.
// Labels read the interface language each time they are read.
type Section = { label: string; icon: LucideIcon };
type SettingsSection = (
  | typeof accountSections
  | typeof adminSections
  | typeof projectSections
  | typeof workspaceSections
)[number];
const glyphs = {
  "user-round": UserRound,
  palette: Palette,
  "settings-2": Settings2,
  "key-round": KeyRound,
  bell: Bell,
  users: Users,
  "user-cog": UserCog,
  tags: Tags,
  workflow: Workflow,
  "rows-3": Rows3,
  webhook: Webhook,
  "calendar-sync": CalendarSync,
  "hard-drive": HardDrive,
  search: Search,
  network: Network,
  "building-2": Building2,
  "shield-check": ShieldCheck,
};
const sectionOf = (section: SettingsSection): Section => ({
  get label() {
    return settingsSectionLabel(section);
  },
  icon: glyphs[settingsSectionSymbols[section]],
});
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
const entries = <T extends SettingsSection>(to: string, ids: readonly T[]) =>
  ids.map((section) => ({ to, section, ...sectionOf(section) }));
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
      entries: entries("/settings", accountSections),
    },
  ];
  if (scope.workspace)
    groups.push({
      id: "workspace",
      label: t("shell.settingsNav.workspace"),
      title: t("shell.settingsNav.workspaceSettings"),
      entries: entries(`/workspaces/${scope.workspace.id}/settings`, workspaceSections),
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
          children: entries(to, projectSections),
        };
      }),
    });
  if (scope.admin)
    groups.push({
      id: "admin",
      label: t("shell.settingsNav.administration"),
      title: t("shell.settingsNav.administration"),
      entries: entries("/admin", adminSections),
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
