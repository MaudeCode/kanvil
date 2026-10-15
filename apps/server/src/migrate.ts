import { migrate } from "drizzle-orm/node-postgres/migrator";
import { drizzle } from "drizzle-orm/node-postgres";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { createDatabase, type Database } from "./database.ts";
import { readConfig } from "./config.ts";

export async function migrateDatabase(database: Database) {
  const client = await database.pool.connect();
  try {
    await client.query("SELECT pg_advisory_lock(7361081)");
    await migrate(drizzle(client), {
      migrationsFolder: fileURLToPath(new URL("../drizzle", import.meta.url)),
    });
    await client.query(
      "INSERT INTO event_clock (id, value, floor) VALUES (1, 0, 0) ON CONFLICT DO NOTHING",
    );
  } finally {
    await client.query("SELECT pg_advisory_unlock(7361081)");
    client.release();
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const database = createDatabase(readConfig().DATABASE_URL);
  try {
    await migrateDatabase(database);
    console.info("Kanvil database is current.");
  } finally {
    await database.pool.end();
  }
}
