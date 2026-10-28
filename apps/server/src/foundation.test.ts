import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { createFixture } from "./test-fixture.ts";
import { recoverLocalPassword } from "./recover-account.ts";
import { readConfig } from "./config.ts";
import pg from "pg";
import { sql } from "drizzle-orm";
import { createApplication } from "./app.ts";
import { createDatabase } from "./database.ts";

describe("self-hosted foundation", () => {
  let fixture: Awaited<ReturnType<typeof createFixture>>;
  beforeAll(async () => {
    fixture = await createFixture();
  });
  afterAll(async () => {
    await fixture?.close();
  });
  it("applies the real PostgreSQL schema and prevents duplicate ticket prefixes", async () => {
    await fixture.database.pool.query(
      "INSERT INTO projects (workspace_id, key, name) SELECT id, 'TEST', 'Test project' FROM workspaces WHERE slug = 'kanvil'",
    );
    await expect(
      fixture.database.pool.query(
        "INSERT INTO projects (workspace_id, key, name) SELECT id, 'TEST', 'Another project' FROM workspaces WHERE slug = 'kanvil'",
      ),
    ).rejects.toMatchObject({ code: "23505" });
    const clock = await fixture.database.pool.query("SELECT value FROM event_clock WHERE id = 1");
    expect(clock.rows[0].value).toBe("0");
  });
  it("supports local sign-in, server-side account creation, and session revocation", async () => {
    const password = "An isolated test password 42!";
    const created = await fixture.auth.api.createUser({
      body: { email: "owner@example.test", name: "Test owner", password, role: "admin" },
    });
    expect(created.user.role).toBe("admin");
    const response = await fixture.auth.handler(
      new Request(`${fixture.config.KANVIL_URL}/api/auth/sign-in/email`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: fixture.config.KANVIL_URL },
        body: JSON.stringify({ email: created.user.email, password }),
      }),
    );
    expect(response.status).toBe(200);
    const cookie = response.headers
      .getSetCookie()
      .map((value) => value.split(";")[0])
      .join("; ");
    const headers = new Headers({ Cookie: cookie, Origin: fixture.config.KANVIL_URL });
    expect((await fixture.auth.api.getSession({ headers }))?.user.id).toBe(created.user.id);
    const logout = await fixture.auth.handler(
      new Request(`${fixture.config.KANVIL_URL}/api/auth/sign-out`, { method: "POST", headers }),
    );
    expect(logout.status).toBe(200);
    expect(await fixture.auth.api.getSession({ headers })).toBeNull();
  });
  it("keeps public registration closed", async () => {
    const response = await fixture.auth.handler(
      new Request(`${fixture.config.KANVIL_URL}/api/auth/sign-up/email`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: fixture.config.KANVIL_URL },
        body: JSON.stringify({
          name: "Uninvited",
          email: "uninvited@example.test",
          password: "An isolated password 42!",
        }),
      }),
    );
    expect(response.status).toBeGreaterThanOrEqual(400);
    const users = await fixture.database.pool.query('SELECT id FROM "user" WHERE email = $1', [
      "uninvited@example.test",
    ]);
    expect(users.rowCount).toBe(0);
  });
  it("recovers a local account with the auth library's password format and revokes old sessions", async () => {
    const oldPassword = "Isolated old recovery password 42!",
      nextPassword = "Isolated new recovery password 43!";
    const created = await fixture.auth.api.createUser({
      body: {
        email: "recovery@example.test",
        name: "Recovery owner",
        password: oldPassword,
        role: "admin",
      },
    });
    const signIn = (password: string) =>
      fixture.auth.handler(
        new Request(`${fixture.config.KANVIL_URL}/api/auth/sign-in/email`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Origin: fixture.config.KANVIL_URL },
          body: JSON.stringify({ email: created.user.email, password }),
        }),
      );
    const before = await signIn(oldPassword);
    expect(before.status).toBe(200);
    const cookie = before.headers
      .getSetCookie()
      .map((value) => value.split(";")[0])
      .join("; ");
    const headers = new Headers({ Cookie: cookie });
    expect((await fixture.auth.api.getSession({ headers }))?.user.id).toBe(created.user.id);
    expect(
      await recoverLocalPassword(
        fixture.database,
        fixture.config,
        "Recovery@Example.Test",
        nextPassword,
      ),
    ).toBe(created.user.id);
    expect(await fixture.auth.api.getSession({ headers })).toBeNull();
    expect((await signIn(oldPassword)).status).toBe(401);
    const after = await signIn(nextPassword);
    expect(after.status).toBe(200);
    const body: unknown = await after.json();
    expect(body).toMatchObject({ user: { id: created.user.id, role: "admin" } });
  });
  it("rejects partial OIDC configuration and insecure production URLs", () => {
    const env = {
      DATABASE_URL: fixture.config.DATABASE_URL,
      BETTER_AUTH_SECRET: crypto.randomUUID(),
    };
    expect(
      readConfig({
        ...env,
        OIDC_DISCOVERY_URL: "",
        OIDC_CLIENT_ID: "",
        OIDC_CLIENT_SECRET: "",
        KANVIL_SETUP_TOKEN: "",
      }).OIDC_DISCOVERY_URL,
    ).toBeUndefined();
    expect(() => readConfig({ ...env, OIDC_CLIENT_ID: "incomplete" })).toThrow(
      "Configure all three OIDC settings",
    );
    expect(() => readConfig({ ...env, NODE_ENV: "production" })).toThrow(
      "Production KANVIL_URL must use HTTPS",
    );
  });
});

const total = (counts: Record<string, number>) =>
  Object.values(counts).reduce((sum, count) => sum + count, 0);
describe("database connection budget", () => {
  let fixture: Awaited<ReturnType<typeof createFixture>>, observer: pg.Client;
  beforeAll(async () => {
    fixture = await createFixture();
    observer = new pg.Client({ connectionString: fixture.config.DATABASE_URL });
    await observer.connect();
  });
  afterAll(async () => {
    await observer?.end();
    await fixture?.close();
  });
  // Server connections to the fixture database other than this observer, by application name.
  const backends = async () =>
    Object.fromEntries(
      (
        await observer.query<{ name: string; count: number }>(
          "SELECT application_name AS name, count(*)::int AS count FROM pg_stat_activity WHERE datname = current_database() AND pid <> pg_backend_pid() GROUP BY 1",
        )
      ).rows.map((row) => [row.name, row.count]),
    );
  // Held or awaited global write locks in the fixture database; pg_locks spans every database.
  const writeLocks = async (granted: boolean) =>
    (
      await observer.query(
        "SELECT 1 FROM pg_locks WHERE locktype = 'advisory' AND objid = 7361080 AND granted = $1 AND database = (SELECT oid FROM pg_database WHERE datname = current_database())",
        [granted],
      )
    ).rowCount;

  it("keeps a fixture and its application inside the test budget while writes queue for the lock", async () => {
    const application = await createApplication(fixture.database, fixture.config);
    const pool = fixture.database.pool;
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    try {
      const holder = fixture.database.db.transaction(async (tx) => {
        await tx.execute(sql`SELECT pg_advisory_xact_lock(7361080)`);
        await held;
      });
      await expect.poll(() => writeLocks(true)).toBe(1);
      // Twenty writes contend for the global write lock as domain writes do.
      const contenders = Array.from({ length: 20 }, () =>
        fixture.database.db.transaction(async (tx) => {
          await tx.execute(sql`SELECT pg_advisory_xact_lock(7361080)`);
        }),
      );
      await expect.poll(() => pool.waitingCount).toBeGreaterThan(0);
      await expect.poll(() => writeLocks(false)).toBe(pool.totalCount - 1);
      // Four domain and authentication, two integration, and one realtime LISTEN connection.
      expect(total(await backends())).toBeLessThanOrEqual(7);
      release();
      await Promise.all([holder, ...contenders]);
      expect(pool.waitingCount).toBe(0);
    } finally {
      release();
      await application.close();
    }
    await expect.poll(async () => total(await backends())).toBeLessThanOrEqual(pool.totalCount);
  });
  it("queues checkouts past a pool's budget, reuses released clients, and fails a wait past the acquisition timeout", async () => {
    // The fixture's maintenance connection ended after CREATE DATABASE.
    const name = new URL(fixture.config.DATABASE_URL).pathname.slice(1);
    expect(
      (
        await observer.query("SELECT 1 FROM pg_stat_activity WHERE application_name = $1", [
          `kanvil-fixture ${name}`,
        ])
      ).rowCount,
    ).toBe(0);
    const database = createDatabase(
      {
        ...fixture.config,
        KANVIL_INTEGRATION_POOL_MAX: 2,
        KANVIL_DATABASE_ACQUIRE_TIMEOUT_MS: 200,
      },
      "integration",
    );
    try {
      const held = [await database.pool.connect(), await database.pool.connect()];
      expect((await backends())["kanvil-integration"]).toBe(2);
      await expect(database.pool.connect()).rejects.toThrow("timeout");
      const queued = database.pool.connect();
      await expect.poll(() => database.pool.waitingCount).toBe(1);
      held.pop()?.release();
      const reused = await queued;
      expect(database.pool.waitingCount).toBe(0);
      expect(database.pool.totalCount).toBe(2);
      reused.release();
      held.pop()?.release();
      expect((await backends())["kanvil-integration"]).toBe(2);
    } finally {
      await database.pool.end();
    }
    await expect.poll(async () => (await backends())["kanvil-integration"]).toBeUndefined();
  });
});
