import { expect, it } from "vite-plus/test";
import { createApplication } from "./app.ts";
import { createFixture } from "./test-fixture.ts";
import type { Database } from "./database.ts";

it("releases owned PostgreSQL connections after partial startup so its isolated database can drop", async () => {
  const fixture = await createFixture();
  let integration: Database | undefined;
  const applicationName = `kanvil-lifecycle-${crypto.randomUUID()}`;
  const ownedUrl = new URL(fixture.config.DATABASE_URL);
  ownedUrl.searchParams.set("application_name", applicationName);
  const connections = async () => {
    const result = await fixture.database.pool.query(
      "SELECT count(*) FROM pg_stat_activity WHERE datname = current_database() AND application_name = $1",
      [applicationName],
    );
    return Number(result.rows[0].count);
  };
  try {
    const baseline = await connections();
    const failure = new Error("injected realtime initialization failure");
    await expect(
      createApplication(
        fixture.database,
        { ...fixture.config, DATABASE_URL: ownedUrl.toString() },
        {
          realtime: async (_config, _instance, database) => {
            integration = database;
            throw failure;
          },
        },
      ),
    ).rejects.toBe(failure);
    expect(await connections()).toBe(baseline);
    // The caller-owned connection remains usable until fixture teardown.
    expect((await fixture.database.pool.query("SELECT 42 AS value")).rows[0].value).toBe(42);
  } finally {
    // Release a leak even on the pre-fix red run, without terminating another owner's connections.
    if (integration && !integration.pool.ended) await integration.pool.end();
    await fixture.close();
  }
});
