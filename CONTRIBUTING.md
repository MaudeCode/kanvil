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

Install Chromium with `pnpm exec playwright install chromium`, then run `pnpm test:e2e` for the browser workflow. It starts a separate server and creates and removes its own test database; it never reuses an existing application server.

The single CI job runs on pull requests and pushes to `main`. Dependency updates arrive as grouped Dependabot pull requests for review.

`pnpm test:oidc` also starts a disposable PocketID instance on loopback port 51411, runs the browser suite with a virtual passkey, and removes the fixture container afterward. PocketID data lives on tmpfs. The test uses only its fixed isolated API key; it never accepts a real provider URL or credentials. CI runs this provider flow alongside the MCP OAuth consent/PKCE exchange.

Native setup, session storage, deep links, and validation commands are in [docs/mobile.md](docs/mobile.md). `pnpm mobile:export` checks both native JavaScript bundles. Regenerate web and native brand assets with `pnpm assets:generate`; [branding](docs/branding.md) lists their shared source and consumers.

`pnpm test:docker` builds and verifies an isolated self-hosting image, including database restoration and attachment bytes. Operator instructions are in [docs/self-hosting.md](docs/self-hosting.md).

## Web UI

The web app uses Tailwind v4 and the Base UI version of [shadcn/ui](https://ui.shadcn.com/docs). Its registry configuration is in `apps/web/components.json`. Add components with `pnpm --filter @kanvil/web exec shadcn add <component>`, then format and validate the generated code against this repository's TypeScript and lint rules.

Reuse `apps/web/src/components/ui` for interaction primitives and `src/ui.tsx` for labeled fields, icon actions, Markdown, and confirmation flows. Keep these shared components instead of introducing page-specific button, input, menu, or dialog implementations. The workspace uses shadcn's inset Sidebar with persisted drag/keyboard resizing, icon collapse, its keyboard shortcut, and its mobile Sheet. Context menus reuse shadcn primitives and server-authorized operations. Application compositions live in `src/components`.

Appearance uses shadcn's semantic CSS variables in `src/style.css`. `ThemeProvider` persists the light/dark/system mode and color theme; both the header menu and Settings use that same provider. Ten bundled palettes and custom theme import/export use full light/dark tokens; custom colors are validated for text contrast. Add colors through these tokens so dialogs, menus, inputs, and navigation stay consistent. Browser tests cover theme persistence, system appearance, sidebar collapse, keyboard navigation, and the mobile sidebar.

Optional infrastructure adapters, configuration precedence, backup rules, and `pnpm test:services` are documented in [infrastructure](docs/infrastructure.md). Keep provider SDK calls in the adapters and durability/authorization in the application services.

Settings pages show current state first and open task-specific editors from their actions. Reuse `MarkdownField`, `TicketPicker`, and `TagInput` for ticket writing and metadata instead of exposing UUIDs or comma-separated text fields. `useModalBusy()` prevents closing a shared dialog while a write is pending. Account cache persistence must be paused before clearing private browser data on sign-out; the persister library can still have queued writes.

Ticket lists use TanStack column visibility and the shared `TicketListControls` composition. Display choices are local to the signed-in user and persist in this browser; sign-out clears them with other private browser data. Filters and ordering remain in the URL and saved views. Query `list_ticket_labels` for label choices across the whole project, never derive them from a paginated ticket list. Keep selection actions in `TicketSelectionToolbar` outside document flow so checking a row cannot shift the list. Relationship labels, inverse choices, and parsing come from the contracts package for both web and native.
