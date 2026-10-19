import { createAuth } from "./auth.ts";
import { createEventDelivery } from "./event-delivery.ts";
import { defaultSenders } from "./outbox.ts";
import { createObjectStore } from "./adapters/object-stores.ts";
import { createTicketIndex } from "./adapters/ticket-indexes.ts";
import { createPollingJob } from "./adapters/polling-jobs.ts";
import { createGitHubDriver } from "./adapters/github.ts";
import type {
  JobScheduler,
  ObjectStoreFactory,
  RepositoryDrivers,
  TicketIndexFactory,
} from "./adapters/ports.ts";
import type { Config } from "./config.ts";
// All infrastructure implementations are selected here; the domain only receives application ports.
export interface RuntimeAdapters {
  auth: typeof createAuth;
  realtime: typeof createEventDelivery;
  senders: typeof defaultSenders;
  objectStore: ObjectStoreFactory;
  ticketIndex: TicketIndexFactory;
  jobs: JobScheduler;
  repositories: (config: Config) => RepositoryDrivers;
}
export const defaultAdapters: RuntimeAdapters = {
  auth: createAuth,
  realtime: createEventDelivery,
  senders: defaultSenders,
  objectStore: createObjectStore,
  ticketIndex: createTicketIndex,
  jobs: createPollingJob,
  repositories: (config) => ({ github: createGitHubDriver(config.KANVIL_GITHUB_API_URL) }),
};
