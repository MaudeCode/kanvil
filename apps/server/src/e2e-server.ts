import { Server } from "node:http";
import { createServer } from "node:https";
import { readFileSync } from "node:fs";
import { serve } from "@hono/node-server";
import { createFixture } from "./test-fixture.ts";
import { createApplication } from "./app.ts";
import { createImportSources } from "./adapters/import-sources.ts";
import { createHttpSender } from "./adapters/outbound.ts";
import { startImportSources } from "./import-source-fixture.ts";
import { z } from "zod";

const fixture = await createFixture();
// Imports read fake trackers on loopback; no real account is involved.
const sources = await startImportSources();
const port = Number(process.env.KANVIL_TEST_PORT ?? 5190);
const tls =
  process.env.KANVIL_TEST_TLS_CERT && process.env.KANVIL_TEST_TLS_KEY
    ? {
        cert: readFileSync(process.env.KANVIL_TEST_TLS_CERT),
        key: readFileSync(process.env.KANVIL_TEST_TLS_KEY),
      }
    : undefined;
const baseUrl = `${tls ? "https" : "http"}://localhost:${port}`;
const pocketUrl = `${process.env.KANVIL_TEST_POCKET_TLS === "1" ? "https" : "http"}://localhost:${process.env.KANVIL_TEST_POCKET_PORT ?? 51411}`;
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
      callbackURLs: [`${baseUrl}/api/auth/callback/oidc`],
      isPublic: false,
      pkceEnabled: true,
    }),
  });
  if (!response.ok) throw new Error(`PocketID test client setup failed (${response.status})`);
  oidc = z
    .object({ id: z.string(), createdSecret: z.object({ secret: z.string() }) })
    .parse(await response.json());
}
const application = await createApplication(
  fixture.database,
  {
    ...fixture.config,
    KANVIL_URL: baseUrl,
    trustedOrigins: [baseUrl, "kanvil://"],
    KANVIL_SETUP_TOKEN: "kanvil-browser-tests-only-setup-token",
    KANVIL_PUSH_ENABLED: process.env.KANVIL_TEST_PUSH === "1",
    // Browser suites share one owner account and write far faster than a person would.
    KANVIL_SESSION_WRITE_LIMIT: 100_000,
    ...(oidc
      ? {
          OIDC_DISCOVERY_URL: `${pocketUrl}/.well-known/openid-configuration`,
          OIDC_CLIENT_ID: oidc.id,
          OIDC_CLIENT_SECRET: oidc.createdSecret.secret,
        }
      : {}),
  },
  {
    importSources: () =>
      createImportSources(createHttpSender({ allowPrivate: true }), sources.urls),
  },
);
const server = serve(
  {
    fetch: application.app.fetch,
    hostname: "127.0.0.1",
    port,
    ...(tls ? { createServer, serverOptions: tls } : {}),
  },
  () => console.info(`Isolated Kanvil test server: ${baseUrl}`),
);
let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  await application.close();
  if (server instanceof Server) server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await sources.close();
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
