# Kanvil interfaces

The HTTP API, MCP tools, and apps execute the same ticket operations and permission checks. HTTP schemas are available at `/api/openapi.json`.

## Authentication

Browser and native clients use Better Auth sessions with local login or configured OIDC. Public registration is closed. Initial owner setup requires `KANVIL_SETUP_TOKEN` and is available only before any account exists.

Unattended consumers use revocable, project-scoped API credentials in `Authorization: Bearer <key>`. Create credentials through an authenticated account at `POST /api/v1/credentials`, with a name, project IDs, and `read`, `write`, `claim`, or `admin` scopes. A scope never grants more access than the owning account has. The secret is returned only on creation. Delete a credential at `/api/v1/credentials/{id}` to revoke it.

## Writes and ownership

Use the ticket's current `version` as `expectedVersion` for updates. A stale version returns `409 version_conflict`; fetch the current ticket and reconcile the change.

Reuse the same UUID `requestId` when retrying a write. Reusing it with a different operation or payload returns `409 idempotency_conflict`. Bulk edits either all commit or all roll back.

Claims require an eligible ticket and current version. Successful claiming moves it to In progress. Renew an unexpired claim using its ID and the same credential. Worker ticket updates and evidence submissions must include the active claim ID while ownership exists. Release ownership after the worker stops or completes. An expired claim remains blocking until a project administrator confirms the old worker stopped and explicitly recovers it; recovery does not automatically reschedule work.

Evidence records identify the submitting account and supplied commit. A reported passing outcome is an assertion by that identity, not independent verification by Kanvil.

## Realtime

`GET /api/v1/snapshot?projectId=<id>` returns a consistent project snapshot and event cursor. Connect to `/api/v1/events?projectId=<id>&cursor=<cursor>` to replay committed changes and continue receiving new ones.

The SSE feed sends `change` and `checkpoint` events with durable IDs. Persist checkpoints only after processing preceding changes. Delivery is at least once: handle duplicates. Reconnect with `cursor` or `Last-Event-ID`. A `410 snapshot_required` response means fetch a new snapshot. Without a cursor, the feed starts at the current position; wait for its first checkpoint before fetching initial query results.

Events are permission-filtered and contain ticket IDs, versions, and change metadata. Fetch authoritative records through the API. Membership, account, and credential access are rechecked while streaming. Reverse proxies must preserve streaming and disable response buffering.

## MCP

The authenticated Streamable HTTP endpoint is `/mcp`. Tool inputs use the shared HTTP contracts, including expected versions, request IDs, and claim IDs. Successful structured results have a `result` property. Business failures return an error result with a stable code.

Clients supporting custom headers can connect using a scoped API credential. Interactive clients can discover OAuth authorization through the endpoint's protected-resource metadata, then sign in and consent through Kanvil. Resource scopes are `kanvil:read`, `kanvil:write`, `kanvil:claim`, and `kanvil:admin`. Protocol compatibility is tested using the official SDK, including discovery, tool listing, and writes.
