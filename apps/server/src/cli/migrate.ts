import { createDatabase } from "../database.ts";
import { readConfig } from "../config.ts";
import { migrateDatabase } from "../migrate.ts";

const database = createDatabase(readConfig().DATABASE_URL);
try {
  await migrateDatabase(database);
  console.info("Kanvil database is current.");
} finally {
  await database.pool.end();
}
