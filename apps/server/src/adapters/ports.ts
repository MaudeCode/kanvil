import type { Expo } from "expo-server-sdk";
import type { RepositoryProvider, RepositoryTrigger, remoteKinds } from "@kanvil/contracts";
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
  find(instanceId: string, projectIds: readonly string[], query: string): Promise<string[]>;
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
// Outbound delivery transports. The outbox owns retries, authorization, and health.
export interface OutboundRequest {
  // POST unless set.
  method?: "GET" | "POST";
  url: string;
  headers?: Record<string, string> | undefined;
  body: string;
}
export interface MailMessage {
  to: string;
  subject: string;
  text: string;
}
export interface OutboundSenders {
  push: Pick<Expo, "sendPushNotificationsAsync" | "getPushNotificationReceiptsAsync">;
  http: (request: OutboundRequest) => Promise<{ status: number }>;
  // Absent when the instance has no SMTP relay.
  mail?: (message: MailMessage) => Promise<void>;
}
// Code-host repositories. A driver checks webhook signatures, reads deliveries into provider-neutral
// changes, and builds the API requests the outbox sends; it never writes Kanvil state itself.
export interface RepositoryChange {
  kind: (typeof remoteKinds)[number];
  url: string;
  title: string;
  // The issue or pull-request number that comments go to; null for a branch.
  number: number | null;
  // open, draft, merged, or closed for pull requests and issues; active or deleted for branches.
  state: string;
  trigger: RepositoryTrigger | null;
  // Branch names and titles that may name tickets.
  references: string[];
  // When the host recorded this state; null when the payload has none and receipt time counts.
  occurredAt: Date | null;
  // Whether this change may create a link; a deleted branch only updates an existing one.
  creates: boolean;
}
export interface RepositoryDelivery {
  id: string;
  event: string;
  repository: string | null;
  // Null for events Kanvil does not use, such as the setup ping.
  change: RepositoryChange | null;
}
// The repository a request goes to: its path on the host and, for a self-managed host, the instance.
export interface RepositoryTarget {
  repository: string;
  baseUrl: string | null;
}
export interface RepositoryDriver {
  signed(secret: string, headers: Headers, body: string): boolean;
  // Throws on a payload it cannot read.
  read(headers: Headers, body: string): RepositoryDelivery;
  access(target: RepositoryTarget, token: string): OutboundRequest;
  // Comments on an issue or pull request; some hosts take them on separate endpoints.
  comment(
    target: RepositoryTarget,
    token: string,
    item: { kind: RepositoryChange["kind"]; number: number },
    text: string,
  ): OutboundRequest;
}
export type RepositoryDrivers = Record<RepositoryProvider, RepositoryDriver>;
