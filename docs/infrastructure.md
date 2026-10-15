# Optional infrastructure

Kanvil needs only its application service and PostgreSQL. Administrators can configure optional S3-compatible storage, Elasticsearch-compatible search, and RabbitMQ under **Administration**. Local login and OIDC continue to share the same accounts and permissions.

## Configuration and credentials

Provider choices and integration credentials are saved in PostgreSQL. Credentials are encrypted with AES-256-GCM using an instance key derived from `BETTER_AUTH_SECRET`; they are never returned by the administration API. Empty secret fields retain saved credentials. Keep this secret with the database backup or the saved credentials cannot be decrypted after restoration.

An explicit `KANVIL_STORAGE_PROVIDER`, `KANVIL_SEARCH_PROVIDER`, or `KANVIL_BROKER_PROVIDER` overrides the corresponding admin selection and makes its fields read-only. Omit a provider variable to use the saved admin configuration. Setting `local` or `postgres` explicitly also overrides saved external settings. Deployment changes require an application restart; admin changes apply to running instances automatically.

Test connection buttons perform actual readback. Saving a changed external configuration also tests it before activation. Changing the instance name does not require an unchanged external service to be online. Concurrent settings edits use a version check and return HTTP 409 instead of overwriting each other.

## Files

Local storage keeps attachments and profile photos as database bytes. No extra filesystem volume or service is needed, and these bytes are included in PostgreSQL backups.

For S3-compatible storage, create a private bucket and choose **File storage → S3-compatible object storage**. Supply its endpoint, region, bucket, key prefix, and credentials. Leave the endpoint empty for Amazon S3. Omitted credentials use the AWS SDK credential chain, including workload identity when configured. Use path-style URLs for providers that require them.

The deployment equivalent is:

```dotenv
KANVIL_STORAGE_PROVIDER=s3
S3_ENDPOINT=https://s3.example.com
S3_REGION=us-east-1
S3_BUCKET=kanvil
S3_PREFIX=kanvil/
S3_FORCE_PATH_STYLE=true
S3_ACCESS_KEY_ID=your-access-key
S3_SECRET_ACCESS_KEY=your-secret-key
```

Grant only object read/write/delete access under the selected prefix. Kanvil does not make the bucket public or expose signed bucket URLs. Downloads pass through Kanvil's authorization checks. Profile uploads accept PNG, JPEG, and WebP, and the browser crops and resizes them before upload.

Uploads commit their bytes and destination in the same database transaction as their metadata. A worker then uploads the object, reads it back, verifies SHA-256, and clears the database copy. Pending files remain readable from PostgreSQL during an outage. A crash after the remote upload safely retries the same object key. Slow external transfers do not hold the ticket mutation lock. Administration shows pending transfers and failures.

Changing providers affects new files. Existing files retain their original backend and prefix; switching to local storage does not make old S3 objects local. Saved credentials for an existing location can be rotated without rewriting file references. Unreferenced files are collected after a grace period, with a manual cleanup action in Administration. Keep old bucket access available while files still reference it.

Back up the database, `BETTER_AUTH_SECRET`, and every referenced S3 bucket. A database dump includes local bytes and pending transfers, but completed S3 transfers require a bucket backup. Restore both before reopening downloads. Search and broker data are rebuildable and are not file backups.

## Search

PostgreSQL searches ticket keys, titles, descriptions, acceptance criteria, labels, and scopes. It remains the default and the fallback when an optional search service is behind or unavailable.

Choose **Search → Elasticsearch-compatible search** and a dedicated, unused index name. Kanvil records its instance identity in the index mapping and refuses to reset an index owned by another application or instance. The connection test verifies index creation, object write/read/delete, and ownership. Configure an API key or basic authentication when required.

```dotenv
KANVIL_SEARCH_PROVIDER=elasticsearch
ELASTICSEARCH_URL=https://elasticsearch.example.com
# Omit the index variable to derive a unique name from the instance identity.
ELASTICSEARCH_INDEX=kanvil-instance
ELASTICSEARCH_API_KEY=your-api-key
# Or ELASTICSEARCH_USERNAME and ELASTICSEARCH_PASSWORD
```

The implementation uses basic index, mapping, bulk, search, scroll, and delete-by-query APIs, without paid search features. Integration tests run against Elasticsearch 9.5.5. Other compatible distributions need the same APIs and should be validated against their version before deployment.

The index worker replays durable PostgreSQL events and checkpoints only acknowledged updates. A missing or expired checkpoint rebuilds the index. Full-text search adds fuzzy matching once the index catches up; requests fall back to PostgreSQL while it catches up or if external requests fail. Server-side project authorization and all other ticket filters still run in PostgreSQL, including when the external service returns an incorrect ticket ID. Use **Rebuild index** after restoring a database or changing an external index independently.

## RabbitMQ

Choose **Event delivery → RabbitMQ** to fan out event wakeups between application instances and wake background workers. Set an AMQP or AMQPS connection URL, including an existing virtual host, and an exchange name. Use a dedicated virtual host with permission to declare the exchange and temporary queues, bind them, publish, and consume. AMQPS uses the system trust store; a private CA can be supplied through `NODE_EXTRA_CA_CERTS`.

```dotenv
KANVIL_BROKER_PROVIDER=rabbitmq
RABBITMQ_URL=amqps://kanvil:password@rabbitmq.example.com:5671/kanvil
RABBITMQ_EXCHANGE=kanvil.events
```

Percent-encode credentials and virtual host names in the URL. The default `/` virtual host can be written as `/%2F`. Administration masks the URL credentials and displays only its endpoint and exchange.

Kanvil declares a durable fanout exchange and an exclusive temporary queue for each running server. Messages contain only the Kanvil instance identity and a committed event cursor. There is no ticket content in the broker. Consumers acknowledge notifications and then read authorized durable data from PostgreSQL. Duplicate or dropped wakeups cannot change the event cursor or overwrite tickets.

A PostgreSQL advisory lock coordinates publishers, and a durable destination checkpoint advances only after RabbitMQ confirms publication. If publication succeeds but checkpointing is interrupted, the notification is published again. New or reconnected servers catch up from PostgreSQL. The AMQP client restores its connection, exchange, queue, and consumer after an outage. PostgreSQL notifications and periodic processors keep the application functioning while RabbitMQ is unavailable. Administration reports this fallback.

RabbitMQ improves notification distribution for operators who already run it. It does not replace the database, become a prerequisite for jobs, or change the HTTP, SSE, or MCP contracts. Pending uploads and indexing work remain recoverable without broker queue backups.

## Adapter interfaces

The application composition root is `apps/server/src/runtime-adapters.ts`. It selects authentication, push, realtime delivery, object storage, indexing, and background scheduling. HTTP and MCP share domain handlers and receive application services instead of importing provider SDKs.

`adapters/ports.ts` defines the external I/O interfaces. S3 drivers implement `ObjectStore`, search drivers implement `TicketIndex`, and message brokers implement `WakeupBus`. Provider registries select the driver. The blob service owns transactions, object references, integrity checks, and cleanup; the search service owns indexing checkpoints and SQL authorization; event delivery owns durable notification checkpoints and PostgreSQL fallback. Provider drivers perform only their protocol operations.

To add a provider, implement its matching interface, register its factory, add validated and sanitized configuration, and cover real I/O and failure recovery. Do not change ticket handlers or add provider checks to HTTP/MCP operations. PostgreSQL transactions, ordered event cursors, version checks, and claims are intentional durability contracts, not a generic database abstraction.

## Validation

```sh
pnpm db:up
pnpm test:services
```

This starts disposable Elasticsearch and RabbitMQ instances on loopback, runs S3-compatible storage readback, upload failure recovery, external search permission/fallback tests, and broker fanout/outage/reconnect tests, then removes those containers. S3 uses an isolated S3rver fixture. Each suite creates and removes its own PostgreSQL database. CI supplies the same optional services to the standard test run. No real cluster credentials or endpoints are used.
