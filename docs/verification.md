# Initial delivery verification

Kanvil's implementation is contained in this repository, under the MIT license. It uses its own PostgreSQL storage and has no Kaneo dependency or import requirement. External agent runners adopt its documented interfaces separately.

## Delivered behavior

- Projects, stable ticket keys, wrapping titles, Markdown requirements, assignment, labels/scopes, parent/child context, blockers, related/duplicate tickets, comments, activity, attachments, subscriptions, saved views, search/filtering, pagination, bulk edits, archiving, and deletion.
- Shared versioned HTTP/OpenAPI and MCP operations, permission-filtered durable SSE replay, snapshot recovery, optimistic concurrency, idempotent writes, eligibility reasons, exclusive claims, renew/release/recovery, and attributed evidence.
- React web and Expo native apps with local/OIDC login, explicit account linking, secure native sessions, live updates, cached reading, and local drafts.
- Agent-aware Inbox preferences and optional session-bound push registration/delivery, with a transactional outbox, retries, receipts, and access checks.
- Non-root Docker application plus PostgreSQL, private configuration generation, migrations, local account recovery, and tested backup/restore including attachment bytes.
- Runnable scoped MCP and durable realtime reference consumers, native build profiles, CI, and operator documentation.

## Evidence

| Area                   | Verification                                                                                                                                                                                                                                                                                                                          |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Repository checks      | `pnpm check`: formatting, linting, TypeScript, and 44 tests across six suites. Tests use isolated databases.                                                                                                                                                                                                                          |
| Domain and permissions | Concurrent/stale writes, idempotent retries, competing/expired claims, persistent ownership fencing, dependency cycles, project/credential isolation, attachment bytes, and account recovery/session revocation.                                                                                                                      |
| Browser and OIDC       | Chromium workspace flows with 55-ticket pagination, wrapping titles, drafts, stale edits, attachments, credential revocation, hierarchy navigation, actual PocketID virtual-passkey linking/login, and interactive MCP OAuth consent/PKCE.                                                                                            |
| Realtime and consumers | Ordered replay, live changes, abort/reconnect behavior, service restart, persisted projection checkpoints, expired-cursor snapshots, scoped MCP reads, and stream revocation without consuming per-frame API allowance. Both reference CLI entry points were executed against an isolated server.                                     |
| Self-hosting           | Actual Compose image startup, browser owner/project/ticket creation, official MCP connection, bundled password recovery, revoked sessions, private backups, restoration into a new database, retained sessions/credentials, exact binary attachment readback, and refusal to overwrite backups/databases.                             |
| iOS                    | Development and standalone Release simulator builds. Release code-signature verification, embedded bundle, HTTPS/local login, native system-browser PocketID linking and sign-in, complete ticket context, session restoration, and cached reading. Metro was stopped during Release validation.                                      |
| Android                | Standalone arm64 Release APK compiled by the preview workflow, APK signature verified, embedded JavaScript verified, artifact and MIT license retained. Both native Hermes exports and Expo dependency compatibility checks pass.                                                                                                     |
| Push                   | Isolated-transport tests with real PostgreSQL cover outbox commits, receipt processing, retries, access changes between sends, session revocation, shared-device account changes, omitted-field compatibility, ticket-deletion notices, and explicit unsubscribe cancellation. Native preference changes were read back through HTTP. |

The release configuration and Android artifact checks are recorded in [PR #12](https://github.com/MaudeCode/kanvil/pull/12). Implementation was committed in coherent slices and merged after review and green CI.

## Boundaries

Production deployment and app-store publication have not been performed. Existing real PocketID accounts and signing credentials were not used; identity-provider checks used a disposable instance.

No physical-device installation or runtime validation has been performed. Android emulator execution and device passkeys also remain unvalidated. Preview APKs use a generated debug signing key. iOS simulator signing is ad hoc; real distribution needs operator-owned signing configuration.

Real APNs/FCM delivery and notification-tap routing remain unvalidated. They require an Expo project and authorized push/signing configuration. Push is optional and disabled by default; ticket storage, login, Inbox, realtime, and MCP work without it.

The reference mirror refreshes a full project snapshot when changes arrive. It is an example of consistent recovery, not an execution scheduler. Apps retain explicit local drafts; offline edits are not automatically submitted. Rich-text editing, custom workflow designers, and separate search/message-broker services remain outside the agreed initial scope.

## Interface redesign

The web and iPhone interfaces share the palette and brand geometry described in [the design direction](design.md). Web fonts are bundled locally with their OFL license. Existing controls and renderers were extended; ticket mutations and authentication contracts retain their shared implementations.

- Chromium regression coverage checks light/dark appearance at 1440, 1024, 650, 390, and 320 pixels, including complete long/unbroken titles, viewport and table overflow, selection, expandable filters, persisted/system theme changes, reduced motion, and keyboard navigation into the main content.
- An independent WebKit run checked local sign-in, both themes at the same five widths, accessible table rows, complete title bounds, and selection.
- Projects, account settings, project settings, and Inbox were inspected at desktop and phone widths. Both themes, ticket details, wrapping title editors, and empty states were captured. These checks found no browser exceptions or page-level horizontal overflow. Create/update contract and persisted-search regressions also verify that pasted line breaks become single-line title text. Shared text colors meet a 4.5:1 contrast ratio against both canvas and surface colors in each theme.
- The redesigned standalone iOS Release app was built, signed, and run with an isolated HTTPS backend. Local sign-in, project and ticket navigation, the header project sheet, status picker, Markdown preview, and native edit/save were exercised. A separate HTTP client confirmed the edited title and incremented version. Session restoration after reinstall/relaunch, dark appearance, and large Dynamic Type ticket reading after relaunch were inspected.

The existing 44 tests and browser workspace/OAuth workflows pass. CI additionally exercises the disposable PocketID workflow and self-hosting smoke test. Android runtime is outside this redesign; physical-device, push-delivery, and production boundaries above still apply.

## Reproduce

The approved anvil is applied to web/native brand components, application and launch-screen assets, favicons, touch/install icons, share metadata, and the README. Branding browser coverage checks the actual self-hosted asset URLs, loaded font, manifest icons, and absolute share-image URLs on root and nested pages. The iOS Release build with build number 2 was installed and its home-screen icon and native branding inspected in both themes; launch-screen resources were generated, compiled, and observed during a recorded cold launch of that binary. See [branding](branding.md) for the source and regeneration command.

Use [CONTRIBUTING.md](../CONTRIBUTING.md) for checks and disposable fixtures, [self-hosting](self-hosting.md) for Compose/backup/recovery, [native builds](mobile.md) for simulator/preview/signing setup, and [examples](../examples/README.md) for external consumer integration.

## Workspaces, identity, icons, and account administration

The workspace/account update was verified locally without publishing a branch or deployment:

- `pnpm check`: formatting, linting, workspace TypeScript checks, and 76 passing tests. The two optional live-service tests remain conditional on their isolated infrastructure fixtures.
- `pnpm test:oidc`: 20 browser workflows passed, including disposable PocketID linking/login, interactive MCP consent/PKCE, workspace switching and deep links, inherited/private access, project icon selection/upload/reset, user administration, and role-dependent cache cleanup.
- `pnpm test:docker`: packaged browser/API/MCP checks and database backup/restore passed, including workspace association, attachment bytes, and uploaded project icon bytes.
- PostgreSQL tests upgrade populated pre-workspace data without widening private access; cover inherited/explicit roles, guest and scoped-key isolation, revoked membership, retry receipts, concurrent administrator changes, and library/image validation and cleanup protection.
- Account tests exercise name/email search, filters, safe response fields, last-administrator protection through role/update/ban/delete paths and normalized URLs, password/session changes, public-profile role restrictions, and concurrent role edits.
- Rendered project/workspace settings, member directories, user lists/detail sheets, icon selection, and API-key project choices were reviewed in light/dark at 1440, 390, and 320 pixels. Fixes included circular clipping, cached profile photos, sidebar label/prefix overlap, long identity wrapping, and narrow-container settings layouts.
- Native account role parsing and persisted-cache versions share the same administrator-role rule. This update does not claim a new physical-device installation or validation.

All integration fixtures use disposable test-owned databases/accounts. Existing project identifiers and ticket prefixes are retained. Local review remains separate from publication approval.

## Linear layout and named palettes

The web app now uses compact shared controls, navigation, table rows, settings rows, and typography. Compact and Comfortable ticket density are personal browser preferences. Table layout remains available on laptop widths, with the title taking the remaining space; phone layouts retain wrapping titles and larger touch targets. The shadcn inset sidebar, resizing, keyboard access, and contextual actions remain in use.

The default palette is Linear. Eighteen named themes have light/dark mappings and a searchable gallery. Built-in palette checks cover body, sidebar, muted, secondary, popover, primary-button, and status-text contrast. Custom JSON import/export remains version one, and old built-in IDs resolve to named replacements. Sources and notices are listed in [themes](themes.md).

Validation for this pass:

- `pnpm check` passes formatting, linting, all workspace type checks, and 80 tests. Two optional live-service suites remain skipped.
- `pnpm test:e2e` passes 24 browser workflows, including all 18 palettes in both appearances, system appearance, theme persistence, custom import/export, searchable theme choices, compact/comfortable density, list properties, selection, relationships, authentication, and the existing ticket/account/settings workflows.
- Playwright captured the main page families in both modes at desktop and phone widths. Additional project/workspace/member/user/account/icon checks include 320px layouts. Captures are local under `dist/ui-review/linear-pages`, `dist/ui-review/workspaces-users`, and `dist/ui-review/linear-redesign`; they are not tracked.
- Existing local preview content was checked through the LAN app. Selection caused zero row movement at 1440px, 390px, and 320px; these checks found no page-level horizontal overflow or browser exceptions.

This pass validates the web app. It does not claim a new native build, physical-device validation, or production publication.
