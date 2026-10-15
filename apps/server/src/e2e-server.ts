import { Server } from "node:http";
import { serve } from "@hono/node-server";
import { createFixture } from "./test-fixture.ts";
import { createApplication } from "./app.ts";
import { z } from "zod";

const fixture = await createFixture();
const port = Number(process.env.KANVIL_TEST_PORT ?? 5190);
const pocketUrl = `${process.env.KANVIL_TEST_POCKET_TLS === "1" ? "https" : "http"}://localhost:51411`;
const pocketHeaders = {
  "X-API-Key": "kanvil-isolated-test-admin-api-key",
  "Content-Type": "application/json",
};
let oidc: { id: string; createdSecret: { secret: string } } | undefined;
if (process.env.KANVIL_TEST_POCKET_ID === "1") {
  const response = await fetch(`${pocketUrl}/api/oidc/clients`, {
    method: "POST",
    headers: pocketHeaders,
    body: JSON.stringify({
      name: "Kanvil browser integration test",
      callbackURLs: [`http://localhost:${port}/api/auth/callback/oidc`],
      isPublic: false,
      pkceEnabled: true,
    }),
  });
  if (!response.ok) throw new Error(`PocketID test client setup failed (${response.status})`);
  oidc = z
    .object({ id: z.string(), createdSecret: z.object({ secret: z.string() }) })
    .parse(await response.json());
}
const application = await createApplication(fixture.database, {
  ...fixture.config,
  KANVIL_URL: `http://localhost:${port}`,
  trustedOrigins: [`http://localhost:${port}`, "kanvil://"],
  KANVIL_SETUP_TOKEN: "kanvil-browser-tests-only-setup-token",
  KANVIL_PUSH_ENABLED: process.env.KANVIL_TEST_PUSH === "1",
  ...(oidc
    ? {
        OIDC_DISCOVERY_URL: `${pocketUrl}/.well-known/openid-configuration`,
        OIDC_CLIENT_ID: oidc.id,
        OIDC_CLIENT_SECRET: oidc.createdSecret.secret,
      }
    : {}),
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
  if (oidc)
    await fetch(`${pocketUrl}/api/oidc/clients/${oidc.id}`, {
      method: "DELETE",
      headers: pocketHeaders,
    });
}
process.on("SIGTERM", () => {
  void stop();
});
process.on("SIGINT", () => {
  void stop();
});
