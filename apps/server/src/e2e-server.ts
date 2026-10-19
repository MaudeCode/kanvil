import { Server } from "node:http";
import { createServer } from "node:https";
import { readFileSync } from "node:fs";
import { serve } from "@hono/node-server";
import { appendFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFixture, startMailbox } from "./test-fixture.ts";
import { fakeOAuthProviders } from "./oauth-provider-fixture.ts";
import { createApplication } from "./app.ts";
import { createImportSources } from "./adapters/import-sources.ts";
import { createHttpSender } from "./adapters/outbound.ts";
import { startImportSources } from "./import-source-fixture.ts";
import { z } from "zod";
import { watchBoundaries } from "../../../scripts/testing/boundaries.ts";
import { serverAccountingFile } from "../../../scripts/testing/policy.ts";

// Everything this server reaches is recorded for the browser suite's accounting report.
const boundaries = watchBoundaries(["database", "loopback", "network", "process"]);
const recordBoundaries = () =>
  writeFileSync(serverAccountingFile, JSON.stringify(boundaries.peek()));
recordBoundaries();
setInterval(recordBoundaries, 200).unref();
const fixture = await createFixture();
// Imports read fake trackers on loopback; no real account is involved.
const sources = await startImportSources();
const port = Number(process.env.KANVIL_TEST_PORT ?? 5190);
// Mail goes to a local SMTP fake; specs read it from this file, one JSON string per line.
const mailboxFile = join(tmpdir(), `kanvil-e2e-${port}.mail`);
writeFileSync(mailboxFile, "");
const mailbox = await startMailbox((message) =>
  appendFileSync(mailboxFile, `${JSON.stringify(message)}\n`),
);
// GitHub and Google sign-in reach fakes; the browser specs answer the providers' authorize pages.
globalThis.fetch = fakeOAuthProviders(globalThis.fetch, "kanvil-e2e-google").fetch;
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
    SMTP_URL: mailbox.url,
    SMTP_FROM: "Kanvil <kanvil@example.test>",
    GITHUB_CLIENT_ID: "kanvil-e2e-github",
    GITHUB_CLIENT_SECRET: "kanvil-e2e-github-secret",
    GOOGLE_CLIENT_ID: "kanvil-e2e-google",
    GOOGLE_CLIENT_SECRET: "kanvil-e2e-google-secret",
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
  await mailbox.close();
  await fixture.close();
  recordBoundaries();
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
