import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import * as authSchema from "./auth-schema.ts";

export function createDatabase(url: string) {
  const pool = new pg.Pool({ connectionString: url, max: 10, idleTimeoutMillis: 30_000 });
  return { pool, db: drizzle(pool, { schema: authSchema }) };
}
export type Database = ReturnType<typeof createDatabase>;
export type Connection = Database["db"];
export type Transaction = Parameters<Parameters<Connection["transaction"]>[0]>[0];
