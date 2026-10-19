import { Copy, FileText, GitBranch, Link2, Type, type LucideIcon } from "lucide-react";
import type { Ticket } from "@kanvil/contracts";
import { formats, markdownFormats } from "./markdown.ts";
import { ticketBranch, ticketMarkdown } from "./ticket-copy.ts";
// One catalog for command labels and their keys. The keyboard help, the command palette and the
// ticket menus read it; `useShortcut` stays the owner of the key events.
export const actionCategories = ["General", "Ticket list", "Ticket", "Markdown"] as const;
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
  step: { label: "Open the next or previous ticket", keys: "J K", category: "Ticket" },
  edit: { label: "Edit ticket", keys: "E", category: "Ticket" },
  save: { label: "Save a ticket or comment", keys: "⌘ ↵", category: "Ticket" },
} satisfies Record<string, Action>;
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
  actions: [...Object.values(actions), ...markdownActions].filter(
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
