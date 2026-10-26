import { z } from "zod";
import {
  customFieldValueSchema,
  dueDate,
  operations,
  states,
  ticketFields,
  type Ticket,
  type CustomField,
  type CustomFieldValue,
} from "./index.ts";

// Numeric text stays intact while typing (including '-' and a trailing decimal point).
// Only form submission converts it to the strict stored-value contract.
export function parseCustomFieldDraft(
  field: Pick<CustomField, "type" | "options">,
  value: CustomFieldValue | null,
) {
  const normalized =
    field.type === "number" && typeof value === "string"
      ? value.trim()
        ? Number(value)
        : null
      : value;
  return customFieldValueSchema(field).parse(normalized);
}
// A mixed selection must not present its first ticket's value as everyone's.
export function sharedTicketValue<T>(selected: Ticket[], read: (ticket: Ticket) => T) {
  const [first, ...rest] = selected.map(read),
    key = JSON.stringify(first);
  return { value: first!, mixed: rest.some((value) => JSON.stringify(value) !== key) };
}

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
    // Drafts saved before custom fields omit them.
    customFields: ticketFields.shape.customFields.default({}),
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
