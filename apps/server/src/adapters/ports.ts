export interface ObjectStore {
  keyFor(id: string): string;
  put(key: string, bytes: Uint8Array, contentType: string): Promise<void>;
  get(key: string, maxBytes: number): Promise<Uint8Array>;
  remove(key: string): Promise<void>;
  close(): void;
}
export interface ObjectStoreConfiguration {
  provider: string;
  config: unknown;
}
export type ObjectStoreFactory = (configuration: ObjectStoreConfiguration) => ObjectStore;
export interface TicketIndexDocument {
  id: string;
  projectId: string;
  key: string;
  title: string;
  description: string;
  acceptanceCriteria: string;
  labels: string[];
  scopes: string[];
}
export interface TicketIndex {
  initialize(instanceId: string): Promise<void>;
  reset(instanceId: string): Promise<void>;
  write(instanceId: string, documents: TicketIndexDocument[], deletedIds?: string[]): Promise<void>;
  find(instanceId: string, projectId: string, query: string): Promise<string[]>;
  probe(instanceId: string): Promise<void>;
}
export type TicketIndexFactory = (configuration: {
  provider: string;
  config: unknown;
}) => TicketIndex;
export interface BackgroundJob<T> {
  trigger: () => Promise<T>;
  close: () => Promise<void>;
}
export type JobScheduler = <T>(
  name: string,
  intervalMs: number,
  run: () => Promise<T>,
) => BackgroundJob<T>;

// A wakeup carries no ticket content. Consumers read authorized, durable records from PostgreSQL.
export interface WakeupBus {
  ready: () => boolean;
  publish: (message: string) => Promise<void>;
  close: () => Promise<void>;
}
export type WakeupBusFactory = (
  configuration: { provider: string; config: unknown },
  receive: (message: string) => void,
  changed: () => void,
) => Promise<WakeupBus>;
