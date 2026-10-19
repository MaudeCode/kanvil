import { Copy, FileText, GitBranch, Link2, Type, type LucideIcon } from "lucide-react";
import type { Ticket } from "@kanvil/contracts";
import { formats, markdownFormats } from "./markdown.ts";
import { ticketBranch, ticketMarkdown } from "./ticket-copy.ts";
// One catalog for command labels and their keys. The keyboard help, the command palette and the
// ticket menus read it; `useShortcut` stays the owner of the key events.
export const actionCategories = [
  "General",
  "Ticket list",
  "Inbox",
  "Ticket",
  "Search",
  "Markdown",
] as const;
type Action = { label: string; keys: string; category: (typeof actionCategories)[number] };
export const actions = {
  palette: { label: "Go to anything", keys: "⌘ K", category: "General" },
  help: { label: "Keyboard shortcuts", keys: "?", category: "General" },
  sidebar: { label: "Toggle sidebar", keys: "⌘ B", category: "General" },
  newTicket: { label: "New ticket", keys: "C", category: "General" },
  search: { label: "Search tickets", keys: "/", category: "Ticket list" },
  highlight: {
    label: "Highlight the next or previous ticket",
    keys: "J K",
    category: "Ticket list",
  },
  open: { label: "Open the highlighted ticket", keys: "↵", category: "Ticket list" },
  preview: {
    label: "Preview the highlighted ticket beside the list",
    keys: "Space",
    category: "Ticket list",
  },
  select: { label: "Select the highlighted ticket", keys: "X", category: "Ticket list" },
  properties: {
    label: "Set status, priority, or assignee of the highlighted ticket",
    keys: "S P A",
    category: "Ticket list",
  },
  inboxHighlight: {
    label: "Highlight the next or previous notification",
    keys: "J K",
    category: "Inbox",
  },
  inboxOpen: {
    label: "Read the highlighted notification's ticket beside the Inbox",
    keys: "↵",
    category: "Inbox",
  },
  inboxRead: {
    label: "Mark the highlighted notification read or unread",
    keys: "U",
    category: "Inbox",
  },
  inboxDismiss: { label: "Dismiss the highlighted notification", keys: "⌫", category: "Inbox" },
  step: { label: "Open the next or previous ticket", keys: "J K", category: "Ticket" },
  edit: { label: "Edit ticket", keys: "E", category: "Ticket" },
  save: { label: "Save a ticket or comment", keys: "⌘ ↵", category: "Ticket" },
  results: { label: "Move through search results", keys: "J K", category: "Search" },
  insertBlock: {
    label: "Insert a table, diagram, file, or other block in the Visual editor",
    keys: "/",
    category: "Markdown",
  },
} satisfies Record<string, Action>;
// Moves of the highlighted ticket: the list's shortcuts, its ticket menu, and the project menu
// (top, up, down, bottom) read these. `menu` is the shorter menu wording.
export const moveCommands = {
  top: {
    label: "Move the highlighted ticket to the top",
    menu: "Move to top",
    keys: "⌥ ⇧ ↑",
    category: "Ticket list",
  },
  up: {
    label: "Move the highlighted ticket up",
    menu: "Move up",
    keys: "⌥ ↑",
    category: "Ticket list",
  },
  down: {
    label: "Move the highlighted ticket down",
    menu: "Move down",
    keys: "⌥ ↓",
    category: "Ticket list",
  },
  bottom: {
    label: "Move the highlighted ticket to the bottom",
    menu: "Move to bottom",
    keys: "⌥ ⇧ ↓",
    category: "Ticket list",
  },
  previous: {
    label: "Move the highlighted ticket to the previous status",
    menu: "Move to previous status",
    keys: "[",
    category: "Ticket list",
  },
  next: {
    label: "Move the highlighted ticket to the next status",
    menu: "Move to next status",
    keys: "]",
    category: "Ticket list",
  },
} satisfies Record<string, Action & { menu: string }>;
export type MoveCommand = keyof typeof moveCommands;
export const moveCommandNames: MoveCommand[] = ["top", "up", "down", "bottom", "previous", "next"];
const markdownActions = markdownFormats.flatMap((format): Action[] => {
  const spec = formats[format];
  return "shortcut" in spec
    ? [
        {
          label: "help" in spec ? spec.help : spec.label,
          keys: spec.shortcut,
          category: "Markdown",
        },
      ]
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
export const copyLink: CopyAction = {
  label: "Copy link",
  copied: "Ticket link",
  icon: Link2,
  value: (ticket) =>
    new URL(`/projects/${ticket.projectId}/tickets/${ticket.id}`, location.origin).href,
};
export const ticketCopyActions: CopyAction[] = [
  copyLink,
  {
    label: "Copy key and title",
    copied: "Ticket",
    icon: Copy,
    value: (ticket) => `${ticket.key} ${ticket.title}`,
  },
  { label: "Copy title", copied: "Title", icon: Type, value: (ticket) => ticket.title },
  { label: "Copy as Markdown", copied: "Markdown", icon: FileText, value: ticketMarkdown },
  { label: "Copy branch name", copied: "Branch name", icon: GitBranch, value: ticketBranch },
];
