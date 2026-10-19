import { Copy, FileText, GitBranch, Link2, Type, type LucideIcon } from "lucide-react";
import type { Ticket } from "@kanvil/contracts";
import { t } from "@kanvil/contracts/i18n";
import { formats, markdownFormats } from "./markdown.ts";
import { ticketBranch, ticketMarkdown } from "./ticket-copy.ts";
// One catalog for command labels and their keys. The keyboard help, the command palette and the
// ticket menus read it; `useShortcut` stays the owner of the key events. Labels read the
// interface language each time they are read.
export const actionCategories = [
  "general",
  "ticketList",
  "inbox",
  "ticket",
  "search",
  "markdown",
] as const;
type Category = (typeof actionCategories)[number];
type Action = { label: string; keys: string; category: Category };
const command = (label: () => string, keys: string, category: Category): Action => ({
  get label() {
    return label();
  },
  keys,
  category,
});
export const actions = {
  palette: command(() => t("shell.action.palette"), "⌘ K", "general"),
  help: command(() => t("shell.action.help"), "?", "general"),
  sidebar: command(() => t("shell.action.sidebar"), "⌘ B", "general"),
  newTicket: command(() => t("shell.action.newTicket"), "C", "general"),
  search: command(() => t("shell.action.search"), "/", "ticketList"),
  highlight: command(() => t("shell.action.highlight"), "J K", "ticketList"),
  open: command(() => t("shell.action.open"), "↵", "ticketList"),
  preview: command(() => t("shell.action.preview"), "Space", "ticketList"),
  select: command(() => t("shell.action.select"), "X", "ticketList"),
  properties: command(() => t("shell.action.properties"), "S P A", "ticketList"),
  inboxHighlight: command(() => t("shell.action.inboxHighlight"), "J K", "inbox"),
  inboxOpen: command(() => t("shell.action.inboxOpen"), "↵", "inbox"),
  inboxRead: command(() => t("shell.action.inboxRead"), "U", "inbox"),
  inboxDismiss: command(() => t("shell.action.inboxDismiss"), "⌫", "inbox"),
  step: command(() => t("shell.action.step"), "J K", "ticket"),
  edit: command(() => t("shell.action.edit"), "E", "ticket"),
  save: command(() => t("shell.action.save"), "⌘ ↵", "ticket"),
  results: command(() => t("shell.action.results"), "J K", "search"),
  insertBlock: command(() => t("shell.action.insertBlock"), "/", "markdown"),
};
// Moves of the highlighted ticket: the list's shortcuts, its ticket menu, and the project menu
// (top, up, down, bottom) read these. `menu` is the shorter menu wording.
const move = (
  label: () => string,
  menu: () => string,
  keys: string,
): Action & { menu: string } => ({
  get label() {
    return label();
  },
  get menu() {
    return menu();
  },
  keys,
  category: "ticketList",
});
export const moveCommands = {
  top: move(
    () => t("shell.move.top.label"),
    () => t("shell.move.top.menu"),
    "⌥ ⇧ ↑",
  ),
  up: move(
    () => t("shell.move.up.label"),
    () => t("shell.move.up.menu"),
    "⌥ ↑",
  ),
  down: move(
    () => t("shell.move.down.label"),
    () => t("shell.move.down.menu"),
    "⌥ ↓",
  ),
  bottom: move(
    () => t("shell.move.bottom.label"),
    () => t("shell.move.bottom.menu"),
    "⌥ ⇧ ↓",
  ),
  previous: move(
    () => t("shell.move.previous.label"),
    () => t("shell.move.previous.menu"),
    "[",
  ),
  next: move(
    () => t("shell.move.next.label"),
    () => t("shell.move.next.menu"),
    "]",
  ),
};
export type MoveCommand = keyof typeof moveCommands;
export const moveCommandNames: MoveCommand[] = ["top", "up", "down", "bottom", "previous", "next"];
const markdownActions = markdownFormats.flatMap((format): Action[] => {
  const spec = formats[format];
  return "shortcut" in spec
    ? [command(() => ("help" in spec ? spec.help : spec.label), spec.shortcut, "markdown")]
    : [];
});
export const shortcutGroups = actionCategories.map((category) => ({
  category,
  actions: [...Object.values(actions), ...Object.values(moveCommands), ...markdownActions].filter(
    (action) => action.category === category,
  ),
}));
export type CopySource = Pick<
  Ticket,
  "id" | "projectId" | "key" | "title" | "description" | "acceptanceCriteria"
>;
export type CopyAction = {
  label: string;
  copied: string;
  icon: LucideIcon;
  value: (ticket: CopySource) => string;
};
const copyAction = (
  label: () => string,
  copied: () => string,
  icon: LucideIcon,
  value: (ticket: CopySource) => string,
): CopyAction => ({
  get label() {
    return label();
  },
  get copied() {
    return copied();
  },
  icon,
  value,
});
export const copyLink = copyAction(
  () => t("shell.copy.link.label"),
  () => t("shell.copy.link.copied"),
  Link2,
  (ticket) => new URL(`/projects/${ticket.projectId}/tickets/${ticket.id}`, location.origin).href,
);
export const ticketCopyActions: CopyAction[] = [
  copyLink,
  copyAction(
    () => t("shell.copy.keyAndTitle.label"),
    () => t("shell.copy.keyAndTitle.copied"),
    Copy,
    (ticket) => `${ticket.key} ${ticket.title}`,
  ),
  copyAction(
    () => t("shell.copy.title.label"),
    () => t("shell.copy.title.copied"),
    Type,
    (ticket) => ticket.title,
  ),
  copyAction(
    () => t("shell.copy.markdown.label"),
    () => t("shell.copy.markdown.copied"),
    FileText,
    ticketMarkdown,
  ),
  copyAction(
    () => t("shell.copy.branch.label"),
    () => t("shell.copy.branch.copied"),
    GitBranch,
    ticketBranch,
  ),
];
