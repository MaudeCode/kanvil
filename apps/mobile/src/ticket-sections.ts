import { states, stateLabels, type Ticket, type WorkflowState } from "@kanvil/contracts";

export function sectionHeaderIndices(entries: readonly { id: string }[]) {
  return entries.flatMap((entry, index) => ("heading" in entry ? [index] : []));
}

// List and board share workflow membership, including tickets from older servers without stateId.
export function ticketSections<T extends Pick<Ticket, "id" | "status" | "stateId">>(
  tickets: readonly T[],
  workflow: readonly Pick<WorkflowState, "id" | "name" | "category">[] = [],
) {
  const groups = workflow.length
    ? workflow
    : states.map((status) => ({ id: status, name: stateLabels[status], category: status }));
  const byId = new Set(groups.map((group) => group.id));
  const buckets = new Map<string, T[]>();
  for (const ticket of tickets) {
    const key =
      ticket.stateId && byId.has(ticket.stateId)
        ? ticket.stateId
        : (groups.find((group) => group.category === ticket.status)?.id ?? ticket.status);
    const bucket = buckets.get(key) ?? [];
    bucket.push(ticket);
    buckets.set(key, bucket);
  }
  return groups.map((group) => ({ ...group, tickets: buckets.get(group.id) ?? [] }));
}

export function sectionEntries<T extends Pick<Ticket, "id">>(
  sections: readonly { id: string; name: string; tickets: readonly T[] }[],
  collapsed: ReadonlySet<string>,
  searching: boolean,
): (
  | { id: string; ticket: T }
  | { id: string; heading: string; count: number; sectionId: string }
)[] {
  return sections.flatMap((section) => {
    if (searching && !section.tickets.length) return [];
    return [
      {
        id: `section-${section.id}`,
        sectionId: section.id,
        heading: section.name,
        count: section.tickets.length,
      },
      ...(collapsed.has(section.id)
        ? []
        : section.tickets.map((ticket) => ({ id: ticket.id, ticket }))),
    ];
  });
}
