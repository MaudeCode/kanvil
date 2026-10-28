import { lookup } from "node:dns";
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
import { createHttpSender, type Resolve } from "./adapters/outbound.ts";
import { createPollingJob } from "./adapters/polling-jobs.ts";
import { defaultSenders } from "./outbox.ts";
import { startImportSources } from "./import-source-fixture.ts";
import { z } from "zod";
import { watchBoundaries } from "../../../scripts/testing/boundaries.ts";
import { serverAccountingFile } from "../../../scripts/testing/policy.ts";

// The browser suites reach PostgreSQL and fakes on loopback only. Everything this server reaches
// is recorded for the suite's accounting report, and anything else fails the run.
const boundaries = watchBoundaries(["database", "loopback"]);
const recordBoundaries = () =>
  writeFileSync(serverAccountingFile, JSON.stringify(boundaries.peek()));
recordBoundaries();
setInterval(recordBoundaries, 200).unref();
const resolveTestHosts: Resolve = (hostname, options, callback) => {
  if (!hostname.endsWith(".invalid")) return lookup(hostname, options, callback);
  const error = Object.assign(new Error(`getaddrinfo ENOTFOUND ${hostname}`), {
    code: "ENOTFOUND",
    hostname,
  });
  process.nextTick(() => callback(error, []));
};
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
    // Deliveries keep the production sender, but `.invalid` hosts get the resolver's answer
    // (they never resolve) without asking DNS.
    senders: (config) => ({
      ...defaultSenders(config),
      http: createHttpSender({
        allowPrivate: config.KANVIL_DELIVERY_ALLOW_PRIVATE,
        resolve: resolveTestHosts,
      }),
    }),
    // Background work runs on the production code paths, polled every quarter second instead of
    // every few seconds so specs do not wait out production intervals.
    jobs: (name, intervalMs, run) => createPollingJob(name, Math.min(intervalMs, 250), run),
  },
);
// Bulk data belongs to this disposable server, never a production route or UI create loop.
application.app.post("/_fixtures/ticket-scale", async (c) => {
  const session = await application.auth.api.getSession({ headers: c.req.raw.headers });
  if (!session) return c.json({ error: "Sign in first" }, 401);
  const input = z
    .object({ projectId: z.uuid(), mode: z.enum(["mixed", "planning", "work"]).default("mixed") })
    .parse(await c.req.json());
  const result = await fixture.database.pool.query<{ id: string }>(
    `INSERT INTO tickets (project_id, key, number, title, description, acceptance_criteria,
      status, state_id, priority, kind, difficulty, labels, assignee_id, start_at, due_at, position, created_by, custom_fields)
     SELECT p.id, p.key || '-' || n, n,
       'Scale ticket ' || n || ': a wrapping title that remains readable when the viewport is narrow',
       'Ticket ' || n || E'\n' || repeat('Requirement detail. ', 160),
       'Acceptance for ' || n || E'\n' || repeat('Acceptance detail. ', 60),
       s.category, s.id, 'medium', 'bug', 'med',
       CASE WHEN n % 3 = 0 THEN ARRAY['scale'] ELSE ARRAY[]::text[] END,
       $2, now(), now() + interval '7 days', n * 1024, $2,
       COALESCE((SELECT jsonb_object_agg(f.id, 'true'::jsonb) FROM custom_fields f WHERE f.project_id = p.id), '{}'::jsonb)
     FROM projects p CROSS JOIN generate_series(1, 10000) n
     JOIN workflow_states s ON s.project_id = p.id AND s.category =
       CASE WHEN $3 = 'planning' THEN 'backlog' WHEN $3 = 'work' THEN 'todo'
       WHEN n <= 7000 THEN 'done' WHEN n <= 8000 THEN 'todo'
       WHEN n <= 8500 THEN 'backlog' WHEN n <= 9000 THEN 'in_progress'
       WHEN n <= 9500 THEN 'in_review' ELSE 'cancelled' END
     WHERE p.id = $1 RETURNING id`,
    [input.projectId, session.user.id, input.mode],
  );
  await fixture.database.pool.query("UPDATE projects SET next_number = 10001 WHERE id = $1", [
    input.projectId,
  ]);
  return c.json({ ids: result.rows.map((row) => row.id) });
});
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
