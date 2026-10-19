# Kanvil interfaces

The HTTP API, MCP tools, and apps execute the same ticket operations and permission checks. HTTP schemas are available at `/api/openapi.json`.

Runnable MCP and durable realtime examples, plus the worker ownership sequence, are in [examples](../examples/README.md).

## Authentication

Browser and native clients use Better Auth sessions with local login or configured OIDC. Public registration is closed. Initial owner setup requires `KANVIL_SETUP_TOKEN` and is available only before any account exists.

Unattended consumers use revocable, project-scoped API credentials in `Authorization: Bearer <key>`. Create credentials through an authenticated account at `POST /api/v1/credentials`, with a name, project IDs, and `read`, `write`, `claim`, or `admin` scopes. A scope never grants more access than the owning account has. The secret is returned only on creation. Delete a credential at `/api/v1/credentials/{id}` to revoke it.

## Writes and ownership

Use the ticket's current `version` as `expectedVersion` for updates. A stale version returns `409 version_conflict` with `details.currentVersion`; fetch the current record and reconcile the change.

Reuse the same UUID `requestId` when retrying a write. Reusing it with a different operation or payload returns `409 idempotency_conflict`. Bulk edits either all commit or all roll back, and publish one `ticket.updated` event per ticket with consecutive IDs in a single batch.

Signed-in sessions may make `KANVIL_SESSION_WRITE_LIMIT` write requests per minute (120 by default) to `/api/v1`, and MCP OAuth clients get the same budget for write tools; exceeding it returns `429 rate_limited` with a `Retry-After` header. API keys keep the rate limit applied by the authentication layer. The counter is per application process.

Claims require an eligible ticket and current version. Successful claiming moves it to In progress. Renew an unexpired claim using its ID and the same credential. Once a ticket has been claimed, machine ticket updates and evidence submissions always require a current matching claim ID, including after release or recovery. Submit completion and evidence before releasing ownership. Human sessions can edit and reschedule work without a machine claim. Release unexpired ownership after the worker stops or completes. The ticket response exposes `canReleaseClaim` for the exact credential or client identity; sharing an account does not confer ownership. An expired claim remains blocking until a project administrator confirms the old worker stopped and explicitly recovers it; recovery does not automatically reschedule work.

Evidence records identify the submitting account and supplied commit. A reported passing outcome is an assertion by that identity, not independent verification by Kanvil.

Attachments use `upload_attachment` or the corresponding HTTP POST with `name`, `contentType`, and base64 `data`, up to 10 MB. Bytes and metadata commit together in PostgreSQL. Download content at `/api/v1/projects/{projectId}/attachments/{id}/content` using the same authorization. Filenames are metadata, never filesystem paths. Deleting an attachment deletes its bytes transactionally.

Tickets carry an optional `dueAt` ISO timestamp. `list_tickets` accepts `due` as `overdue` (past due), `today` (due within the next 24 hours), `week` (due within the next 7 days), `scheduled`, or `none`; the first three apply to open tickets only and use the database clock and `sort: "due"` for soonest first with undated tickets last. Other sorts: `priority` (default), `updated`, `created`, `title`, `labels`, `number`, `status`, `difficulty`, `kind`, and `assignee`. Each has a natural direction (newest first for `updated` and `created`, ascending otherwise); pass `order: "asc"` or `"desc"` to override it. Ties break by ticket number, and null values sort last in both directions. The `assigneeId` filter takes a user id or `none` for unassigned tickets. `list_projects` returns `openTickets` and `overdueTickets` per project (unarchived tickets not done or cancelled; overdue means a due date in the past) and the caller's effective `role` there (`reader`, `writer`, or `admin`; always `admin` for instance administrators).

`search_tickets` (`GET /api/v1/tickets/search?q=...`) finds unarchived tickets by exact key or text across every project the caller can read, optionally limited to one `workspaceId`, returning each ticket with its project `id`, `key`, and `name`. Exact key matches sort first.

Use `list_tickets` with `parentId` set to a parent UUID or ticket key to page through child tickets. Set `archived: "include"` to include archived children. Set `relatedTo` to a ticket UUID or key to page through the tickets linked to it by any relationship, in either direction. `list_relations` also returns the current source/target keys and full titles, so consumers can show readable dependency context without separate lookups.

`list_ticket_labels` (`GET /api/v1/projects/{projectId}/labels`) returns distinct label names and ticket counts for the whole authorized project. Its `archived` option matches ticket listing. The `label` ticket filter matches an exact label; combine it with other filters or saved views. `sort: "labels"` orders by the first label alphabetically, ignoring case and label-array order, followed by ticket number. Tickets without labels come last.

`list_project_labels` (`GET /api/v1/projects/{projectId}/labels/catalog`) returns reusable definitions with stable IDs, names, colors, versions, and usage counts including archived tickets. Unused definitions remain available. Existing ticket label names are backfilled during upgrade; new freeform labels from ticket writes register automatically with gray as their color. Ticket payloads continue to use label-name arrays.

Project administrators can `create_project_label` (`POST .../labels`), `update_project_label` (`PATCH .../labels/{labelId}`), and `delete_project_label` (`DELETE .../labels/{labelId}`) through HTTP or MCP. Creation takes `name` and optional `color`; updates take `name`, `color`, and `expectedVersion`; deletion takes `expectedVersion`. Renames update every affected ticket, including archived tickets, and saved-view label filters. Deletion removes the label from tickets and removes its filter from saved views, retaining other filters. These changes commit atomically, preserve ticket write/claim checks, increment affected ticket versions, and emit normal `ticket.updated` events plus `label.created`, `label.updated`, or `label.deleted`. Recoloring emits a label event without changing ticket versions. Realtime consumers can refresh the label catalog on label events.

Label colors are a preset name (`default`, `red`, `orange`, `amber`, `yellow`, `lime`, `green`, `emerald`, `teal`, `cyan`, `sky`, `blue`, `indigo`, `violet`, `purple`, `fuchsia`, `pink`, `rose`, `gray`) or a custom `#rrggbb` hex value. Saving a label with a hex value adds it to the site-wide custom palette; `list_label_colors` (`GET /api/v1/label-colors`) returns that palette newest first and `remove_label_color` (`POST /api/v1/label-colors/remove`) drops an entry without recoloring the labels that use it; only an instance administrator or the person who added the color may remove it, and the removal publishes `label.color_removed` to every project the caller can write. Saving a label with a color it already had does not re-add a removed color.

`add_relation` accepts `blocks`, `related`, `duplicate`, `causes`, `clones`, `implements`, or `reviews`. `direction` defaults to `outgoing` for existing clients. Use `incoming` to express the inverse from the current ticket: for example, `{ticketId: "<current>", targetId: "<blocker>", type: "blocks", direction: "incoming"}` means the current ticket is blocked by the selected ticket. The server stores a single canonical edge, checks project access on both tickets, and rejects dependency cycles in either direction. Related links are symmetric. Only blocking dependencies add readiness blockers; duplicate sources remain ineligible for agent work. Other link types are informational. Parent/child hierarchy continues to use `parentId` rather than a second relationship edge.

## Realtime

`GET /api/v1/snapshot?projectId=<id>` returns a consistent project snapshot and event cursor. Connect to `/api/v1/events?projectId=<id>&cursor=<cursor>` to replay committed changes and continue receiving new ones.

The SSE feed sends `change` and `checkpoint` events with durable IDs. Persist checkpoints only after processing preceding changes. Delivery is at least once: handle duplicates. Reconnect with `cursor` or `Last-Event-ID`. A `410 snapshot_required` response means fetch a new snapshot. Consumers of the unfiltered feed can obtain `/api/v1/checkpoint`, then refresh their authorized queries before subscribing from that cursor. Without a cursor, the feed starts at the current position; wait for its first checkpoint before fetching initial query results.

Events are permission-filtered and contain ticket IDs, versions, and change metadata. Fetch authoritative records through the API. Membership, account, and credential access are rechecked while streaming. An SSE connection consumes one API request; internal frames and heartbeats do not consume more of the credential's rate allowance. Reverse proxies must preserve streaming and disable response buffering.

The portable `@kanvil/client` package supplies validated calls, one safe network retry for registered operations using the original request ID, and a parsed SSE consumer. Its `subscribe` method accepts an abort signal, processing/checkpoint callbacks, connection-state updates, and an optional fresh-snapshot callback for expired cursors. Its `watch` helper coordinates initial query refresh and expired-cursor recovery for query caches. Its query/action options work with TanStack Query without importing React into the SDK. Native clients can set `credentials: "omit"` and supply their securely stored session cookie through the headers callback. Custom `request` calls do not retry automatically, because arbitrary endpoints may lack idempotency. Actions execute immediately and are not queued for offline submission.

## Notifications

Subscribe to a ticket with `set_subscription`. Inbox entries are created atomically with subscribed ticket events and filtered by current project access when read. Human edits do not notify their author; agent credentials do notify their subscribing owner. Event data includes the ticket key/title and server-recorded `source.kind` and `source.id` for the session account or credential.

Signed-in accounts can read and update `/api/v1/notifications/preferences` with `{ "inApp": true, "push": false }` using GET/PUT. Disabling Inbox notifications affects future entries; existing history is retained. Read the latest 100 entries at `/api/v1/notifications` and mark selected UUIDs read at POST `/api/v1/notifications/read` with `{ "ids": [...] }`. Credentials cannot change personal preferences or mark Inbox entries read.

Omitting `push` from a preference update retains its current value. Explicitly unsubscribing cancels queued push notices for that ticket. Ticket deletion preserves already queued notices, including the deletion event, while account and project access still apply.

When `/api/v1/info` reports `push: true`, account sessions can POST or DELETE `/api/v1/notifications/device` with `{ "token": "ExpoPushToken[...]" }`. Registration is tied to the current login session. Reassigning a device token to another account removes its previous account's pending deliveries. Push preferences apply to all registered devices; unregistering affects only the supplied device. Push payloads contain `server`, `projectId`, `ticketId`, and `notificationId`; native routing accepts only the currently connected server. Tokens and server-held Expo credentials are never returned by a listing endpoint.

## MCP

The authenticated Streamable HTTP endpoint is `/mcp`. Tool inputs use the shared HTTP contracts, including expected versions, request IDs, and claim IDs. Successful structured results have a `result` property. Business failures return an error result with a stable code.

Clients supporting custom headers can connect using a scoped API credential. Interactive clients can discover OAuth authorization through the endpoint's protected-resource metadata, then sign in and consent through Kanvil. Resource scopes are `kanvil:read`, `kanvil:write`, `kanvil:claim`, and `kanvil:admin`. The web app supplies the login and consent pages. Configure OIDC callback URLs as `/api/auth/callback/oidc` and explicitly link an existing local account from Settings before using OIDC sign-in. Protocol compatibility is tested using the official SDK, including discovery, tool listing, and writes.

## Instance administration and profile photos

Human sessions use `GET/PATCH /api/v1/admin/instance` for versioned instance settings, and `POST /api/v1/admin/{storage,search,broker}/test` to verify an integration. These routes require the instance admin role; API keys and MCP tokens cannot configure the instance. `POST /api/v1/admin/search/reindex` queues a rebuild, and `POST /api/v1/admin/storage/cleanup` collects unused objects. Secret fields are write-only; omitted broker settings preserve the current provider for older callers. See [infrastructure](infrastructure.md) for schemas, configuration precedence, and recovery rules.

A signed-in user uploads their own photo with `POST /api/v1/profile/photo` using `{data: base64, contentType}` and removes it with `DELETE` on the same path. The response is `{image: string | null}`. Images are limited to 512,000 bytes and PNG/JPEG/WebP. `GET /api/v1/users/{id}/photo` requires a human session. Attachments and profile photos share the same configured storage service. These interfaces and their schemas appear in `/api/openapi.json`.

## Workspaces and project icons

The shared operation registry includes `list_workspaces`, `create_workspace`, `update_workspace`, `list_workspace_members`, and `set_workspace_member`; each is available through HTTP and MCP. See [workspace access](workspaces.md) for inheritance, private projects, guests, and safe upgrades. `list_projects` accepts an optional `workspaceId`; create projects with an explicit workspace and `visibility: "workspace" | "private"`. Older calls that omit a workspace choose a writable workspace, creating a personal one when necessary. Ticket prefixes remain unique across the instance.

`get_project` reads workspace and appearance metadata. `set_project_icon` accepts `expectedVersion` and `icon`: `{kind:"library", name:"rocket", color:"purple"}`, `{kind:"image", contentType:"image/png", data:base64}`, or `null` to reset. Library names are checked against the bundled Lucide collection. Image limits and supported formats match profile photos. `GET /api/v1/projects/{projectId}/icon` checks project read access, including project-bound API keys. Uploaded icons share blob storage, orphan cleanup protection, and backup requirements with attachments and profile photos.

## Account administration

Human instance administrators can search `GET /api/v1/admin/users` with `q` (name or email), `role` (`all`, `user`, `admin`), `status` (`all`, `active`, `disabled`), `limit`, and `offset`. Results contain display data and counts, never passwords or session tokens. `GET /api/v1/admin/users/{id}` adds workspace memberships, direct project grants, sign-in provider names, and an active-session count.

The web app uses Better Auth's existing account creation, profile, role, suspension, and session-management operations. Administrative role/status mutations share a serialized guard that preserves an active instance administrator, including the alternative user-update endpoint. `POST /api/v1/admin/users/{id}/password` accepts `{password}` (12–128 characters), sets a local password through the auth library, and revokes existing sessions. Password changes through the auth plugin's administrative endpoint also revoke sessions. Password reset keeps API keys; disabling the account blocks API-key access as well as sign-in.

The web client discards persisted administrator data when the account's instance role changes. Personal settings, workspace administration, and instance administration have separate navigation and server-side permissions.

`GET /api/v1/info` includes `authentication: { emailPasswordEnabled, ssoAutoProvision }`, also returned by the admin instance endpoint. Older responses default to `true` and `false` in the shared contract. `PATCH /api/v1/admin/instance` accepts an optional `authentication` object alongside the existing versioned settings. Omitting it preserves both policies. Disabled password sign-in returns `password_sign_in_disabled` from the direct auth endpoint; password reset does not change the policy. Disabling passwords requires a configured provider and the acting administrator's OIDC binding for that issuer and client ID, otherwise `409 oidc_required` or `409 oidc_binding_required` leaves settings unchanged. SSO creation requires a verified email and enabled provisioning; existing unlinked local emails require explicit linking.

`POST /api/auth/unlink-account` also returns `409 oidc_binding_required` if it would remove a user's last binding for the configured provider while password sign-in is disabled. This shares the settings write lock so a concurrent password-policy change cannot race the unlink. Unlinking remains available when another matching binding or password sign-in is available.
