import { createAuth } from "./auth.ts";
import { createEventDelivery } from "./event-delivery.ts";
import { defaultSenders } from "./outbox.ts";
import { createObjectStore } from "./adapters/object-stores.ts";
import { createTicketIndex } from "./adapters/ticket-indexes.ts";
import { createPollingJob } from "./adapters/polling-jobs.ts";
import { createGitHubDriver } from "./adapters/github.ts";
import { createGiteaDriver } from "./adapters/gitea.ts";
import { createGitLabDriver } from "./adapters/gitlab.ts";
import { createImportSources } from "./adapters/import-sources.ts";
import { createHttpSender } from "./adapters/outbound.ts";
import type {
  ImportSources,
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
  importSources: (config: Config) => ImportSources;
}
export const defaultAdapters: RuntimeAdapters = {
  auth: createAuth,
  realtime: createEventDelivery,
  senders: defaultSenders,
  objectStore: createObjectStore,
  ticketIndex: createTicketIndex,
  jobs: createPollingJob,
  repositories: (config) => ({
    github: createGitHubDriver(config.KANVIL_GITHUB_API_URL),
    gitea: createGiteaDriver(),
    gitlab: createGitLabDriver(),
  }),
  // A Jira site is the importer's own address, so private networks stay closed unless the operator
  // opens them for deliveries too. Source pages are larger than delivery answers.
  importSources: (config) =>
    createImportSources(
      createHttpSender({
        allowPrivate: config.KANVIL_DELIVERY_ALLOW_PRIVATE,
        timeout: 30_000,
        responseLimit: 16_777_216,
      }),
      config.KANVIL_LINEAR_API_URL,
    ),
};
