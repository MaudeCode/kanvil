import { z } from "zod";
import { dueDate, operations, states, ticketFields, type Ticket } from "./index.ts";

export const ticketDefaults = operations.create_ticket.input
  .omit({ projectId: true, requestId: true, uploads: true })
  .extend({
    title: z.string().default(""),
    status: z.enum(states).default("todo"),
    stateId: z.uuid().nullable().default(null),
  })
  .parse({});

export const ticketDraftSchema = z.object({
  fields: ticketFields.extend({
    title: z.string().max(500),
    parentId: z.string().nullable(),
    // Null until a state is chosen, and in drafts saved before workflows: `status` then decides.
    stateId: z.uuid().nullable().default(null),
    startAt: dueDate.nullable().default(null),
    dueAt: dueDate.nullable().default(null),
  }),
  version: z.number().int().positive().optional(),
  // The project a new ticket will be created in, when the author chose one other than where the
  // composer opened. The draft itself stays stored under the opening project.
  projectId: z.uuid().optional(),
  // Inline files staged for a new ticket; creating it claims the ones its text still embeds.
  uploads: z.array(z.uuid()).default([]),
});
export function createTicketDraft(ticket?: Ticket): z.output<typeof ticketDraftSchema> {
  return ticket
    ? {
        fields: ticketDraftSchema.shape.fields.strip().parse(ticket),
        version: ticket.version,
        uploads: [],
      }
    : { fields: ticketDefaults, uploads: [] };
}
// The fields a saved draft writes. Without a chosen state it writes its status alone, and the
// server picks that category's state.
export function draftFields(fields: unknown) {
  const { stateId, ...rest } = ticketFields
    .extend({ stateId: ticketFields.shape.stateId.nullable() })
    .parse(fields);
  return stateId ? { ...rest, stateId } : rest;
}
export const splitTags = (value: string) =>
  value
    .split(",")
    .map((tag) => tag.trim())
    .filter(Boolean);
