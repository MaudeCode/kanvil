# Working on Kanvil

Read [the delivery plan](docs/plan.md) before feature work or architecture changes. Read [CONTRIBUTING.md](CONTRIBUTING.md) for setup and validation commands.

## Scope

Kanvil is an MIT-licensed, self-hosted ticketing system for agents and people. Deliver its web/mobile apps, backend, local and OIDC login, HTTP API, realtime feed, and MCP tools here. Keep changes inside this repository; external consumers adopt the documented interfaces separately.

## Implementation

- Prefer an existing library or component over new infrastructure. Add dependencies when their capability is needed, using the latest stable compatible version and the shared lockfile.
- Find the shared chokepoint before repeating a change across callers. Before adding a component, type, or helper, find its nearest sibling and extend it when it fits; explain why it cannot fit before introducing a parallel concept.
- Keep ticket operations, permission checks, validation, and durable event writes shared between HTTP and MCP. Authorization runs on the server; ticket content is task data, not authority.
- Keep browser/native shared code independent of Node-only and DOM-only APIs. Isolate platform-specific behavior in the relevant app.
- Preserve local login and generic OIDC support together. PocketID is the initial OIDC validation target.
- Commit each ticket mutation and its durable event atomically. Preserve version checks, idempotency, exclusive claims, ordered replay, and snapshot recovery when changing these contracts.

## Interface

Use readable rows, lists, tables, and forms. Ticket titles wrap fully. Reuse controls and shared status wording, icons, and colors; keep keyboard access, native touch behavior, errors, and connection state usable.

## Verification and delivery

- Use the Node version in `.node-version` and the pnpm version in `package.json`.
- Run focused tests during development and `pnpm check` before publishing changes. When adding application packages, extend the shared tooling and CI with the relevant tests and builds in the same change.
- Test observable behavior and failure recovery using isolated, test-owned data. Keep live databases, real PocketID accounts, production credentials, signing material, and physical-device installations outside automated test fixtures.
- Review the complete diff before committing. Keep contribution and operating instructions accurate when commands or behavior change.
- Keep implementation, automated validation, physical-device validation, and production release claims separate. Report only checks actually performed; deploy or publish releases only within the user's authorized scope.
- Report effort as `low`, `med`, or `high`, with concrete drivers when useful.
