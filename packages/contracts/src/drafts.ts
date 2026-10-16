import { z } from "zod";
import { operations, ticketFields, type Ticket } from "./index.ts";

export const ticketDefaults = operations.create_ticket.input
  .omit({ projectId: true, requestId: true })
  .extend({ title: z.string().default("") })
  .parse({});

export const ticketDraftSchema = z.object({
  fields: ticketFields.extend({
    title: z.string().max(500),
    parentId: z.string().nullable(),
    dueAt: z.iso.datetime().nullable().default(null),
  }),
  version: z.number().int().positive().optional(),
});
export function createTicketDraft(ticket?: Ticket): z.output<typeof ticketDraftSchema> {
  return ticket
    ? { fields: ticketFields.strip().parse(ticket), version: ticket.version }
    : { fields: ticketDefaults };
}
export const splitTags = (value: string) =>
  value
    .split(",")
    .map((tag) => tag.trim())
    .filter(Boolean);
