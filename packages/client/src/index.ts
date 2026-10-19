import { createParser, type EventSourceMessage } from "eventsource-parser";
import {
  ApiError,
  errorSchema,
  eventSchema,
  streamErrorSchema,
  checkpointSchema,
  snapshotSchema,
  notificationIdsInput,
  notificationPreferencesSchema,
  notificationPreferencesInput,
  notificationReadInput,
  notificationsSchema,
  okSchema,
  type NotificationPreferencesInput,
  type ChangeEvent,
  operations,
  parseOutput,
  type Input,
  type Operation,
  type Output,
} from "@kanvil/contracts";
export { ApiError } from "@kanvil/contracts";

function randomRequestId() {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  // getRandomValues remains available on HTTP LAN origins, unlike randomUUID.
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

async function decode(response: Response): Promise<unknown> {
  const data: unknown = await response.json().catch(() => {
    throw new ApiError(response.status, "invalid_response", "Kanvil returned an invalid response");
  });
  if (!response.ok) {
    const error = errorSchema.safeParse(data);
    throw new ApiError(
      response.status,
      error.success ? error.data.error.code : "request_failed",
      error.success ? error.data.error.message : `Request failed (${response.status})`,
      error.success ? error.data.error.details : undefined,
    );
  }
  return data;
}

export function createClient(options: {
  baseUrl: string;
  headers?: () =>
    | ConstructorParameters<typeof Headers>[0]
    | Promise<ConstructorParameters<typeof Headers>[0]>;
  fetch?: typeof fetch;
  requestId?: () => string;
  credentials?: RequestInit["credentials"];
}) {
  const request = options.fetch ?? fetch;
  const endpoint = (path: string) => {
    if (!path.startsWith("/") || path.startsWith("//"))
      throw new ApiError(400, "invalid_path", "Use a relative Kanvil endpoint");
    const url = new URL(`${options.baseUrl.replace(/\/$/, "")}${path}`);
    if (url.origin !== new URL(options.baseUrl).origin)
      throw new ApiError(400, "invalid_path", "Credentials cannot be sent to another origin");
    return url;
  };
  const send = async (url: URL, init: RequestInit) => {
    try {
      return await request(url, init);
    } catch (error) {
      if (init.signal?.aborted) throw error;
      return request(url, init);
    }
  };
  const api = {
    async request<T>(
      path: string,
      schema: { parse(value: unknown): T },
      init: RequestInit = {},
    ): Promise<T> {
      const headers = new Headers(await options.headers?.());
      new Headers(init.headers).forEach((value, key) => headers.set(key, value));
      return schema.parse(
        await decode(
          await request(endpoint(path), {
            ...init,
            headers,
            credentials: options.credentials ?? "include",
          }),
        ),
      );
    },
    async call<K extends Operation>(name: K, input: Input<K>): Promise<Output<K>> {
      const spec = operations[name];
      const values: Record<string, unknown> = { ...spec.input.parse(input) };
      const path = spec.path.replace(/\{(\w+)\}/g, (_, key: string) => {
        const value = values[key];
        delete values[key];
        if (typeof value !== "string")
          throw new ApiError(400, "invalid_path", `Missing path parameter ${key}`);
        return encodeURIComponent(value);
      });
      const url = new URL(`${options.baseUrl.replace(/\/$/, "")}/api/v1${path}`);
      const headers = new Headers(await options.headers?.());
      const init: RequestInit = {
        method: spec.method,
        credentials: options.credentials ?? "include",
        headers,
      };
      if (spec.method === "GET") {
        for (const [key, value] of Object.entries(values))
          for (const item of Array.isArray(value) ? value : [value])
            if (typeof item === "string" || typeof item === "number" || typeof item === "boolean")
              url.searchParams.append(key, String(item));
      } else {
        headers.set("Content-Type", "application/json");
        values.requestId ??= (options.requestId ?? randomRequestId)();
        init.body = JSON.stringify(values);
      }
      const data = await decode(await send(url, init));
      return parseOutput(name, data);
    },
    async subscribe(subscription: {
      projectId?: string;
      cursor?: string;
      signal: AbortSignal;
      onEvent: (event: ChangeEvent) => void | Promise<void>;
      onCursor?: (cursor: string) => void | Promise<void>;
      onState?: (state: "connecting" | "connected" | "offline" | "closed") => void;
      onReset?: () => Promise<string>;
    }): Promise<void> {
      let cursor = subscription.cursor,
        backoff = 1000;
      try {
        while (!subscription.signal.aborted) {
          subscription.onState?.("connecting");
          const url = endpoint("/api/v1/events");
          if (cursor) url.searchParams.set("cursor", cursor);
          if (subscription.projectId) url.searchParams.set("projectId", subscription.projectId);
          let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
          const cancel = () => {
            void reader?.cancel().catch(() => {});
          };
          subscription.signal.addEventListener("abort", cancel, { once: true });
          try {
            const response = await request(url, {
              headers: new Headers(await options.headers?.()),
              credentials: options.credentials ?? "include",
              signal: subscription.signal,
            });
            if (response.status === 410 && subscription.onReset) {
              cursor = await subscription.onReset();
              continue;
            }
            if (!response.ok) await decode(response);
            if (!response.body)
              throw new ApiError(502, "invalid_stream", "The event stream has no body");
            reader = response.body.getReader();
            const messages: EventSourceMessage[] = [];
            const parser = createParser({
              maxBufferSize: 1_000_000,
              onEvent: (event) => messages.push(event),
              onError: (error) => {
                throw new ApiError(502, "invalid_stream", error.message);
              },
            });
            const decoder = new TextDecoder();
            while (!subscription.signal.aborted) {
              const chunk = await reader.read();
              if (chunk.done) break;
              parser.feed(decoder.decode(chunk.value, { stream: true }));
              for (const message of messages.splice(0)) {
                if (message.event === "error") {
                  const error = streamErrorSchema.parse(JSON.parse(message.data));
                  throw new ApiError(error.status, error.code, error.message);
                }
                if (message.event === "change")
                  await subscription.onEvent(eventSchema.parse(JSON.parse(message.data)));
                if (message.event === "checkpoint" || message.event === "change") {
                  subscription.onState?.("connected");
                  backoff = 1000;
                  if (message.id) {
                    await subscription.onCursor?.(message.id);
                    cursor = message.id;
                  }
                }
              }
            }
          } catch (error) {
            if (subscription.signal.aborted) return;
            if (error instanceof ApiError && error.status === 410 && subscription.onReset) {
              cursor = await subscription.onReset();
              continue;
            }
            if (error instanceof ApiError && error.status < 500) throw error;
          } finally {
            subscription.signal.removeEventListener("abort", cancel);
            await reader?.cancel().catch(() => {});
          }
          if (subscription.signal.aborted) return;
          subscription.onState?.("offline");
          await new Promise<void>((resolve) => {
            const finish = () => {
              clearTimeout(timer);
              subscription.signal.removeEventListener("abort", finish);
              resolve();
            };
            const timer = setTimeout(finish, backoff);
            subscription.signal.addEventListener("abort", finish, { once: true });
            if (subscription.signal.aborted) finish();
          });
          backoff = Math.min(backoff * 2, 30_000);
        }
      } finally {
        subscription.onState?.("closed");
      }
    },
  };
  return {
    ...api,
    notifications() {
      return {
        queryKey: ["kanvil", options.baseUrl, "notifications"] as const,
        queryFn: () => api.request("/api/v1/notifications", notificationsSchema),
      };
    },
    markNotifications(this: void, input: { ids: string[]; read?: boolean }) {
      return api.request("/api/v1/notifications/read", okSchema, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(notificationReadInput.parse(input)),
      });
    },
    // Hides entries from the Inbox; their events and provenance stay recorded.
    dismissNotifications(this: void, input: { ids: string[] }) {
      return api.request("/api/v1/notifications/dismiss", okSchema, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(notificationIdsInput.parse(input)),
      });
    },
    notificationPreferences() {
      return {
        queryKey: ["kanvil", options.baseUrl, "notification-preferences"] as const,
        queryFn: () =>
          api.request("/api/v1/notifications/preferences", notificationPreferencesSchema),
      };
    },
    setNotificationPreferences(this: void, input: NotificationPreferencesInput) {
      return api.request("/api/v1/notifications/preferences", notificationPreferencesSchema, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(notificationPreferencesInput.parse(input)),
      });
    },
    watch(
      observer: Pick<Parameters<typeof api.subscribe>[0], "projectId" | "signal" | "onState"> & {
        invalidate: (event?: ChangeEvent) => void | Promise<void>;
      },
    ) {
      let initial = true;
      return api.subscribe({
        ...(observer.projectId ? { projectId: observer.projectId } : {}),
        signal: observer.signal,
        ...(observer.onState ? { onState: observer.onState } : {}),
        onEvent: (event) => observer.invalidate(event),
        onCursor: async () => {
          if (initial) {
            initial = false;
            await observer.invalidate();
          }
        },
        onReset: async () => {
          const snapshot = observer.projectId
            ? await api.request(
                `/api/v1/snapshot?projectId=${encodeURIComponent(observer.projectId)}`,
                snapshotSchema,
              )
            : await api.request("/api/v1/checkpoint", checkpointSchema);
          await observer.invalidate();
          return snapshot.cursor;
        },
      });
    },
    query<K extends Operation>(name: K, input: Input<K>) {
      return {
        queryKey: ["kanvil", options.baseUrl, name, input] as const,
        queryFn: () => api.call(name, input),
      };
    },
    action<K extends Operation>(name: K) {
      return {
        mutationFn: (input: Input<K>) => api.call(name, input),
        networkMode: "always" as const,
        retry: false as const,
      };
    },
  };
}
export type ApiClient = ReturnType<typeof createClient>;
