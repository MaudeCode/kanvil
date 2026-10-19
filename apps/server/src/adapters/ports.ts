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
  method?: "GET" | "POST" | "PATCH" | "PUT";
  url: string;
  headers?: Record<string, string> | undefined;
  body: string;
  // Read the response body, as writes the outbox must verify need; it is discarded otherwise.
  read?: boolean;
}
export interface MailMessage {
  to: string;
  subject: string;
  text: string;
}
export interface OutboundSenders {
  push: Pick<Expo, "sendPushNotificationsAsync" | "getPushNotificationReceiptsAsync">;
  http: (request: OutboundRequest) => Promise<{ status: number; body?: string }>;
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
// An issue as the host reports it, in a webhook or in the response to a write.
export interface RemoteIssue {
  number: number;
  url: string;
  title: string;
  description: string;
  open: boolean;
  labels: string[];
  updatedAt: Date | null;
}
// A new comment on an issue; comments on pull requests are not read.
export interface RemoteComment {
  id: string;
  issue: number;
  body: string;
  author: string;
  createdAt: Date | null;
}
export interface RepositoryDelivery {
  id: string;
  event: string;
  repository: string | null;
  // Null for events Kanvil does not use, such as the setup ping.
  change: RepositoryChange | null;
  // Set for issue events and new issue comments, which issue sync reads.
  issue?: RemoteIssue | null;
  comment?: RemoteComment | null;
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
  // Issue sync writes. Each request reads its response, which `issue` turns back into the issue.
  createIssue(
    target: RepositoryTarget,
    token: string,
    content: { title: string; description: string },
  ): OutboundRequest;
  updateIssue(
    target: RepositoryTarget,
    token: string,
    number: number,
    changes: { title?: string; description?: string; open?: boolean },
  ): OutboundRequest;
  // Throws on a response it cannot read.
  issue(body: string): RemoteIssue;
}
export type RepositoryDrivers = Record<RepositoryProvider, RepositoryDriver>;
