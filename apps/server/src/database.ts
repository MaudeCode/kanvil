import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import * as authSchema from "./auth-schema.ts";
import type { Config } from "./config.ts";

export type DatabaseConfig = Pick<
  Config,
  | "DATABASE_URL"
  | "KANVIL_DATABASE_POOL_MAX"
  | "KANVIL_INTEGRATION_POOL_MAX"
  | "KANVIL_DATABASE_ACQUIRE_TIMEOUT_MS"
>;
// One process opens at most domain + integration + one realtime LISTEN connection. Domain writes
// and authentication share the domain pool; integration receipts, instance settings, background
// sync, and account guards use their own, so they never wait behind writes holding the global
// write lock. Each pool opens clients on demand, reuses them, closes idle ones, and fails a
// checkout that waits longer than the acquisition timeout. `application_name` names each pool
// in pg_stat_activity.
export function poolOptions(config: DatabaseConfig, role: "domain" | "integration") {
  return {
    connectionString: config.DATABASE_URL,
    application_name: role === "domain" ? "kanvil" : "kanvil-integration",
    max: role === "domain" ? config.KANVIL_DATABASE_POOL_MAX : config.KANVIL_INTEGRATION_POOL_MAX,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: config.KANVIL_DATABASE_ACQUIRE_TIMEOUT_MS,
  } satisfies pg.PoolConfig;
}
export function createDatabase(config: DatabaseConfig, role: "domain" | "integration" = "domain") {
  const pool = new pg.Pool(poolOptions(config, role));
  pool.on("error", () => {
    console.error("A PostgreSQL idle connection was lost; the pool will reconnect.");
  });
  return { pool, db: drizzle(pool, { schema: authSchema }) };
}
export type Database = ReturnType<typeof createDatabase>;
export type Connection = Database["db"];
export type Transaction = Parameters<Parameters<Connection["transaction"]>[0]>[0];
