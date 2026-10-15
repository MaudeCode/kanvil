import pg from "pg";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDatabase } from "./database.ts";
import { migrateDatabase } from "./migrate.ts";
import { readConfig } from "./config.ts";
import { createAuth } from "./auth.ts";

export async function createFixture() {
  const url = new URL(
    process.env.TEST_DATABASE_URL ?? "postgres://kanvil:kanvil@127.0.0.1:55462/kanvil",
  );
  const admin = new pg.Pool({ connectionString: url.toString() });
  const name = `kanvil_test_${crypto.randomUUID().replaceAll("-", "")}`;
  const files = await mkdtemp(join(tmpdir(), "kanvil-test-"));
  await admin.query(`CREATE DATABASE "${name}"`);
  url.pathname = `/${name}`;
  const database = createDatabase(url.toString());
  const config = readConfig({
    NODE_ENV: "test",
    DATABASE_URL: url.toString(),
    KANVIL_URL: "http://localhost:5180",
    BETTER_AUTH_SECRET: crypto.randomUUID(),
    KANVIL_SETUP_TOKEN: crypto.randomUUID(),
    ATTACHMENTS_DIR: files,
  });
  await migrateDatabase(database);
  const auth = createAuth(database, config);
  return {
    database,
    config,
    auth,
    async close() {
      await database.pool.end();
      await admin.query(`DROP DATABASE "${name}"`);
      await admin.end();
      await rm(files, { recursive: true, force: true });
    },
  };
}
