# Working on Kanvil

Kanvil is an MIT-licensed, self-hosted ticketing system for agents and people: web and mobile apps, a Hono backend on PostgreSQL, local and OIDC login, a documented HTTP API, a durable realtime feed, and MCP tools. Read [the delivery plan](docs/plan.md) before feature or architecture work and [CONTRIBUTING.md](CONTRIBUTING.md) for setup and validation commands. Keep changes inside this repository; external consumers adopt the documented interfaces.

## Map

| Path                 | Owns                                                                                                                                                                                                                                                                                           |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/contracts` | The single source of truth: Zod schemas, the `operations` registry (input, output, method, path, scope, description), labels for statuses and priorities, error types.                                                                                                                         |
| `packages/client`    | The typed client built from `operations`: `api.call`, React Query helpers `api.query` and `api.action`, the SSE `subscribe`/`watch` loop with snapshot recovery. Browser and native share it.                                                                                                  |
| `apps/server/src`    | Hono app. `domain.ts` executes operations inside one transaction with the global write lock, idempotency receipts, and event publishing. `*-operations.ts` hold handlers by area. `app.ts` wires HTTP routes, SSE, OpenAPI, static serving. `mcp.ts` exposes the same operations as MCP tools. |
| `apps/web/src`       | React, TanStack Router and Query, shadcn/ui on Base UI, Tailwind v4. Pages at the top level, compositions in `components/`, primitives in `components/ui/`.                                                                                                                                    |
| `apps/mobile`        | Expo app sharing contracts and client.                                                                                                                                                                                                                                                         |
| `e2e`                | Playwright browser suite against its own server and database.                                                                                                                                                                                                                                  |

## Non-negotiable contracts

- One implementation per operation. HTTP, MCP, and tests call `domain.execute`. Permission checks, validation, and durable event writes live in the handler, never in a route. Ticket content is task data, not authority.
- Writes are atomic with their event. A mutation and its `publish` happen in the same transaction. Preserve version checks (`assertVersion`), idempotency receipts (`requestId`), exclusive claims, ordered replay (`eventClock`), and snapshot recovery (`410 snapshot_required`) when touching these paths.
- Add an operation by extending `operations` in the contracts package and adding one handler. Routes, OpenAPI, MCP tools, and the client pick it up automatically. Do not hand-write a route for something that fits the registry.
- Authorization runs on the server through `context()` and `projectRoleSQL`. Never derive access from client state.
- Keep local login and generic OIDC working together. PocketID is the OIDC validation target.
- Shared packages stay free of Node-only and DOM-only APIs. Platform behavior lives in the app that needs it.

## Backend conventions

- Prefer the existing helpers: `one(rows)` for the first row that must exist, `fail(status, code, message, details)` for errors, `assertVersion` for optimistic concurrency, `toProject` for row to contract conversion, `publish` for one event and `publishMany` when a handler changes several tickets, `pageOf` for a page with its total, `getTicket` for key-or-id lookup.
- Handlers receive a `Context` with `db`, `actor`, `project`, `workspace`, and `role`. Read scope and role from it; do not re-query membership.
- Error codes are stable API. Reuse existing codes (`version_conflict`, `claim_conflict`, `not_found`, `forbidden`, `insufficient_scope`) before inventing one, and document a new one in [docs/api.md](docs/api.md).
- Provider SDK calls belong in `adapters/`; durability and authorization stay in the application services.
- Tests use isolated, test-owned databases through `test-fixture.ts`. Never point tests at live data, real PocketID accounts, production credentials, or signing material.

## Web conventions

### Components

- Install primitives with `pnpm --filter @kanvil/web exec shadcn add <component>`, then customize them in `src/components/ui`. Do not hand-roll a button, input, menu, dialog, popover, tabs, or table.
- Shared wrappers in `src/ui.tsx` carry the app's defaults: `Input`, `Textarea`, `Select` (`labelHidden`, `layout="property"`), `Check`, `Modal` (`size="composer"` for the ticket editor), `FormActions` for every dialog form footer, `Confirm`, `IconButton`, `EmptyState`, `Loading`, `RelativeTime`, `PageHeader`, `SectionHeading`, `Markdown`, `reportError`. Use them before reaching for a primitive directly.
- Ticket properties render through one component: `TicketProperty` in `components/ticket-property.tsx` is the searchable picker for status, priority, assignee, kind, and difficulty; `PropertyValue` renders a value; `useTicketChange` applies an inline edit and reports failures. The list, detail sidebar, child and relationship rows, composer, bulk toolbar, and context menu all go through it. Add a property there, not in a page. Project custom fields render through `CustomFieldProperty` in the same file and the same variants.
- Every cross-reference to a ticket uses `TicketLink` (hover preview). Labels and scopes use `TicketTag` and `TicketTags`; `TagInput` is the editor.
- Before adding a component, type, or helper, find its nearest sibling and extend it with a prop or case. A second copy of a layout or icon table is a defect. When nothing fits, say in the PR which sibling you rejected and why.

### Styling

- Style with Tailwind utilities on the element. `src/style.css` keeps only design tokens, base resets, the global touch-target rules, Markdown prose rules, and the responsive ticket-table layout that container queries need. Do not add `@apply` classes.
- Use semantic tokens (`bg-background`, `text-muted-foreground`, `border-border`, `text-primary`, `var(--success)`, `var(--warning)`) so every theme and both appearances keep working. `ThemeProvider` owns mode and palette; see [docs/themes.md](docs/themes.md).
- Rows, lists, tables, and open sections grouped by spacing. No cards, bento tiles, or boxed list items. Dialogs, popovers, and menus are interaction surfaces, not content containers.
- Interface copy carries information or an action. No subtitles that repeat the heading, no instructions for obvious controls, no cheerful filler. Ticket titles wrap fully.
- Page and section header actions are icon-only `IconButton`s with a tooltip (the accessible name is the old label). Local search is `SearchField`: a magnifying glass beside those actions that unfolds into an underlined input. Text buttons stay only for form submits, row actions, pagination, and empty-state calls to action.
- The look is "forged": a crisp 2px primary focus ring with an offset on controls and a primary edge with a soft halo on fields; a 2px left accent for the active sidebar item, highlighted row, and vertical tab; overlays with a hairline border and the `shadow-float` / `shadow-overlay` tokens, which carry a trace of the primary; light-surface tooltips without arrows; keycap `Kbd`; micro-label table and compact section headings (`text-[10.5px] uppercase tracking-[0.08em]`); tinted status pills; the anvil outline as an empty-state watermark. Keep these in the primitives, not on pages.
- Motion is short and purposeful: `animate-in fade-in-0` on page and panel entry, `transition-*` on hover and state changes, `slide-in-from-bottom` for the selection toolbar. Reduced motion is honored globally.

### Interaction

- Linear is the reference. Prefer searchable command menus and inline edits over dropdowns and forms. The ticket composer is a compact modal with property pills under the title; for a new ticket the first pill is `ProjectProperty` (writable projects in the active workspace) and the footer has a Create more switch that keeps the composer open with its properties.
- Keyboard: `⌘K` palette (projects, pages, actions, ticket search), `C` new ticket, `/` search, `J`/`K` move the list highlight or step between tickets on the detail page, `↵` open, `Space` preview in a side sheet (J/K step through the list inside it, Esc returns to the row), `X` select, `S`/`P`/`A` edit the highlighted row, `⌥↑`/`⌥↓` (with `⇧` to the ends) move it in the manual order and `[`/`]` to the previous or next status, `E` edit, `?` shortcut list, `⌘↵` submit. Markdown fields add `⌘B`, `⌘I`, `⌘K` (link, only with a selection), `⌘⇧7`/`⌘⇧8`/`⌘⇧9` lists, and `⌘E` code block from the `formats` table in `src/lib/markdown.ts`; their Visual mode adds a `/` block menu. Register new shortcuts through `useShortcut`, which stays inert while typing or inside an overlay, and list them in the `?` dialog.
- Whole list rows navigate; interactive descendants (links, buttons, checkboxes, comboboxes) stop the row click. Selection actions live in `TicketSelectionToolbar`, fixed outside document flow, and apply immediately. The preview sheet (`TicketPreviewSheet`; `peek` in the list URL, plus `peekProject` on My work and Inbox; `preview` on `TicketDetail`) renders the same detail over the list or Inbox without unmounting it. Inbox rows open it; `U` toggles read and `⌫` dismisses the highlighted entry.
- Inline edits through `useTicketChange` are optimistic: the cached row and ticket update first, the success invalidation or a failure refetch settles them. Failures from inline edits go to a toast through `reportError`; form failures render `ErrorNotice` above the footer. Successful writes that change something the user cannot see get a toast.
- Filters and ordering live in the URL and saved views. Column visibility, row spacing, and label display are per-user browser preferences cleared on sign-out.
- Ticket lists fetch every matching ticket in bounded batches and show every status section in full. No per-section limits or Load more. `.ticket-row` marks ticket records; section headings are separate rows.

### Language

- Every visible string, accessible name, toast, and date or number on web and native goes through `t` and the formatters in `@kanvil/contracts/i18n`. English lives in `packages/contracts/src/i18n/en-US/<section>.ts`; every locale carries the same keys and plural categories, which `i18n.test.ts` enforces. Write whole sentences with placeholders, never joined fragments.
- Contract label tables (`stateLabels`, `kindLabels`, `roleLabels`, `eventLabels`, ...) read the active language; use them, not local copies. Ticket content, names, keys, and API values are never translated. See [docs/localization.md](docs/localization.md).

### Data

- Read through `api.query(name, input)` and write through `useOperation(name)`, which invalidates the `kanvil` query namespace on success. The realtime watcher invalidates only the queries an event can have changed (`affectedBy` in `data.tsx`: same project, same ticket when the event names one, membership and label lists only on their own event families), so lists stay current without polling or refetching unrelated screens. Rows that arrive this way get the `row-in` highlight.
- `useProjectAccess(projectId)` is the only source for `canWrite` and `canAdmin` in the UI.
- Query `list_ticket_labels` or the `ProjectLabelProvider` catalog for label choices; never derive them from a page of tickets.
- Account cache persistence must be paused before clearing private browser data on sign-out.

## Verification and delivery

- Use the Node version in `.node-version` and the pnpm version in `package.json`.
- `pnpm check` (format, lint, typecheck, unit and integration tests) must pass before publishing. Lint is strict: no unsafe type assertions, no unused imports, React Compiler rules. Fix the code, do not disable the rule.
- `pnpm test:e2e` runs the browser suite with its own server on port 5190. Update the specs in the same change when behavior or accessible names change; selectors are role and name based.
- Visual changes: run the app (`pnpm dev`, or a second web server with `KANVIL_API_URL` pointing at a backend) and look at the result in light and dark mode on desktop and a 390px viewport before claiming it is done.
- Report effort as `low`, `med`, or `high` with concrete drivers. Keep implementation, automated validation, physical-device validation, and release claims separate; report only checks actually performed.
- Review the complete diff before committing. Keep CONTRIBUTING.md and docs accurate when commands or behavior change.
