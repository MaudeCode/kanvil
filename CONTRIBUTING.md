# Contributing to Kanvil

## Setup

Install the Node version from `.node-version` and the pnpm version from the `packageManager` field in `package.json`, then run:

```sh
pnpm install --frozen-lockfile
pnpm db:up
pnpm check
```

The workspace includes `apps/*` and `packages/*`. `compose.dev.yml` runs an isolated development PostgreSQL instance on loopback port 55462. Tests create and remove their own databases; set `TEST_DATABASE_URL` to use another dedicated test PostgreSQL server. Stop the development service with `pnpm db:down`.

## Checks

`pnpm check` is the local and CI entry point for formatting, linting, TypeScript checks, and tests. Vite+ provides Oxfmt, Oxlint, and Vitest; configuration lives in `vite.config.ts` and the TypeScript configs.

Use `pnpm fmt` to format files, `pnpm lint` for linting, `pnpm typecheck` for type checks, and `pnpm test` for a test run. Target an individual suite with `pnpm exec vp test run path/to/file.test.ts`.

Tests cover the shared contracts and the PostgreSQL/authentication foundation. An empty suite fails. Each workspace package has a TypeScript config extending the shared base.

## Changes

Keep each pull request focused on one coherent change. Describe the resulting behavior and the validation performed. Add regression coverage for meaningful behavior changes and update relevant instructions when their commands change.

Dependencies are pinned to exact versions and resolved in `pnpm-lock.yaml`. Use current stable compatible releases when adding or updating dependencies; verify compatibility rather than forcing upgrades with overrides. Update the Node pin together with its supported engine range and matching Node type definitions when needed.

The single CI job runs on pull requests and pushes to `main`. Dependency updates arrive as grouped Dependabot pull requests for review.
