<picture>
  <source media="(prefers-color-scheme: dark)" srcset="apps/web/public/brand/mark-white.svg">
  <img src="apps/web/public/brand/mark-blue.svg" alt="Kanvil anvil" width="144" height="72">
</picture>

# Kanvil

Open-source, self-hosted ticketing built around how agents discover, claim, update, and complete work, with web and native mobile apps for people.

Kanvil owns its ticket data and runs on your infrastructure. It supports local login and generic OIDC; PocketID is covered by browser and iOS integration checks.

## Status

The standalone backend, web workspace, and native app are implemented. Self-hosting, recovery, and database/attachment restoration are tested. Native Release compilation has been verified on iOS Simulator and Android.

See [self-hosting](docs/self-hosting.md), [agent/API interfaces](docs/api.md), [native builds](docs/mobile.md), and the [verification record](docs/verification.md).

Projects can be grouped into separate [workspaces](docs/workspaces.md), with inherited or private access, library or uploaded project icons, and instance account administration.

## Installation

Install the app with `npm install --global @maudecode/kanvil`, or run `ghcr.io/maudecode/kanvil` with Docker Compose. Both need PostgreSQL 18. See [installation and upgrades](docs/self-hosting.md) for configuration, HTTPS, first-owner setup, and backups. These registry paths become available after the first published release.

[Release setup](docs/releasing.md) covers version tags, npm trusted publishing, and GHCR permissions.

## Development

See [CONTRIBUTING.md](CONTRIBUTING.md) for setup and checks, and [AGENTS.md](AGENTS.md) for agent instructions.

## Plan

See the [delivery plan](docs/plan.md) for scope, chosen libraries, build order, and acceptance criteria.

## License

[MIT](LICENSE).
