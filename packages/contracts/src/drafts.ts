import { z } from "zod";
import { dueDate, operations, ticketFields, type Ticket } from "./index.ts";

export const ticketDefaults = operations.create_ticket.input
  .omit({ projectId: true, requestId: true })
  .extend({ title: z.string().default("") })
  .parse({});

export const ticketDraftSchema = z.object({
  fields: ticketFields.extend({
    title: z.string().max(500),
    parentId: z.string().nullable(),
    dueAt: dueDate.nullable().default(null),
  }),
  version: z.number().int().positive().optional(),
  // The project a new ticket will be created in, when the author chose one other than where the
  // composer opened. The draft itself stays stored under the opening project.
  projectId: z.uuid().optional(),
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
