# Contributing to Kanvil

## Setup

Install the Node version from `.node-version` and the pnpm version from the `packageManager` field in `package.json`, then run:

```sh
pnpm install --frozen-lockfile
pnpm db:up
pnpm check
```

The workspace includes `apps/*` and `packages/*`. `compose.dev.yml` runs an isolated development PostgreSQL instance on loopback port 55462. Tests create and remove their own databases; set `TEST_DATABASE_URL` to use another dedicated test PostgreSQL server. Stop the development service with `pnpm db:down`.

For local web and backend development, run `pnpm configure` once to create a private `.env` with generated secrets, then `pnpm dev`. Open the web app at `http://localhost:5173`; the API listens on port 5180. Run `pnpm build` to build the web app; the backend also serves that build at its own origin, including login and MCP consent routes. Configuration never overwrites an existing `.env`. The server applies committed database schema migrations at startup. HTTP/MCP and realtime integration details are in [docs/api.md](docs/api.md).

## Checks

`pnpm check` is the local and CI entry point for formatting, linting, TypeScript checks, and tests. Vite+ provides Oxfmt, Oxlint, and Vitest; configuration lives in `vite.config.ts` and the TypeScript configs.

Use `pnpm fmt` to format files, `pnpm lint` for linting, `pnpm typecheck` for type checks, and `pnpm test` for a test run. Target an individual suite with `pnpm exec vp test run path/to/file.test.ts`.

Tests cover the shared contracts, PostgreSQL authentication and domain behavior, HTTP, MCP, realtime replay, and attachment bytes. An empty suite fails. Each workspace package has a TypeScript config extending the shared base.

The same test run validates the [reference consumers](examples/README.md), including a mirror restart and expired-cursor recovery. Their command-line entry points are `pnpm example:mirror` and `pnpm example:mcp`.

## Changes

Keep each pull request focused on one coherent change. Describe the resulting behavior and the validation performed. Add regression coverage for meaningful behavior changes and update relevant instructions when their commands change.

Dependencies are pinned to exact versions and resolved in `pnpm-lock.yaml`. Use current stable compatible releases when adding or updating dependencies; verify compatibility rather than forcing upgrades with overrides. Update the Node pin together with its supported engine range and matching Node type definitions when needed.

Use the pinned pnpm version. Its lockfile intentionally contains an environment document for the package-manager pin before the application dependency document; see the [pnpm lockfile format](https://github.com/pnpm/pnpm/blob/main/pnpm/docs/lockfile.md). Do not remove either document to satisfy a single-document YAML parser.

Install Chromium with `pnpm exec playwright install chromium`, then run `pnpm test:e2e` for the browser workflow. It starts a separate server and creates and removes its own test database; it never reuses an existing application server. Set `KANVIL_TEST_PORT` to use a separate loopback port when running browser suites concurrently.

Set `KANVIL_TEST_PORT` to run the browser suite and its isolated server on another loopback port when concurrent jobs use the default port.

PRs and pushes to `main` fan out into independent jobs: formatting, lint, type checks, unit/database tests, optional-service integration tests, the web/npm build, installed-tarball validation, four browser shards, PocketID login, the iOS bundle export, and native amd64/arm64 Docker restoration checks. Each job starts only its required services. The always-running `Checks` job requires every job and matrix entry to succeed; keep that one status in branch protection. Tagged releases reuse the same graph.

The build job uploads the npm tarball and web assets once; npm/browser jobs download them instead of rebuilding. Docker builds use architecture-specific BuildKit caches, with dependency layers independent of application source changes. The shared `.github/actions/setup` action owns pinned tools, workspace installation, and Chromium setup. Release publishers promote the tested tarball and image archives; npm and per-architecture image pushes run in parallel, then Docker manifests join the two digests.

Run `pnpm test:package` locally to build and verify the npm artifact. `pnpm package` creates the public app and tarball in `dist` from the existing server/web builds; `node scripts/package-smoke.ts` verifies an existing tarball without rebuilding. Workspace libraries stay private. Release setup is in [docs/releasing.md](docs/releasing.md). Dependency updates arrive as grouped Dependabot pull requests for review.

`pnpm test:oidc` also starts a disposable PocketID instance on loopback port 51411, runs the browser suite with a virtual passkey, and removes the fixture container afterward. PocketID data lives on tmpfs. For concurrent provider suites, set `KANVIL_TEST_POCKET_PORT` and use a separate Compose project with `docker compose -p <project> -f compose.auth-test.yml`; use the same port when starting the browser suite. The test uses only its fixed isolated API key; it never accepts a real provider URL or credentials. CI runs this provider flow alongside the MCP OAuth consent/PKCE exchange.

Native setup, session storage, deep links, and validation commands are in [docs/mobile.md](docs/mobile.md). `pnpm mobile:export` checks both native JavaScript bundles. Regenerate web and native brand assets with `pnpm assets:generate`; [branding](docs/branding.md) lists their shared source and consumers.

`pnpm test:docker` builds and verifies an isolated self-hosting image, including database restoration and attachment bytes. Operator instructions are in [docs/self-hosting.md](docs/self-hosting.md).

## Web UI

The web app uses Tailwind v4 and the Base UI version of [shadcn/ui](https://ui.shadcn.com/docs). Its registry configuration is in `apps/web/components.json`. Add components with `pnpm --filter @kanvil/web exec shadcn add <component>`, then customize the generated file in `src/components/ui` and validate it against this repository's TypeScript and lint rules.

Style with Tailwind utilities on the element. `src/style.css` holds only the design tokens, base resets, global touch-target rules, Markdown prose rules, and the responsive ticket-table layout; do not add `@apply` component classes. Appearance uses shadcn's semantic CSS variables; `ThemeProvider` persists the light/dark/system mode and color theme, and [themes](docs/themes.md) lists the palettes and adaptation rules.

Reuse `src/components/ui` for primitives and `src/ui.tsx` for the app wrappers: labeled fields, `Modal` and `FormActions` for dialog forms, `Confirm`, icon actions, `RelativeTime`, `PageHeader`, `SectionHeading`, Markdown rendering (pass `onChange` to make its task checkboxes toggleable), and `reportError` for toast failures. Ticket properties (status, priority, assignee, kind, difficulty) render and edit through `TicketProperty` in `src/components/ticket-property.tsx`; ticket references use `TicketLink`; labels and scopes use `TicketTag`, `TicketTags`, and the `TagInput` editor. Application compositions live in `src/components`.

The workspace uses shadcn's inset Sidebar with persisted resizing, icon collapse, and its mobile Sheet. The `⌘K` palette searches projects, pages, actions, and the current project's tickets; single-key shortcuts (`C`, `/`, `E`, `?`) register through `useShortcut`. Context menus, the bulk selection toolbar, and inline edits reuse the same server-authorized operations as forms, and the same property options, icons, and date calendar as `TicketProperty` and `DatePicker`.

Settings pages show current state first; the page's own name and description edit in place through `EditableHeading`, and other editors open from their row actions. `useModalBusy()` prevents closing a shared dialog while a write is pending. Account cache persistence must be paused before clearing private browser data on sign-out.

Ticket lists use TanStack column visibility and the shared `TicketListControls` composition. Property visibility, row spacing, and label display are per-user browser preferences; filters and ordering remain in the URL and saved views. Status, priority, label, and assignee filters share one `FilterPicker` multi-select with an Is / Is not choice, and the active-filter chips come from the contracts `ticketPredicates`. Search results render through `SearchResultContent` in both the command palette and the `/search` page. Query `list_ticket_labels` for label choices, never a paginated ticket list. Selection actions live in `TicketSelectionToolbar` outside document flow and apply immediately. Lists group rows by status with counts and collapse controls; every matching ticket is fetched in bounded batches and shown in full. Whole rows navigate to the ticket; status, priority, difficulty, kind, and assignee cells edit inline.

The ticket composer is a compact modal: title, property pills, description, optional acceptance criteria, and a footer with the draft state and submit. Drafts persist per ticket in this browser until saved or discarded. Start and due dates edit as a pair through `ScheduleDates`, which bounds each picker by the other.

The Calendar and Timeline layouts join List and Board in the same Layout preference. They render through `TicketSchedule` from the list's own fetch, ungrouped and bounded by `scheduledFrom`/`scheduledTo`; `ticketSpan` is the one rule for which days a ticket covers, and the shown period rides in the URL as `period`, outside saved views. Both are read-only. Project administrators share and revoke calendar feeds under Project settings → Calendar feeds.

Project settings → General → Public link shares the project read-only by link and lists what it discloses. `/public/projects/$projectId` and its ticket pages in `src/public-project.tsx` render outside the signed-in shell from the unpersisted app cache, reading only the public operations through `api.publicQuery`. They reuse the property, tag, Markdown, and `TicketLink` (`shared`) renderers without any write or coordination control.

Project settings → Workflow lists the project's states by category; project admins add, rename, recolor, reorder, recategorize, and delete them, choosing where a deleted state's tickets move. The status picker, list sections, and board lanes follow the project's states through `useWorkflow`; a status value carries the category and state ID (`statusValue`) so the category renders before the workflow loads. Project settings include a searchable label directory with create, rename, recolor, and delete actions for project admins. `ProjectLabelProvider` reads the catalog once per project route. Label rename and delete operations pass affected tickets through the shared ticket-update handler.

Project settings → Integrations lists repository connections above destinations. Both render through `DeliveryRow` and `DeliveryList` in `src/components/delivery-settings.tsx`; a connection's row adds its webhook URL copy action and an access check instead of a test send. Verified links render their kind and state through the shared Links rows in `src/ticket-resources.tsx`. Server tests use a loopback fake GitHub; fixtures point `KANVIL_GITHUB_API_URL` at an unresolvable host.

Project settings → Fields defines custom fields. Their values render and edit through `CustomFieldProperty` in `src/components/ticket-property.tsx` (pill, row, and cell, like `TicketProperty`, whose searchable `ChoiceList` it shares), read their definitions through `useCustomFields`, and format through `formatCustomFieldValue` in the contracts package, which native screens use too. List columns for fields start hidden and are named `field:<id>` in the column preference. Validation stays on the server in `custom-field-operations.ts`.

Browser tests cover theme persistence, system appearance, sidebar collapse, keyboard navigation, the mobile sidebar, and the ticket workflows above; update them in the same change when accessible names change.

Optional infrastructure adapters, configuration precedence, backup rules, and `pnpm test:services` are documented in [infrastructure](docs/infrastructure.md). Keep provider SDK calls in the adapters and durability/authorization in the application services.

Settings pages show current state first and open task-specific editors from their actions. Reuse `MarkdownField` (its formatting toolbar and shortcuts come from `src/lib/markdown.ts`, which the `?` list also reads; pass `mentions` a project ID to offer that project's members after `@`, and `onUpload` from `useInlineUpload` to embed pasted, dropped, or picked files. Its Visual tab lazy-loads the Tiptap editor in `components/visual-editor.tsx`, which shares the toolbar, suggestion list, and uploads with the Write tab; `canEditVisually` in `src/lib/rich-text.ts` keeps text the editor cannot reproduce exactly in Write), `TicketPicker`, and `TagInput` for ticket writing and metadata instead of exposing UUIDs or comma-separated text fields. `useModalBusy()` prevents closing a shared dialog while a write is pending. Account cache persistence must be paused before clearing private browser data on sign-out; the persister library can still have queued writes.

Ticket lists use TanStack column visibility and the shared `TicketListControls` composition. Property visibility, Compact/Comfortable row spacing, Compact preview/All labels display, grouping, List/Board/Calendar/Timeline layout, project background visibility, week start, and sidebar launch state are local to the signed-in user and persist in this browser through `usePreference` in `hooks/use-preference.ts`; the Display popover and **Settings → Preferences** render the same `TicketDisplayPreferences`, and sign-out clears them with other private browser data. Filters and ordering remain in the URL and saved views. Query `list_ticket_labels` for label choices across the whole project, never derive them from a paginated ticket list. Keep selection actions in `TicketSelectionToolbar` outside document flow so checking a row cannot shift the list. Relationship labels, inverse choices, and parsing come from the contracts package for both web and native.

Project-list headings belong to `WorkspaceHeader`; keep the ticket view picker, search, filters, display controls, and creation action in one `TicketListControls` row. `TicketTags` handles compact read-only label/scope previews; `TagInput` remains the editor with input validation and removal controls. Saved-view radio items must use the library's `closeOnClick` behavior so switching views closes the menu.

The Board layout renders a project's active work from the same fetched tickets, table row model, cells, and selection as the list, as one flat lane per filtered status (empty lanes stay as drop targets). Dropping a row on a lane is an optimistic, versioned `move_ticket` status change, and `S` on the highlighted row opens the inline status picker; readers get no drag, selection, or editors.

The Manual order (`sort=manual`) is kept by the server; `move_ticket` and `move_project` take a neighbor, never a position, through one helper in `apps/server/src/ordering.ts`. In the web list every move goes through `place` in `ticket-list.tsx`: dragging a row or card onto another (`useReorderDrag`), `⌥↑`/`⌥↓` with `⇧` for the ends, `[`/`]` for the previous or next status, and the ticket menu's Move items, all labeled from `moveCommands` in `src/lib/actions.ts`. The sidebar and the project menu reorder projects for project administrators the same way. A project admin's optional background image (Project settings → Background) renders faintly behind the list and board; hiding it is a personal preference and leaves the project's image in place.

Ticket lists group rows by the shared status definitions, with counts and collapse controls. Fetch all matching tickets through the existing API in bounded batches, then display every section in full. Do not introduce per-section limits or Load more controls. The shared table owns columns and selection across groups, and `.ticket-row` identifies ticket records separately from section headings. Filters reset loaded batches; collapsing a group excludes its rows from selection.

Project settings → Workflow lists the project's states by category; project admins add, rename, recolor, reorder, recategorize, and delete them, choosing where a deleted state's tickets move. The status picker, list sections, and board lanes follow the project's states through `useWorkflow`; a status value carries the category and state ID (`statusValue`) so the category renders before the workflow loads. Project settings include a searchable label directory with create, rename, recolor, and delete actions for project admins. `ProjectLabelProvider` reads the catalog once per project route; `TicketTag` extends the existing badge renderer with shared color dots across lists, details, filters, and editors. Reuse `AccentColorPicker` and `accentColorClasses` for both project icons and labels. Keep scope tags independent from label definitions. Label rename/delete operations must pass affected tickets through the shared ticket-update handler to preserve versions, ownership checks, events, and external search updates.

The appearance picker uses System/Light/Dark wireframe tiles and paired theme orbs, following T3 Code's picker. `ThemePreview` shares wireframe and orb rendering; `ThemeProvider` owns the base theme, independent light/dark assignments, and system appearance. Keep assignment, persistence, legacy migration, and deletion fallback there. Selecting a whole theme clears the assignments; custom JSON import/export stays compatible. Adapted preview artwork is covered by the shipped third-party MIT notice.
