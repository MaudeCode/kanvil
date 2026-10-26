import type { Ticket } from "./index.ts";
import type { palettes } from "./theme.ts";

// Both apps use the exact icon library already installed for the web project picker.
export const loadProjectIcons = async () => (await import("@iconify-json/lucide")).icons;
// The installed Lucide catalog keeps renamed glyphs as parent aliases.
export function iconFromLibrary(
  library: Awaited<ReturnType<typeof loadProjectIcons>> | undefined,
  name: string,
) {
  if (!library) return undefined;
  const visited = new Set<string>();
  while (!visited.has(name)) {
    const icon = library.icons[name];
    if (icon) return icon;
    visited.add(name);
    const parent = library.aliases?.[name]?.parent;
    if (!parent) return undefined;
    name = parent;
  }
  return undefined;
}

// Ticket symbols are product language. Web and native choose the same Lucide glyph and tone.
export const ticketSymbols = {
  status: {
    backlog: { icon: "circle-dashed", tone: "muted" },
    todo: { icon: "circle", tone: "muted" },
    in_progress: { icon: "circle-dot", tone: "accent" },
    in_review: { icon: "clock", tone: "warning" },
    done: { icon: "circle-check", tone: "success" },
    cancelled: { icon: "circle-x", tone: "muted" },
  },
  priority: {
    urgent: { icon: "octagon-alert", tone: "danger" },
    high: { icon: "arrow-up", tone: "warning" },
    medium: { icon: "equal", tone: "foreground" },
    low: { icon: "arrow-down", tone: "accent" },
    none: { icon: "minus", tone: "muted" },
  },
  kind: {
    feature: { icon: "sparkles", tone: "muted" },
    bug: { icon: "bug", tone: "muted" },
    chore: { icon: "wrench", tone: "muted" },
    research: { icon: "flask-conical", tone: "muted" },
    documentation: { icon: "book-open", tone: "muted" },
  },
} as const satisfies {
  [P in "status" | "priority" | "kind"]: Record<
    Ticket[P],
    { icon: string; tone: keyof typeof palettes.light }
  >;
};

export const ticketPropertyOrder = [
  "status",
  "priority",
  "assignee",
  "kind",
  "difficulty",
] as const;
export type TicketPropertyName = (typeof ticketPropertyOrder)[number];

export const difficultySegments = (level: Ticket["difficulty"]) => {
  const filled = level === "low" ? 1 : level === "med" ? 2 : level === "high" ? 3 : 0;
  return [6, 10, 14].map((height, index) => ({
    x: 1.5 + index * 5,
    y: 15 - height,
    width: 3.5,
    height,
    rx: 1,
    opacity: index < filled ? 1 : 0.2,
  }));
};

export const markdownIcons = {
  heading: "heading",
  bold: "bold",
  italic: "italic",
  link: "link",
  bullets: "list",
  numbers: "list-ordered",
  tasks: "list-checks",
  code: "square-code",
} as const;
