import { createAuth } from "./auth.ts";
import { createEventDelivery } from "./event-delivery.ts";
import { createPushDelivery } from "./push.ts";
import { createObjectStore } from "./adapters/object-stores.ts";
import { createTicketIndex } from "./adapters/ticket-indexes.ts";
import { createPollingJob } from "./adapters/polling-jobs.ts";
import type { JobScheduler, ObjectStoreFactory, TicketIndexFactory } from "./adapters/ports.ts";
// All infrastructure implementations are selected here; the domain only receives application ports.
export interface RuntimeAdapters {
  auth: typeof createAuth;
  realtime: typeof createEventDelivery;
  push: typeof createPushDelivery;
  objectStore: ObjectStoreFactory;
  ticketIndex: TicketIndexFactory;
  jobs: JobScheduler;
}
export const defaultAdapters: RuntimeAdapters = {
  auth: createAuth,
  realtime: createEventDelivery,
  push: createPushDelivery,
  objectStore: createObjectStore,
  ticketIndex: createTicketIndex,
  jobs: createPollingJob,
};
