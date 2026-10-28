import { serve } from "@hono/node-server";
import { createDatabase } from "./database.ts";
import { readConfig } from "./config.ts";
import { migrateDatabase } from "./migrate.ts";
import { createApplication } from "./app.ts";

const config = readConfig(),
  database = createDatabase(config);
await migrateDatabase(database);
const application = await createApplication(database, config);
const server = serve(
  { fetch: application.app.fetch, hostname: config.HOST, port: config.PORT },
  () => {
    console.info(`Kanvil is listening on ${config.HOST}:${config.PORT}`);
  },
);
let stopping = false;
async function shutdown() {
  if (stopping) return;
  stopping = true;
  await application.close();
  server.close(async () => {
    await database.pool.end();
  });
}
process.on("SIGINT", () => {
  void shutdown();
});
process.on("SIGTERM", () => {
  void shutdown();
});
