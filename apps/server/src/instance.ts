import { matchesOIDCBinding } from "./adapters/oidc.ts";
import { createHash } from "node:crypto";
import { createSealer } from "./sealing.ts";
import { and, eq, sql } from "drizzle-orm";
import {
  instanceUpdateSchema,
  authenticationPolicySchema,
  brokerSettingsSchema,
  type BrokerSettings,
  s3SettingsSchema,
  searchSettingsSchema,
  searchAuthentication,
  type S3Settings,
  type SearchSettings,
} from "@kanvil/contracts/instance";
import { account } from "./auth-schema.ts";
import { instanceSettings, storageBackends } from "./schema.ts";
import type { Database, Connection, Transaction } from "./database.ts";
import type { Config } from "./config.ts";
import { assertVersion, fail, one } from "./domain.ts";

// Location identity excludes credentials so rotation preserves existing file references.
function storageIdentity(settings: S3Settings) {
  return createHash("sha256")
    .update(
      JSON.stringify([
        settings.endpoint,
        settings.region,
        settings.bucket,
        settings.prefix,
        settings.forcePathStyle,
      ]),
    )
    .digest("hex");
}

export function createInstance(database: Database, config: Config) {
  const { seal, unseal } = createSealer(config.BETTER_AUTH_SECRET, "kanvil:instance-config:v1:");
  async function read(db: Connection | Transaction = database.db) {
    await db.insert(instanceSettings).values({ id: 1 }).onConflictDoNothing();
    return one(await db.select().from(instanceSettings).where(eq(instanceSettings.id, 1)));
  }
  async function backend(id: string, db: Connection | Transaction = database.db) {
    const row = one(await db.select().from(storageBackends).where(eq(storageBackends.id, id)));
    const settings = s3SettingsSchema.parse(unseal(row.config));
    return { ...row, settings, spec: { provider: "s3", config: settings } };
  }
  async function resolveS3(settings: S3Settings, db: Connection | Transaction = database.db) {
    settings = s3SettingsSchema.strip().parse(settings);
    const identity = storageIdentity(settings);
    const previous = (
      await db.select().from(storageBackends).where(eq(storageBackends.identity, identity))
    )[0];
    const old = previous ? s3SettingsSchema.parse(unseal(previous.config)) : undefined;
    const { secretAccessKey: suppliedSecret, ...publicSettings } = settings,
      secret =
        suppliedSecret ||
        (old?.accessKeyId === settings.accessKeyId ? old.secretAccessKey : undefined);
    if (settings.accessKeyId && !secret)
      fail(400, "missing_secret", "Provide the S3 secret access key");
    return { ...publicSettings, ...(secret ? { secretAccessKey: secret } : {}) };
  }
  async function resolveSearch(
    settings: SearchSettings,
    db: Connection | Transaction = database.db,
  ) {
    settings = searchSettingsSchema.strip().parse(settings);
    const row = await read(db),
      old = row.searchConfig ? searchSettingsSchema.parse(unseal(row.searchConfig)) : null,
      same = old?.url === settings.url && old.index === settings.index;
    const {
        apiKey: suppliedKey,
        password: suppliedPassword,
        auth: requestedAuth,
        ...publicSettings
      } = settings,
      auth =
        requestedAuth ??
        (suppliedKey
          ? "apiKey"
          : suppliedPassword && settings.username
            ? "basic"
            : same && old
              ? searchAuthentication(old)
              : searchAuthentication(settings)),
      apiKey = suppliedKey || (same ? old?.apiKey : undefined),
      password =
        suppliedPassword ||
        (same && old?.username === settings.username ? old?.password : undefined);
    if (auth === "apiKey" && !apiKey) fail(400, "missing_secret", "Provide the search API key");
    if (auth === "basic" && (!settings.username || !password))
      fail(400, "missing_secret", "Provide the search username and password");
    return {
      ...publicSettings,
      auth,
      ...(auth === "apiKey" && apiKey ? { apiKey } : {}),
      ...(auth === "basic" && password ? { password } : {}),
    };
  }
  async function saveBackend(settings: S3Settings, db: Connection | Transaction = database.db) {
    const complete = await resolveS3(settings, db),
      identity = storageIdentity(settings);
    return one(
      await db
        .insert(storageBackends)
        .values({ identity, config: seal(complete) })
        .onConflictDoUpdate({ target: storageBackends.identity, set: { config: seal(complete) } })
        .returning(),
    );
  }
  async function storage() {
    if (config.KANVIL_STORAGE_PROVIDER === "local") return null;
    if (config.KANVIL_STORAGE_PROVIDER === "s3")
      return saveBackend(
        s3SettingsSchema.parse({
          endpoint: config.S3_ENDPOINT ?? "",
          region: config.S3_REGION,
          bucket: config.S3_BUCKET,
          prefix: config.S3_PREFIX,
          forcePathStyle: config.S3_FORCE_PATH_STYLE,
          accessKeyId: config.S3_ACCESS_KEY_ID ?? "",
          secretAccessKey: config.S3_SECRET_ACCESS_KEY,
        }),
      );
    const row = await read();
    return row.storageBackendId ? backend(row.storageBackendId) : null;
  }
  async function search() {
    const row = await read();
    if (config.KANVIL_SEARCH_PROVIDER === "postgres") return null;
    if (config.KANVIL_SEARCH_PROVIDER === "elasticsearch") {
      const settings = searchSettingsSchema.parse({
        url: config.ELASTICSEARCH_URL,
        index: config.ELASTICSEARCH_INDEX ?? `kanvil-${row.identity}`,
        auth: config.ELASTICSEARCH_AUTH,
        apiKey: config.ELASTICSEARCH_API_KEY,
        username: config.ELASTICSEARCH_USERNAME,
        password: config.ELASTICSEARCH_PASSWORD,
      });
      return { ...settings, auth: searchAuthentication(settings) };
    }
    const settings = row.searchConfig ? searchSettingsSchema.parse(unseal(row.searchConfig)) : null;
    return settings ? { ...settings, auth: searchAuthentication(settings) } : null;
  }
  async function broker() {
    if (config.KANVIL_BROKER_PROVIDER === "postgres") return null;
    if (config.KANVIL_BROKER_PROVIDER === "rabbitmq")
      return brokerSettingsSchema.parse({
        url: config.RABBITMQ_URL,
        exchange: config.RABBITMQ_EXCHANGE,
      });
    const row = await read();
    return row.brokerConfig ? brokerSettingsSchema.parse(unseal(row.brokerConfig)) : null;
  }
  async function resolveBroker(
    settings: BrokerSettings,
    db: Connection | Transaction = database.db,
  ) {
    settings = brokerSettingsSchema.strip().parse(settings);
    const row = await read(db),
      old = row.brokerConfig ? brokerSettingsSchema.parse(unseal(row.brokerConfig)) : null;
    const url = settings.url || old?.url;
    if (!url) return fail(400, "missing_secret", "Provide the RabbitMQ connection URL");
    return { ...settings, url };
  }
  async function authentication() {
    return authenticationPolicySchema.strip().parse(await read());
  }
  async function update(value: unknown, actorId?: string, oidcIssuer?: string) {
    const input = instanceUpdateSchema.parse(value);
    return database.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(7361083)`);
      const current = await read(tx);
      assertVersion(current, input.expectedVersion, "instance settings", "saving");
      if (input.authentication && !input.authentication.emailPasswordEnabled) {
        if (!config.OIDC_DISCOVERY_URL || !config.OIDC_CLIENT_ID || !config.OIDC_CLIENT_SECRET)
          fail(
            409,
            "oidc_required",
            "Configure an OIDC provider before disabling password sign-in",
          );
        const bindings = actorId
          ? await tx
              .select({ idToken: account.idToken, accountId: account.accountId })
              .from(account)
              .where(and(eq(account.userId, actorId), eq(account.providerId, "oidc")))
          : [];
        const currentBinding = bindings.some((binding) =>
          matchesOIDCBinding(binding, oidcIssuer, config.OIDC_CLIENT_ID),
        );
        if (!currentBinding)
          fail(
            409,
            "oidc_binding_required",
            "Link your OIDC account in User settings using the configured provider before disabling password sign-in",
          );
      }
      let storageId = current.storageBackendId,
        searchConfig = current.searchConfig,
        brokerConfig = current.brokerConfig;
      if (!config.KANVIL_STORAGE_PROVIDER)
        storageId =
          input.storage.provider === "s3" ? (await saveBackend(input.storage, tx)).id : null;
      if (!config.KANVIL_SEARCH_PROVIDER) {
        if (input.search.provider === "postgres") searchConfig = null;
        else searchConfig = seal(await resolveSearch(input.search, tx));
      }
      if (!config.KANVIL_BROKER_PROVIDER && input.broker)
        brokerConfig =
          input.broker.provider === "postgres" ? null : seal(await resolveBroker(input.broker, tx));
      await tx
        .update(instanceSettings)
        .set({
          ...input.authentication,
          name: input.name,
          description: input.description,
          storageBackendId: storageId,
          searchConfig,
          brokerConfig,
          version: current.version + 1,
        })
        .where(eq(instanceSettings.id, 1));
    });
  }
  return {
    read,
    authentication,
    storage,
    search,
    backend,
    saveBackend,
    resolveS3,
    resolveSearch,
    broker,
    resolveBroker,
    update,
    config,
  };
}
export type Instance = ReturnType<typeof createInstance>;
