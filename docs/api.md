# Kanvil interfaces

The HTTP API, MCP tools, and apps execute the same ticket operations and permission checks. HTTP schemas are available at `/api/openapi.json`.

## Authentication

Browser and native clients use Better Auth sessions with local login or configured OIDC. Public registration is closed. Initial owner setup requires `KANVIL_SETUP_TOKEN` and is available only before any account exists.

Unattended consumers use revocable, project-scoped API credentials in `Authorization: Bearer <key>`. Create credentials through an authenticated account at `POST /api/v1/credentials`, with a name, project IDs, and `read`, `write`, `claim`, or `admin` scopes. A scope never grants more access than the owning account has. The secret is returned only on creation. Delete a credential at `/api/v1/credentials/{id}` to revoke it.

## Writes and ownership

Use the ticket's current `version` as `expectedVersion` for updates. A stale version returns `409 version_conflict`; fetch the current ticket and reconcile the change.

Reuse the same UUID `requestId` when retrying a write. Reusing it with a different operation or payload returns `409 idempotency_conflict`. Bulk edits either all commit or all roll back.

Claims require an eligible ticket and current version. Successful claiming moves it to In progress. Renew an unexpired claim using its ID and the same credential. Once a ticket has been claimed, machine ticket updates and evidence submissions always require a current matching claim ID, including after release or recovery. Submit completion and evidence before releasing ownership. Human sessions can edit and reschedule work without a machine claim. Release unexpired ownership after the worker stops or completes. The ticket response exposes `canReleaseClaim` for the exact credential or client identity; sharing an account does not confer ownership. An expired claim remains blocking until a project administrator confirms the old worker stopped and explicitly recovers it; recovery does not automatically reschedule work.

Evidence records identify the submitting account and supplied commit. A reported passing outcome is an assertion by that identity, not independent verification by Kanvil.

Attachments use `upload_attachment` or the corresponding HTTP POST with `name`, `contentType`, and base64 `data`, up to 10 MB. Bytes and metadata commit together in PostgreSQL. Download content at `/api/v1/projects/{projectId}/attachments/{id}/content` using the same authorization. Filenames are metadata, never filesystem paths. Deleting an attachment deletes its bytes transactionally.

## Realtime

`GET /api/v1/snapshot?projectId=<id>` returns a consistent project snapshot and event cursor. Connect to `/api/v1/events?projectId=<id>&cursor=<cursor>` to replay committed changes and continue receiving new ones.

The SSE feed sends `change` and `checkpoint` events with durable IDs. Persist checkpoints only after processing preceding changes. Delivery is at least once: handle duplicates. Reconnect with `cursor` or `Last-Event-ID`. A `410 snapshot_required` response means fetch a new snapshot. Consumers of the unfiltered feed can obtain `/api/v1/checkpoint`, then refresh their authorized queries before subscribing from that cursor. Without a cursor, the feed starts at the current position; wait for its first checkpoint before fetching initial query results.

Events are permission-filtered and contain ticket IDs, versions, and change metadata. Fetch authoritative records through the API. Membership, account, and credential access are rechecked while streaming. Reverse proxies must preserve streaming and disable response buffering.

The portable `@kanvil/client` package supplies validated calls, one safe network retry for registered operations using the original request ID, and a parsed SSE consumer. Its `subscribe` method accepts an abort signal, processing/checkpoint callbacks, connection-state updates, and an optional fresh-snapshot callback for expired cursors. Its `watch` helper coordinates initial query refresh and expired-cursor recovery for query caches. Its query/action options work with TanStack Query without importing React into the SDK. Native clients can set `credentials: "omit"` and supply their securely stored session cookie through the headers callback. Custom `request` calls do not retry automatically, because arbitrary endpoints may lack idempotency. Actions execute immediately and are not queued for offline submission.

## Notifications

Subscribe to a ticket with `set_subscription`. Inbox entries are created atomically with subscribed ticket events and filtered by current project access when read. Human edits do not notify their author; agent credentials do notify their subscribing owner. Event data includes the ticket key/title and server-recorded `source.kind` and `source.id` for the session account or credential.

Signed-in accounts can read and update `/api/v1/notifications/preferences` with `{ "inApp": true }` using GET/PUT. Disabling Inbox notifications affects future entries; existing history is retained. Read the latest 100 entries at `/api/v1/notifications` and mark selected UUIDs read at POST `/api/v1/notifications/read` with `{ "ids": [...] }`. Credentials cannot change personal preferences or mark Inbox entries read.

## MCP

The authenticated Streamable HTTP endpoint is `/mcp`. Tool inputs use the shared HTTP contracts, including expected versions, request IDs, and claim IDs. Successful structured results have a `result` property. Business failures return an error result with a stable code.

Clients supporting custom headers can connect using a scoped API credential. Interactive clients can discover OAuth authorization through the endpoint's protected-resource metadata, then sign in and consent through Kanvil. Resource scopes are `kanvil:read`, `kanvil:write`, `kanvil:claim`, and `kanvil:admin`. The web app supplies the login and consent pages. Configure OIDC callback URLs as `/api/auth/callback/oidc` and explicitly link an existing local account from Settings before using OIDC sign-in. Protocol compatibility is tested using the official SDK, including discovery, tool listing, and writes.
