import { defineConfig } from "@playwright/test";
const baseURL = `http://localhost:${process.env.KANVIL_TEST_PORT ?? "5190"}`;
export default defineConfig({
  testDir: "./e2e",
  testMatch:
    process.env.KANVIL_TEST_POCKET_ID === "1" ? ["**/*.spec.ts", "**/*.pocket.ts"] : "**/*.spec.ts",
  // Shards split cases rather than whole files; each shard still runs one worker on its own
  // server, so every case keeps a fresh context and its own data.
  fullyParallel: true,
  workers: 1,
  reporter: [[process.env.CI ? "dot" : "list"], ["./scripts/testing/playwright-reporter.ts"]],
  use: {
    baseURL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  webServer: {
    command: "node apps/server/src/e2e-server.ts",
    url: `${baseURL}/healthz`,
    reuseExistingServer: false,
  },
});
