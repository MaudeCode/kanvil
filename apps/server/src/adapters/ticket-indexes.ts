import type { TicketIndexFactory, TicketIndex } from "./ports.ts";
import { createElasticsearchIndex } from "./elasticsearch.ts";
const providers: Record<string, (configuration: unknown) => TicketIndex> = {
  elasticsearch: createElasticsearchIndex,
};
export const createTicketIndex: TicketIndexFactory = (configuration) => {
  const create = providers[configuration.provider];
  if (!create) throw new Error("Unsupported ticket search provider");
  return create(configuration.config);
};
