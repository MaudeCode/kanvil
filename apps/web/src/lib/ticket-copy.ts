import type { Ticket } from "@kanvil/contracts";
import { t } from "@kanvil/contracts/i18n";
// Clipboard formats for a ticket, shared by every ticket menu.
const section = (heading: string, body: string) =>
  body.trim() ? `${heading}\n\n${body.replace(/^(?:[ \t]*\n)+/u, "").trimEnd()}` : "";
export function ticketMarkdown(
  ticket: Pick<Ticket, "key" | "title" | "description" | "acceptanceCriteria">,
) {
  return `${[
    `# ${ticket.key}: ${ticket.title}`,
    section(`## ${t("ticket.copy.description")}`, ticket.description),
    section(`## ${t("ticket.copy.acceptanceCriteria")}`, ticket.acceptanceCriteria),
  ]
    .filter(Boolean)
    .join("\n\n")}\n`;
}
const branchLength = 60;
// Only ASCII letters, digits and single hyphens, so the name is a valid git ref on any platform.
export function ticketBranch(ticket: Pick<Ticket, "key" | "title">) {
  const key = ticket.key.replace(/[^A-Za-z0-9]+/gu, "-").replace(/^-+|-+$/gu, ""),
    slug = ticket.title
      .normalize("NFKD")
      .replace(/\p{M}/gu, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/gu, "-")
      .replace(/^-+|-+$/gu, ""),
    name = slug ? `${key}-${slug}` : key;
  if (name.length <= branchLength) return name;
  const end = name.lastIndexOf("-", branchLength);
  return (end > key.length ? name.slice(0, end) : name.slice(0, branchLength)).replace(/-+$/u, "");
}
