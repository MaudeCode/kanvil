import { z } from "zod";
import { ticketFilter } from "@kanvil/contracts";
export const searchSchema = ticketFilter.extend({
  offset: z.coerce.number().int().min(0).catch(0).default(0),
});
export type TicketSearch = z.output<typeof searchSchema>;
