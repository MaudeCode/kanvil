import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { createFixture } from "./test-fixture.ts";
import { createApplication } from "./app.ts";
import { accountsSchema, accountDetailsSchema } from "@kanvil/contracts/users";

describe("instance account administration", () => {
  let fixture: Awaited<ReturnType<typeof createFixture>>,
    application: Awaited<ReturnType<typeof createApplication>>;
  let owner: { id: string; email: string },
    peer: { id: string; email: string },
    person: { id: string; email: string },
    ownerCookie: string,
    peerCookie: string;
  const password = "Isolated account password 234!";
  async function request(path: string, method = "GET", body?: unknown, cookie = ownerCookie) {
    return application.app.fetch(
      new Request(`http://localhost:5180${path}`, {
        method,
        headers: {
          Cookie: cookie,
          Origin: "http://localhost:5180",
          "Content-Type": "application/json",
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    );
  }
  async function login(email: string, secret = password) {
    const result = await request(
      "/api/auth/sign-in/email",
      "POST",
      { email, password: secret },
      "",
    );
    expect(result.status).toBe(200);
    return result.headers
      .getSetCookie()
      .map((value) => value.split(";")[0])
      .join("; ");
  }
  beforeEach(async () => {
    fixture = await createFixture();
    application = await createApplication(fixture.database, fixture.config);
    owner = (
      await fixture.auth.api.createUser({
        body: { name: "Instance owner", email: "owner@accounts.test", password, role: "admin" },
      })
    ).user;
    peer = (
      await fixture.auth.api.createUser({
        body: {
          name: "Second administrator",
          email: "admin@accounts.test",
          password,
          role: "admin",
        },
      })
    ).user;
    person = (
      await fixture.auth.api.createUser({
        body: { name: "Alex Engineer", email: "person@accounts.test", password, role: "user" },
      })
    ).user;
    ownerCookie = await login(owner.email);
    peerCookie = await login(peer.email);
  });
  afterEach(async () => {
    await application?.close();
    await fixture?.close();
  });
  it("searches names and email together, filters roles and status, and never exposes credentials", async () => {
    const memberCookie = await login(person.email);
    const searched = await request("/api/v1/admin/users?q=alex&limit=1");
    const data = accountsSchema.parse(await searched.json());
    expect(data.total).toBe(1);
    expect(data.users[0]?.id).toBe(person.id);
    const admins = accountsSchema.parse(
      await (await request("/api/v1/admin/users?role=admin&limit=1")).json(),
    );
    expect(admins.total).toBe(2);
    expect(admins.users).toHaveLength(1);
    expect(
      (
        await request("/api/auth/admin/ban-user", "POST", {
          userId: person.id,
          banReason: "Test suspension",
        })
      ).status,
    ).toBe(200);
    expect(
      accountsSchema
        .parse(await (await request("/api/v1/admin/users?status=disabled")).json())
        .users.map((row) => row.id),
    ).toEqual([person.id]);
    const text = await (await request(`/api/v1/admin/users/${owner.id}`)).text();
    expect(text).not.toContain("token");
    expect(text).not.toContain("password");
    expect(accountDetailsSchema.parse(JSON.parse(text))).toMatchObject({
      id: owner.id,
      providers: ["credential"],
      sessionCount: 1,
    });
    expect(
      (await request("/api/v1/admin/users", "GET", undefined, memberCookie)).status,
    ).toBeGreaterThanOrEqual(401);
  });
  it("keeps one active administrator through role edits, alternate update routes, and disable attempts", async () => {
    expect(
      (await request("/api/auth/admin/set-role", "POST", { userId: peer.id, role: "user" })).status,
    ).toBe(200);
    for (const [path, body] of [
      ["set-role", { userId: owner.id, role: "user" }],
      ["set-role/", { userId: owner.id, role: "user" }],
      ["%73et-role", { userId: owner.id, role: "user" }],
      ["update-user", { userId: owner.id, data: { role: "user" } }],
      ["ban-user", { userId: owner.id }],
      ["remove-user", { userId: owner.id }],
    ] as const) {
      expect((await request(`/api/auth/admin/${path}`, "POST", body)).status).toBe(409);
    }
    expect(
      (
        await request("/api/auth/admin/update-user", "POST", {
          userId: owner.id,
          data: { banned: "true" },
        })
      ).status,
    ).toBe(400);
    expect((await application.domain.actor(owner.id)).admin).toBe(true);
  });
  it("serializes concurrent role changes without losing all administrators", async () => {
    const results = await Promise.all([
      request("/api/auth/admin/set-role", "POST", { userId: owner.id, role: "user" }, ownerCookie),
      request("/api/auth/admin/set-role", "POST", { userId: peer.id, role: "user" }, peerCookie),
    ]);
    expect(results.map((result) => result.status).toSorted((a, b) => a - b)).toEqual([200, 409]);
    const count = await fixture.database.pool.query(
      `SELECT count(*)::int AS count FROM "user" WHERE NOT coalesce(banned,false) AND 'admin'=ANY(string_to_array(role,','))`,
    );
    expect(count.rows[0].count).toBe(1);
  });
  it("does not let public profile updates change instance roles", async () => {
    const cookie = await login(person.email);
    await request("/api/auth/update-user", "POST", { role: "admin" }, cookie);
    expect((await application.domain.actor(person.id)).admin).toBe(false);
    await request("/api/auth/update-user", "POST", { role: "user" }, ownerCookie);
    expect((await application.domain.actor(owner.id)).admin).toBe(true);
  });
  it("sets local passwords through the auth library and revokes existing sessions", async () => {
    const prior = await login(person.email);
    await login(person.email);
    const next = "Changed local password 234!";
    expect(
      (await request(`/api/v1/admin/users/${person.id}/password`, "POST", { password: next }))
        .status,
    ).toBe(200);
    expect(
      await fixture.auth.api.getSession({ headers: new Headers({ Cookie: prior }) }),
    ).toBeNull();
    await login(person.email, next);
    const rawCookie = await login(person.email, next);
    const rawPassword = "Changed through auth route 234!";
    expect(
      (
        await request("/api/auth/admin/set-user-password", "POST", {
          userId: person.id,
          newPassword: rawPassword,
        })
      ).status,
    ).toBe(200);
    expect(
      await fixture.auth.api.getSession({ headers: new Headers({ Cookie: rawCookie }) }),
    ).toBeNull();

    expect(
      (await request(`/api/v1/admin/users/${person.id}/password`, "POST", { password: "short" }))
        .status,
    ).toBe(400);
    const nonAdmin = await login(person.email, rawPassword);
    expect(
      (
        await request(
          `/api/v1/admin/users/${owner.id}/password`,
          "POST",
          { password: next },
          nonAdmin,
        )
      ).status,
    ).toBe(403);
  });
});
