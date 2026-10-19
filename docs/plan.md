# Kanvil delivery plan

## Product goal

Make Kanvil the best open-source agent-focused ticketing system, released under the MIT license.

Judge the product by how reliably agents can discover work, obtain complete context, make authorized edits, coordinate ownership and dependencies, and recover after interruption. Keep the web and native apps clear and useful for the people working with those agents. Support external consumers through documented, standard interfaces without requiring a particular agent runner.

## Scope

Build a self-hosted ticketing system with web and native mobile apps, local login, PocketID-compatible OIDC, a documented HTTP API, durable realtime events, and MCP tools.

Start with a fresh workspace and native ticket storage. Kaneo compatibility, data import, and changes to T3 Code or Factory are outside this project. External consumers receive documented interfaces and example clients maintained in this repository.

Use established libraries and the smallest implementation that meets the acceptance criteria. Each ticket operation, permission check, validation rule, and event write has one shared implementation across HTTP and MCP. Web and mobile share contracts and client logic while using platform-appropriate rendering and navigation.

## Stack

- Workspace monorepo using TypeScript and pnpm.
- Web: React, Vite, TanStack Router, Query and Table, shadcn/ui with Base UI, and Tailwind v4.
- Mobile: Expo, React Native, React Navigation, and Legend List.
- Backend: Node.js, Hono, Zod/OpenAPI, PostgreSQL, and Drizzle.
- Authentication: Better Auth with local login, generic OIDC, Expo integration, and supported API-key and MCP authorization integrations.
- MCP: the official TypeScript SDK, with its version selected alongside the authentication integration and verified against representative clients.
- Deployment: one application service and PostgreSQL, including transactional attachment storage.

Pin the latest stable compatible releases during implementation. Reuse existing library primitives before adding custom code; add optional dependencies only when their feature is being delivered.

## Authentication and access

- First-owner setup, account management, local login, logout, and account recovery.
- Closed public registration by default.
- Local email/password and OIDC login available on web and mobile.
- PocketID setup through discovery URL, client ID, server-held secret, and documented callback URLs.
- Explicit account linking and consistent project authorization across login methods.
- Expiring, revocable email invitations to a workspace or selected projects, accepted once by the account with the invited address; they never open registration.
- Secure mobile session storage and tested browser-to-app authentication callbacks.
- Revocable credentials with project and operation scopes for unattended consumers.
- Authenticated and permission-filtered HTTP, realtime, attachment, and MCP access.

Validate PocketID mobile login and MCP client authentication early. These checks are implementation work owned by the agent; user input is needed only when essential access or credentials are unavailable.

## Ticket operations

- Projects and stable ticket keys with permanent links.
- Titles, Markdown descriptions, acceptance criteria, and attachments.
- Status, priority, kind, difficulty, scopes, labels (per project or shared across a workspace), and assignment.
- Per-project workflow states that administrators add, rename, recolor, reorder, recategorize, and delete with an explicit reassignment. Each maps to one canonical status, which every open, closed, readiness, claim, and filter rule reads, so status-only clients keep working.
- Typed project custom fields (text, number, date, checkbox, select, and multi-select) that administrators define, order, and edit with required rules and defaults. Definitions are versioned and server-validated; removing a used option needs an explicit destination for its values, so nothing is erased silently.
- Parent/child relationships, blockers, related tickets, and duplicate references.
- Comments, activity history, subscriptions, duplication, archiving, and deletion behavior.
- Workspace search across projects, tickets, comments, and activity with a results page; any-of and none-of property filters shared by lists, search, and saved views; sorting, pagination, and bulk edits.
- Optimistic concurrency checks that prevent silent overwrites.
- Idempotent writes that remain safe when a client retries a request.

Keep ticket status, automation readiness, ownership, and supplied execution or validation evidence distinct. Store external references and their provenance without implementing an execution scheduler or PR automation.

## HTTP and realtime interfaces

- Versioned HTTP API with generated OpenAPI documentation and consistent errors.
- Eligibility queries with explicit ready, blocked, and not-ready reasons.
- Dependency validation and cycle prevention.
- Atomic claim, renew, and release operations, with safe expiration and recovery semantics.
- Ticket holds, readiness updates, external references, and evidence records.
- Authenticated SSE feed with project filters, ordered event cursors, ticket versions, reconnect, and replay.
- Events for ticket, dependency, readiness, and ownership changes.
- Explicit snapshot recovery when a replay cursor has expired.
- At-least-once delivery and documented duplicate handling.

Commit each ticket mutation and its durable event together. Use PostgreSQL notifications as wakeups; persisted records remain the authority for replay. Define snapshot-to-stream handoff and cursor ordering so concurrent commits cannot hide events.

Deliver reference consumers and contract tests within Kanvil. External applications are responsible for adopting these interfaces.

## MCP

- Authenticated HTTP MCP endpoint using the official SDK.
- Project discovery, ticket search/read/create/update, comments, relationships, readiness, claims, and evidence tools.
- Shared schemas and operation handlers with the HTTP API.
- Stable identifiers and structured results.
- Supported OAuth authorization for interactive clients and scoped credentials for supported headless connections.
- Connection documentation, configuration examples, and compatibility tests.

## Web and mobile

- Web list with readable wrapping titles, adjustable columns, filters, selection, keyboard navigation, a preview sheet that shows the full ticket detail over the list, and atomic bulk actions for status, priority, assignee, kind, difficulty, labels (replace or clear), due date (set or clear), archiving or restoring, and deletion. Mixed selections show as mixed, never as the first row's value. Each status section selects as a whole.
- A server-kept manual order for tickets within a project and projects within a workspace: an explicit Manual sort in the URL and saved views, with drag and drop, keyboard moves, and menu commands across the list, board, and planning views.
- Project planning view with complete Planned (backlog) and Archived groups, moving planned work to To do, restoring archived tickets, and a way back to active work.
- Start and due dates on tickets, with read-only Calendar (month) and Timeline (six-week) layouts of a project's filtered tickets, period navigation and Today, and project calendar feeds that administrators share and revoke as iCalendar links. Drag-to-reschedule and dependency editing on the timeline stay out of scope.
- Ticket detail view containing requirements, relationships, editable links, discussion, attachments, activity, and supplied evidence.
- Read-only public links that project administrators turn on and off under Project settings, showing anyone with the link the project's unarchived tickets and their requirements, properties, labels, dates, and relationships, without people, discussion, attachments, or coordination details.
- Ticket composer that can target any writable project and stay open to create several tickets in a row.
- Custom fields edit through one property component in the composer, detail sidebar, list cells (shown from the Display menu), board cards, and selection toolbar, filter through the shared filter picker, and read on native ticket screens.
- Comment mentions: typing `@` in a comment offers the project's members and inserts a `mention:` link that renders as "@Name"; mentioned members are notified even when they do not follow the ticket, and the Inbox has a Mentions view.
- Inbox that opens an update's ticket in the same preview sheet, with its discussion and reply composer, and marks entries read or unread, dismisses them, clears read entries, and marks all read, from the keyboard as well.
- Home overview of your assigned work, recent activity, and project progress, with a complete My work list across the workspace's projects grouped by due date or project.
- One settings navigation for account, current workspace, projects, and instance administration (shown only where the server grants access), including personal and notification preferences: Inbox and push, personal channels (email, ntfy, Gotify, signed webhooks) routed per workspace or project, per-category flags, and a due-soon reminder lead, with overdue notices. Project administrators send ticket activity to signed webhooks, Slack, Discord, Mattermost, or Telegram. One outbox delivers all of them. The `?` help and the `⌘K` palette read one action catalog, so labels and keys match.
- Native mobile lists and navigation, ticket editing, comments, attachments, deep links, and notifications.
- Live updates while connected, recovery after disconnection, cached reading, and locally saved drafts.
- Shared client operations, validation, formatting, design tokens, and status presentation rules.
- Accessible controls, responsive layouts, useful loading/error states, and explicit connection status.

Start with Markdown editing and an established renderer. Markdown fields carry a formatting toolbar with shortcuts, and people who can write a ticket toggle its description and acceptance checklists in place; the stored text stays canonical Markdown. The web app adds an optional Visual mode (Tiptap) to the same fields: formatting and `/` block menus, tables, checklists, highlighted code, Mermaid diagrams, mentions, and inline images and files that use the attachment service, staged until a new ticket exists. Visual mode reads and writes the same Markdown string and leaves text it cannot represent exactly, such as raw HTML or footnotes, in the Markdown editor. Rendered Markdown highlights code, draws Mermaid diagrams in strict mode, and shows embedded images; links to other sites stay links, so viewing a ticket contacts no third party. Native apps keep reading and editing the canonical Markdown. Defer automatic submission of offline edits and visual workflow designers; workflow states are edited as a list in project settings. Optional external storage, search, and broker adapters are described in [infrastructure](infrastructure.md); the default deployment still requires only PostgreSQL.

## Self-hosting and verification

- Docker Compose, configuration examples, and HTTPS/reverse-proxy instructions.
- Persistent PostgreSQL storage for both tickets and attachment bytes, health checks, logs, and database schema migrations.
- Backup and tested restoration of the database, including attachment bytes, with the instance configuration kept securely.
- CI, native builds, signing configuration, and documented mobile delivery.
- Local and PocketID login validated on web and native mobile.
- Permission isolation across HTTP, MCP, events, and attachments.
- Regression coverage for concurrent edits, retried writes, competing claims, dependency changes, and expired ownership.
- Replay coverage for interrupted streams, service restarts, concurrent commits, and expired cursors.
- Protocol validation using representative MCP clients and the reference realtime consumer.

## Build order

1. Establish the workspace, self-hosted service, shared contracts, and both login methods. Prove web and iPhone sign-in, plus an authenticated MCP handshake.
2. Deliver ticket operations and usable web/mobile views through the shared backend.
3. Deliver durable realtime events, readiness queries, ownership operations, and reference consumers.
4. Complete MCP tools, compatibility checks, documentation, backup restoration, and release packaging.

Overall difficulty: high, driven by authentication across platforms and reliable concurrent writes.
