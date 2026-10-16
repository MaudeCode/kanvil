# Self-hosting

Kanvil runs as one application service and PostgreSQL 18. Tickets, comments, authentication, durable events, and attachment bytes live in PostgreSQL. PocketID is optional; local login remains available alongside OIDC.

## Install from npm

Requires Node `>=24.22.0 <25` and a PostgreSQL 18 server. The package includes the backend, built web app, and schema migrations; pnpm and a source checkout are unnecessary. Package and image installation become available after the first release is published; see [release setup](releasing.md).

```sh
npm install --global @maudecode/kanvil
mkdir kanvil-instance
cd kanvil-instance
kanvil configure --production https://kanvil.example.com
```

`configure` creates a mode-600 `.env` in the current directory and refuses to overwrite it. Edit `DATABASE_URL` to point at your PostgreSQL database, using a role that owns the database and can run schema migrations. For a PostgreSQL service on the same host, an administrator can create it with `createuser --pwprompt kanvil` and `createdb --owner=kanvil kanvil`. Set `DATABASE_URL=postgres://kanvil:URL_ENCODED_PASSWORD@127.0.0.1:5432/kanvil` and `HOST=127.0.0.1` in `.env`. The generated `POSTGRES_PASSWORD` belongs to the Compose path; use the password you assigned to the standalone database role instead.

```sh
kanvil start
```

Run from the instance directory so the CLI reads its `.env`. Startup defaults to production mode and applies migrations before listening. `kanvil migrate` applies migrations without starting HTTP; `kanvil recover --email admin@example.com` prompts privately for a replacement local password. `kanvil --version` reports the installed package version. Use a service manager to keep the process running, with the instance directory as its working directory and the absolute path from `command -v kanvil` as its executable. Run it as an unprivileged account that can read the configuration.

For an upgrade, back up PostgreSQL and `.env`, stop the service, install the desired version with `npm install --global @maudecode/kanvil@VERSION`, then restart from the same instance directory. `@latest` selects the latest stable release. Keep the same database URL and authentication secret. See the standalone backup instructions below before upgrading.

## Install the published Docker image

Install Docker with Compose. No Node installation or source checkout is required. In an empty instance directory, download `compose.yml` from the [release's tagged source](https://github.com/MaudeCode/kanvil/tags). Replace `X.Y.Z` with a published version:

```sh
kanvil_version=X.Y.Z
curl -fL "https://raw.githubusercontent.com/MaudeCode/kanvil/v${kanvil_version}/compose.yml" -o compose.yml
```

Create `.env` with an HTTPS origin and independent secrets:

```sh
umask 077
cat > .env <<EOF
KANVIL_URL=https://kanvil.example.com
POSTGRES_PASSWORD=$(openssl rand -hex 32)
BETTER_AUTH_SECRET=$(openssl rand -hex 48)
KANVIL_SETUP_TOKEN=$(openssl rand -hex 32)
KANVIL_IMAGE=ghcr.io/maudecode/kanvil:latest
EOF
docker compose pull
docker compose up -d --wait
```

The image supports Linux amd64 and arm64. Replace `latest` with a release version such as `0.1.0`, or pin `ghcr.io/maudecode/kanvil@sha256:YOUR_DIGEST` for an immutable deployment. Use a published version; these examples do not assert that `0.1.0` already exists. The first GHCR publication must be made public by a repository administrator, as described in [release setup](releasing.md).

The app binds to loopback port 5180; change the host port with `KANVIL_PORT`. Set up the HTTPS reverse proxy below before opening the site. The application runs as the `node` user with a read-only root filesystem and temporary `/tmp`. Its health check verifies database connectivity. PostgreSQL storage is kept in the `postgres-data` volume. `docker compose down` retains that volume; removing volumes deletes instance data.

For source builds, use the repository's Node/pnpm versions and run:

```sh
pnpm install --frozen-lockfile
pnpm configure --production https://kanvil.example.com
docker compose -f compose.yml -f compose.build.yml up -d --build --wait
```

Keep both `-f` arguments on subsequent Compose operations for a source-built instance.

## First owner and configuration

Open the site, enter `KANVIL_SETUP_TOKEN` from your private configuration, and create the owner account. Setup closes after the first account exists. Create additional accounts in Administration → Users, then grant workspace access from the account detail sheet or workspace settings. Projects can inherit workspace roles or keep explicit private membership. Existing projects stay private when upgrading; see [workspaces](workspaces.md). Remove the setup token from configuration after onboarding if desired.

Retain `.env` securely. `BETTER_AUTH_SECRET` is required to read encrypted authentication state after restoration. It also encrypts saved integration credentials. Changing it is a deliberate credential rotation, not a routine upgrade. Both install paths serve the web app, API, MCP, and realtime at the same origin.

## HTTPS and streaming

Serve Kanvil at its own origin. A Caddy example is:

```caddyfile
kanvil.example.com {
    reverse_proxy 127.0.0.1:5180
}
```

With nginx, forward the original host and protocol, turn off response buffering for SSE, and allow persistent streaming connections:

```nginx
location / {
    proxy_pass http://127.0.0.1:5180;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_buffering off;
    proxy_read_timeout 1h;
}
```

Keep `KANVIL_URL` equal to the public HTTPS origin. Add `KANVIL_TRUSTED_ORIGINS` only for additional browser clients you explicitly operate. Web, API, MCP, login, consent, and realtime use the same application origin. No separate message broker or search service is required.

Signed-in sessions and MCP OAuth clients may make `KANVIL_SESSION_WRITE_LIMIT` write requests per minute (120 by default) before receiving `429 rate_limited`; API keys are limited separately by the authentication layer. The counter is per application process.

## PocketID / OIDC

Create a confidential OIDC client in PocketID, enable PKCE, and register:

```text
https://kanvil.example.com/api/auth/callback/oidc
```

Set all three values together in `.env`, then recreate the app:

```dotenv
OIDC_DISCOVERY_URL=https://identity.example.com/.well-known/openid-configuration
OIDC_CLIENT_ID=your-client-id
OIDC_CLIENT_SECRET=your-client-secret
OIDC_NAME=PocketID
```

Sign in locally and explicitly link PocketID from account settings. Public signup and implicit account linking are closed. Use HTTPS for the provider, including native sign-in; the Expo integration requires it. The provider's ID-token signature is verified. For a private certificate authority, add a `compose.override.yml` pointing at its public certificate:

```yaml
services:
  app:
    environment:
      NODE_EXTRA_CA_CERTS: /certificates/identity-ca.pem
    volumes:
      - ./identity-ca.pem:/certificates/identity-ca.pem:ro
```

Native devices must also trust that authority. Never mount the authority's private key.

## Instance administration

Administrators can edit the instance name and description, manage accounts, and configure local/S3 file storage, PostgreSQL/Elasticsearch search, and PostgreSQL/RabbitMQ event delivery in Administration. See [optional infrastructure](infrastructure.md) for deployment variables, adapter interfaces, recovery behavior, and S3 backup requirements. OIDC, public URL, and push credentials remain deployment settings.

## Optional mobile push

Set `KANVIL_PUSH_ENABLED=true` to enable the Expo push transport. If the Expo project has push access-token security enabled, also set its server-held `EXPO_ACCESS_TOKEN`. Recreate the app after changing configuration. A signed mobile build must contain the public Expo project ID and have APNs/FCM credentials configured; see [mobile setup](mobile.md). Accounts opt in through Settings and register each device separately.

Push is disabled by default. Ticket storage, login, Inbox, realtime, and MCP work without Expo services. Push messages use a generic update notice and ticket identifiers, without ticket titles, descriptions, comments, or evidence. The database outbox commits with each subscribed event, checks current account/project/session/subscription access before every send, retries failures, and checks Expo receipts. Expired login sessions and explicit session revocation remove their device registrations. A failed or interrupted transport may deliver duplicates; queued notices expire after one day. Delivery status is available in the `push_deliveries` table. Backups contain device tokens, so protect them alongside authentication state.

## Backup

For a published Docker installation, run from the instance directory:

```sh
umask 077
docker compose exec -T db pg_dump -U kanvil -d kanvil --format=custom > /secure/location/kanvil.dump
```

Use a new output filename and check that `pg_dump` succeeds before treating it as a backup. Replace `kanvil` after `-d` if `KANVIL_DATABASE` differs. For npm installations, use PostgreSQL 18 client tools against the configured database:

```sh
umask 077
pg_dump --host=127.0.0.1 --username=kanvil --dbname=kanvil --format=custom --file=/secure/location/kanvil.dump
```

Supply authentication through a protected `.pgpass` or a password prompt. Keep `.env` and any external S3 backups alongside the database backup. For a source checkout, the existing wrapper refuses to overwrite backup files:

```sh
pnpm backup --output /secure/location/kanvil.dump
```

The command uses the PostgreSQL tools inside the database container to create a consistent custom-format archive. It includes locally stored attachment/photo bytes, pending external uploads, authentication tables, and encrypted integration settings. Completed S3 uploads need a separate backup of each referenced bucket. The output is private and existing files are never overwritten. Keep the original instance configuration, especially `BETTER_AUTH_SECRET`, securely with your backup. Copy backups off the application host using your normal protected backup storage.

## Restore without replacing the original database

Stop the application before switching databases. For a published Docker install:

```sh
docker compose stop app
docker compose exec -T db createdb -U kanvil kanvil_restored
docker compose exec -T db pg_restore -U kanvil -d kanvil_restored --exit-on-error --single-transaction < /secure/location/kanvil.dump
```

For npm, stop the service, create an unused database with `createdb --host=127.0.0.1 --username=kanvil kanvil_restored`, then run `pg_restore --host=127.0.0.1 --username=kanvil --dbname=kanvil_restored --exit-on-error --single-transaction /secure/location/kanvil.dump`. Change `DATABASE_URL` in the instance `.env` to the restored database, retain the original authentication secret, and restart the service. A failed restore leaves the new target available for inspection; keep the original database.

For the source wrapper, restore into a new, unused database name:

```sh
pnpm restore --file /secure/location/kanvil.dump --database kanvil_restored
```

The command refuses existing databases and restores in a single transaction. If it fails, the newly created target remains available for inspection; the previous database is retained. After a successful restore, set `KANVIL_DATABASE=kanvil_restored` in `.env`, retain the original authentication secret, and switch the application:

```sh
docker compose up -d --no-deps --wait app
```

Check login, tickets, attachment downloads, and consumer access before deleting any old database. Compose constructs the runtime `DATABASE_URL` from `POSTGRES_PASSWORD` and `KANVIL_DATABASE`; the `DATABASE_URL` entry in `.env` is also available for standalone Node operations. Use `COMPOSE_PROJECT_NAME` consistently if you operate multiple Compose instances.

## Account recovery

A host operator can replace an existing account's local password:

```sh
docker compose exec app node dist/recover.mjs --email admin@example.com
```

The password is entered privately. For local source development, use `pnpm account:recover --email admin@example.com`. The command uses Better Auth's password format and revokes that account's sessions. Its role, linked OIDC account, and API credentials are retained. Revoke agent credentials separately if an account was compromised. Passwords are never accepted as command-line arguments.

## Updates and validation

Back up first and review changes. For published images, set the desired `KANVIL_IMAGE` in `.env`, then run `docker compose pull app` and `docker compose up -d --no-deps --wait app`. Source builds use `docker compose -f compose.yml -f compose.build.yml up -d --build --wait`. Startup applies the committed schema migrations under a database advisory lock. Database migrations and the application version should be upgraded together. Restore a backup into a new database if an incompatible database change requires rollback.

`pnpm test:docker` builds the image and starts an isolated Compose instance with generated test secrets. A real browser creates an owner, project, and ticket; the official MCP client connects; then the test recovers the account, backs up and restores into a new database, and verifies sessions, scoped credentials, tickets, and original attachment bytes. It also checks that existing backup files and databases are refused. Its containers and test volumes are removed afterward.

For standalone Node hosting, run `pnpm build`, provide the same configuration through the environment, and run `NODE_ENV=production pnpm --filter @kanvil/server start`. Use a PostgreSQL 18 service you operate and include its database in your backup process. The Docker backup/restore commands target the Compose database service.

Project icon rendering uses a bundled offline Lucide collection through Iconify. It does not require an external icon API. Icon license notices are served at `/third-party-icons.txt`; Kanvil remains MIT licensed.
