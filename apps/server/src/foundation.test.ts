import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { createFixture } from "./test-fixture.ts";
import { readConfig } from "./config.ts";

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
      "INSERT INTO projects (key, name) VALUES ('TEST', 'Test project')",
    );
    await expect(
      fixture.database.pool.query(
        "INSERT INTO projects (key, name) VALUES ('TEST', 'Another project')",
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
  it("rejects partial OIDC configuration and insecure production URLs", () => {
    const env = {
      DATABASE_URL: fixture.config.DATABASE_URL,
      BETTER_AUTH_SECRET: crypto.randomUUID(),
    };
    expect(() => readConfig({ ...env, OIDC_CLIENT_ID: "incomplete" })).toThrow(
      "Configure all three OIDC settings",
    );
    expect(() => readConfig({ ...env, NODE_ENV: "production" })).toThrow(
      "Production KANVIL_URL must use HTTPS",
    );
  });
});
