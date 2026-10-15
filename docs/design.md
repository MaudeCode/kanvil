# Kanvil interface

Kanvil is a working surface for people supervising agent work. The ticket title and its requirements come first; status, ownership, and readiness remain separate facts. This redesign follows [Anthropic's frontend-design guidance](https://github.com/anthropics/skills/blob/main/skills/frontend-design/SKILL.md).

## Direction

Use a precise, quiet workbench with blue selection and clear typographic hierarchy. Keep real tickets on screen instead of decorative dashboards. Desktop gets a narrow workspace rail and a generous reading surface; phones get full-width ticket rows with metadata beneath their titles.

Core light tokens: canvas `#f5f6f8`, surface `#ffffff`, ink `#202632`, secondary `#626c7c`, divider `#dce1e9`, blue `#3458c5`.

Core dark tokens: canvas `#171a21`, surface `#1e222c`, ink `#edf0f7`, secondary `#a2acc0`, divider `#343a49`, blue `#a4b8ff`.

Web typography uses self-hosted IBM Plex Sans, with its open counters and distinctive technical character. Ticket keys use the platform monospace font at a readable size. iPhone uses the native system family and Dynamic Type. Headings carry hierarchy through size and weight, not all-capital labels.

```text
Desktop                                 Phone
┌──────────┬─────────────────────────┐   ┌────────────────────────┐
│ Kanvil   │ Project       New ticket│   │ Kanvil       Appearance│
│ Projects │ Search and filters      │   │ Workspace navigation   │
│ Inbox    │ Saved views             │   │ Project      New ticket│
│          │ Key  Full title  Status │   │ Search and filters     │
│ Projects │ Key  Full title  Status │   │ □ Key                  │
│          │                         │   │   Complete ticket title│
│ Settings │                         │   │   Status Priority Level│
└──────────┴─────────────────────────┘   └────────────────────────┘

Ticket detail: title → requirements + discussion | agent state + relationships.
On narrower screens the same sections form one reading column.
```

## Reuse and checks

Extend the existing `Button`, `Status`, `Row`, form controls, table cells, and shared palette. Keep one ticket row renderer across desktop and phone layouts; preserve table semantics and selection. Reuse the existing brand treatment through a shared web component. Keep native navigation, pickers, sharing, and document selection.

The first concept retained the old wide table on phones; it failed the original requirement to read complete titles without sideways scrolling. The revised layout reflows the same cells. Avoid decorative counters, hero sections, gradients, cards, and animation that competes with work.

Validate real workspace, ticket, editor, Inbox, settings, and empty/error states in both themes. Check long titles, phone widths, zoom, keyboard focus, reduced motion, theme persistence, local/OIDC login, edits, attachments, and live conflict handling. Android runtime is outside this redesign goal.
