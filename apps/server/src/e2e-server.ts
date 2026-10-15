import { Server } from "node:http";
import { serve } from "@hono/node-server";
import { createFixture } from "./test-fixture.ts";
import { createApplication } from "./app.ts";

const fixture = await createFixture();
const port = Number(process.env.KANVIL_TEST_PORT ?? 5190);
const application = await createApplication(fixture.database, {
  ...fixture.config,
  KANVIL_URL: `http://localhost:${port}`,
  trustedOrigins: [`http://localhost:${port}`, "kanvil://"],
  KANVIL_SETUP_TOKEN: "kanvil-browser-tests-only-setup-token",
});
const server = serve({ fetch: application.app.fetch, hostname: "127.0.0.1", port }, () =>
  console.info(`Isolated Kanvil test server: http://localhost:${port}`),
);
let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  if (server instanceof Server) server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await application.close();
  await fixture.close();
}
process.on("SIGTERM", () => {
  void stop();
});
process.on("SIGINT", () => {
  void stop();
});
