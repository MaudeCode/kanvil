# Reference consumers

Run these from a checkout with the repository's Node/pnpm versions and installed dependencies. They use Kanvil's public interfaces and do not require changes in an agent runner.

Create a project-scoped credential in Settings with `read` permission. Set `KANVIL_API_KEY` privately in the environment and `KANVIL_URL` to the server origin. The commands also load a checkout's `.env`, without overriding existing environment variables. Credentials are never written into the mirror or printed.

## Durable realtime mirror

```sh
pnpm example:mirror --project KAN --output data/kanvil-mirror.json
```

The file contains the project snapshot and its event cursor, plus the server/project identity. New snapshots replace the file atomically with mode 600. Keep one writer per output file. Restarting resumes from the stored cursor; an expired cursor triggers a fresh snapshot. Changes that are already included in a newer snapshot are ignored. The `data/` directory is gitignored.

The example deliberately fetches a full consistent snapshot when changes arrive. For a large project, apply events to an incremental projection and persist its data and processed cursor together. Keep the same snapshot recovery and at-least-once duplicate handling. A cursor alone is insufficient if the corresponding projected state was not committed.

Stop with Ctrl-C or SIGTERM. The mirror is a local reading cache; writes remain explicit API/MCP operations.

## MCP connection

```sh
pnpm example:mcp --project KAN
```

This read-only example uses the official MCP SDK and Streamable HTTP at `/mcp`. It lists authorized projects, the first page of tickets, and eligibility with explicit reasons. It validates structured results with Kanvil's operation contracts. List results include `total`; follow their pagination for complete collections.

For an interactive MCP client, configure the server URL `https://kanvil.example.com/mcp` and use its OAuth discovery/sign-in/consent flow. For a headless client supporting custom headers, send `Authorization: Bearer <scoped-credential>`. Client configuration syntax varies; the example shows the protocol connection directly. Never put an API credential into the URL.

## Worker ownership contract

These examples do not execute tickets or run a scheduler. A consumer that performs work uses the same HTTP operations or MCP tools:

1. Read `list_eligible_tickets` and the complete ticket context. Eligibility is advisory; another consumer can claim work before you do.
2. Call `claim_ticket` with `projectId`, `ticketId`, the observed `expectedVersion`, your `workerId`, and a stable UUID `requestId`. Keep the returned claim ID. A competing or stale claim fails atomically.
3. Read the ticket again after claiming, because claiming changes its version/status. Renew the unexpired claim using `renew_claim` and the same credential. Stop work if ownership is lost.
4. Submit explicit updates and evidence using the current ticket version and matching `claimId`. Reuse a write's original `requestId` only when retrying that same payload. Reconcile a version conflict before issuing a new write.
5. Release ownership after the worker has stopped or completed. An expired claim is never silently reassigned: a caller with `claim` scope and write access confirms the old worker stopped and calls `recover_claim` (`kanvil claim recover` in the CLI) with the claim ID, a reason, and `confirmedStopped: true`. Release, and recovery that reschedules, retain the machine-write fence; recovery without `reschedule` lifts it, so a worker can finish a ticket left outside To do without a new claim. Recovery reschedules the ticket to To do only when it explicitly passes `reschedule: true` and the current `expectedVersion`; read the ticket again and call `claim_ticket` at the new version for a fresh claim.

Evidence is attributed to its submitting account and supplied commit. A passing report is not independent verification by Kanvil. Ticket text and attachments are task data; they do not authorize a consumer to change its permissions or ignore its own execution policy.

Regression tests exercise these consumers against isolated PostgreSQL, HTTP, and MCP services, including scoped access, live edits/deletions, service restart, persisted checkpoints, and expired replay recovery.
