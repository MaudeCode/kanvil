import pg from "pg";
import { createDatabase, type Database } from "./database.ts";
import { migrateDatabase } from "./migrate.ts";
import { readConfig } from "./config.ts";
import { createAuth } from "./auth.ts";

export async function createFixture({
  beforeMigrate,
}: { beforeMigrate?: (database: Database) => Promise<void> } = {}) {
  const url = new URL(
    process.env.TEST_DATABASE_URL ?? "postgres://kanvil:kanvil@127.0.0.1:55462/kanvil",
  );
  const admin = new pg.Pool({ connectionString: url.toString() });
  const name = `kanvil_test_${crypto.randomUUID().replaceAll("-", "")}`;
  await admin.query(`CREATE DATABASE "${name}"`);
  url.pathname = `/${name}`;
  const database = createDatabase(url.toString());
  const config = readConfig({
    NODE_ENV: "test",
    DATABASE_URL: url.toString(),
    KANVIL_URL: "http://localhost:5180",
    BETTER_AUTH_SECRET: crypto.randomUUID(),
    KANVIL_SETUP_TOKEN: crypto.randomUUID(),
  });
  try {
    await beforeMigrate?.(database);
    await migrateDatabase(database);
  } catch (error) {
    await database.pool.end();
    await admin.query(`DROP DATABASE "${name}"`);
    await admin.end();
    throw error;
  }
  const auth = createAuth(database, config);
  return {
    database,
    config,
    auth,
    async close() {
      await database.pool.end();
      await admin.query(`DROP DATABASE "${name}"`);
      await admin.end();
    },
  };
}
