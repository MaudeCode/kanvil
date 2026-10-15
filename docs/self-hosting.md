# Self-hosting

Kanvil runs as one application service and PostgreSQL 18. Tickets, comments, authentication, durable events, and attachment bytes live in PostgreSQL. PocketID is optional; local login remains available alongside OIDC.

## Docker Compose

Install Docker with Compose and the repository's Node/pnpm versions. From a fresh checkout:

```sh
pnpm install --frozen-lockfile
pnpm configure --production https://kanvil.example.com
docker compose up -d --build --wait
```

Configuration creates a mode-600 `.env` with independent random database, authentication, and initial setup secrets. It refuses to overwrite an existing file. Use an HTTPS origin without a path. Set up your HTTPS reverse proxy before opening that address. The application binds to loopback port 5180; change the host port with `KANVIL_PORT`.

Open the site, enter `KANVIL_SETUP_TOKEN` from your private configuration, and create the owner account. Setup closes after the first account exists. Create additional accounts in Settings, then grant access through project settings. Remove the setup token from configuration after onboarding if desired.

Retain `.env` securely. `BETTER_AUTH_SECRET` is required to read encrypted authentication state after restoration. Changing it is a deliberate credential rotation, not a routine upgrade.

The application container runs as the `node` user with a read-only root filesystem and temporary `/tmp`. Its health check verifies database connectivity. PostgreSQL storage is kept in the `postgres-data` volume. `docker compose down` retains that volume; removing volumes deletes instance data.

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

## Backup

Run from the configured checkout:

```sh
pnpm backup --output /secure/location/kanvil.dump
```

The command uses the PostgreSQL tools inside the database container to create a consistent custom-format archive. It includes attachment bytes and authentication tables. The output is private and existing files are never overwritten. Keep the original instance configuration, especially `BETTER_AUTH_SECRET`, securely with your backup. Copy backups off the application host using your normal protected backup storage.

## Restore without replacing the original database

Restore into a new, unused database name:

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

Back up first, review changes, then rebuild and recreate the app with `docker compose up -d --build --wait`. Startup applies the committed schema migrations under a database advisory lock. Database migrations and the application version should be upgraded together. Restore a backup into a new database if an incompatible database change requires rollback.

`pnpm test:docker` builds the image and starts an isolated Compose instance with generated test secrets. A real browser creates an owner, project, and ticket; the official MCP client connects; then the test recovers the account, backs up and restores into a new database, and verifies sessions, scoped credentials, tickets, and original attachment bytes. It also checks that existing backup files and databases are refused. Its containers and test volumes are removed afterward.

For standalone Node hosting, run `pnpm build`, provide the same configuration through the environment, and run `NODE_ENV=production pnpm --filter @kanvil/server start`. Use a PostgreSQL 18 service you operate and include its database in your backup process. The Docker backup/restore commands target the Compose database service.
