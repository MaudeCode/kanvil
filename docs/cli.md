# Task CLI

The installed `kanvil` executable includes a task client alongside its service commands. It uses `@kanvil/client` and the same operation schemas, permissions, version checks, claims, and request receipts as HTTP and MCP. No running local service or local `.env` is needed for client commands.

## Private profiles

Create a scoped API credential in **Settings → Credentials**, granting only the projects and scopes you need (`read`, `write`, `claim`, or `admin`). Feed it through stdin, never a command argument or shell history:

```sh
read -rs KANVIL_CLI_TOKEN
printf '%s' "$KANVIL_CLI_TOKEN" | kanvil profile set work \
  --server https://kanvil.example.com --project PROJECT_ID --token-stdin
unset KANVIL_CLI_TOKEN
```

Profiles live in `~/.config/kanvil/client.json`, created atomically with mode `600` in a private directory. `--config PATH` selects a separate configuration. Existing files must be private regular files, never symlinks. The file contains credentials: keep it out of repositories and shared backups. HTTPS is required except on loopback. Redirects are refused so credentials cannot follow another origin.

Every command selects one server/project/credential with `--profile NAME` (default: `default`). A profile's project cannot be overridden by operation input; create a separate profile for another project. Leave `--project` out for discovery or operations whose input selects a project, subject to the credential's server-enforced project scope. `profile list` excludes tokens. Replacing a profile or removing it (`profile remove NAME --yes`) requires `--yes`. Never share a configuration file between concurrent profile editors; saves replace the file atomically, but do not merge concurrent edits.

## Commands and scripting

`kanvil task --help` lists all client commands. Results are the operation's JSON response, indented by default or compact with `--json`. API values, keys, timestamps, and field names stay unchanged. Lists retain the API's pagination (`limit`, `offset`, `total`, `items`); pass filters and pagination through `--input`.

```sh
kanvil workspace list --profile work --json
kanvil project list --profile work
kanvil project get --profile work
kanvil task list --profile work --input '{"q":"retry","limit":50,"offset":0}'
kanvil task get APP-12 --profile work
kanvil task create --profile work --title 'Make retries safe'
kanvil comment add APP-12 --profile work --body 'Regression verified'
kanvil comment list APP-12 --profile work
kanvil task ready --profile work
```

`task ready` returns eligibility with explicit reasons for each open ticket; callers must inspect readiness rather than assume every returned ticket is ready. `project create` takes `key`, `name`, and optional `workspaceId` through `--input`.

`--input JSON` accepts an operation input object. `--input -` reads the object from stdin, including Markdown and advanced fields without shell escaping. Names and schemas match the [HTTP API](api.md) and `/api/openapi.json`. Unknown input fields fail locally. A positional ticket key/ID and flags fill the corresponding fields; conflicting ticket or project identifiers fail. Explicit flags override the corresponding JSON fields. No data is read implicitly from stdin.

```sh
kanvil task create --profile work --input - <<'JSON'
{
  "title": "Make retries safe",
  "description": "Preserve the original write identity.",
  "acceptanceCriteria": "A lost response creates one ticket.",
  "difficulty": "med",
  "automationReady": true
}
JSON
kanvil task update APP-12 --profile work --expected-version 3 \
  --changes '{"priority":"high"}'
kanvil claim acquire APP-12 --profile work --input '{"expectedVersion":4,"workerId":"worker-1"}'
kanvil claim renew APP-12 --profile work --input '{"claimId":"CLAIM_UUID","leaseSeconds":300}'
kanvil claim release APP-12 --profile work --input '{"claimId":"CLAIM_UUID"}'
kanvil task delete APP-12 --profile work --expected-version 7 --yes
```

Use the version returned by a read or write. The CLI never fetches a newer version to bypass a conflict. Claims retain the server's readiness, ownership and lease rules; include `claimId` in an update when the operation requires it. Deletion requires an explicit version and `--yes`; noninteractive invocations receive no confirmation prompt.

The typed client retries a transport failure once for reads and receipted writes, using the identical request body, request ID and expected version. HTTP errors, including conflicts, are never retried. For a retry across CLI invocations, supply the original `--request-id UUID` (or `requestId` in JSON) and unchanged input. If both transport attempts fail, the outcome may be unknown: reconcile by reading or replaying that same request ID; do not submit a new write identity blindly. Requests have a finite transport timeout.

Failures write one JSON object `{ "error": { "code": "...", "message": "..." } }` to stderr, leaving stdout empty. Error codes from the server are preserved, but server messages, validation input and transport details are excluded to avoid echoing secrets. The active token is redacted from output. Exit codes are stable:

| Code | Meaning                                                              |
| ---- | -------------------------------------------------------------------- |
| 0    | Success                                                              |
| 1    | Server error, invalid response, configuration I/O, or other failure  |
| 2    | Invalid command/input/profile/configuration, or missing confirmation |
| 3    | Authentication, permission or credential-scope refusal               |
| 4    | Not found                                                            |
| 5    | Version, claim or other conflict                                     |
| 6    | Network failure or timeout; a write may have committed               |

Service commands keep their existing behavior: no argument starts the server; `start`, `configure`, `migrate`, `recover`, `--version` and `--help` remain available. They still read service configuration from the current directory. Interactive OAuth/device login is outside this CLI's initial scope.
