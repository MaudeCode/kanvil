import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { createFixture } from "./test-fixture.ts";
import { createApplication } from "./app.ts";
import {
  accountsSchema,
  accountDetailsSchema,
  adminWorkspacesSchema,
} from "@kanvil/contracts/users";
import { requireRow } from "./domain.ts";

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
  it("lists every workspace with counts and administrators, and lets instance administrators manage members they do not share", async () => {
    const creator = requireRow(await application.domain.actor(person.id));
    const space = await application.domain.execute(
      "create_workspace",
      { name: "Alpha operations", slug: "alpha-ops" },
      creator,
    );
    await application.domain.execute(
      "create_workspace",
      { name: "Beta research", slug: "beta-research" },
      creator,
    );
    const project = await application.domain.execute(
      "create_project",
      { workspaceId: space.id, key: "ALPHA", name: "Alpha project" },
      creator,
    );
    const list = async (query: string, cookie = ownerCookie) => {
      const response = await request(`/api/v1/admin/workspaces${query}`, "GET", undefined, cookie);
      expect(response.status).toBe(200);
      return adminWorkspacesSchema.parse(await response.json());
    };
    const alpha = await list("?q=alpha");
    expect(alpha.total).toBe(1);
    expect(alpha.workspaces[0]).toMatchObject({
      id: space.id,
      slug: "alpha-ops",
      memberCount: 1,
      projectCount: 1,
      administrators: [{ id: person.id, email: person.email }],
    });
    expect(JSON.stringify(alpha)).not.toMatch(/password|token|role/);
    expect((await list("?q=beta-res")).workspaces.map((row) => row.slug)).toEqual([
      "beta-research",
    ]);
    const all = await list("");
    const paged = await list("?limit=1&offset=1");
    expect(paged.total).toBe(all.total);
    expect(paged.workspaces.map((row) => row.id)).toEqual([all.workspaces[1]?.id]);
    expect(await list("?q=100%25")).toEqual({ workspaces: [], total: 0 });

    // An instance administrator outside the workspace manages it through the shared operations.
    const members = `/api/v1/workspaces/${space.id}/members`;
    expect((await request(members)).status).toBe(200);
    expect((await request(members, "POST", { email: peer.email, role: "writer" })).status).toBe(
      200,
    );
    expect((await request(members, "POST", { email: person.email, role: "writer" })).status).toBe(
      409,
    );
    expect((await list("?q=alpha")).workspaces[0]?.memberCount).toBe(2);
    expect(project.workspaceId).toBe(space.id);

    // Ordinary accounts, project-bound credentials, and revoked administrators are refused.
    const memberCookie = await login(person.email);
    expect((await request("/api/v1/admin/workspaces", "GET", undefined, memberCookie)).status).toBe(
      403,
    );
    const key = await fixture.auth.api.createApiKey({
      body: {
        userId: owner.id,
        name: "Project-bound administrator key",
        metadata: { projectIds: [project.id] },
        permissions: { kanvil: ["admin"] },
      },
    });
    const bearer = (path: string, method = "GET", body?: unknown) =>
      application.app.fetch(
        new Request(`http://localhost:5180${path}`, {
          method,
          headers: { Authorization: `Bearer ${key.key}`, "Content-Type": "application/json" },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        }),
      );
    expect((await bearer("/api/v1/admin/workspaces")).status).toBe(403);
    expect((await bearer(members, "POST", { email: owner.email, role: "admin" })).status).toBe(403);
    expect(
      (await request("/api/auth/admin/set-role", "POST", { userId: peer.id, role: "user" })).status,
    ).toBe(200);
    expect((await request("/api/v1/admin/workspaces", "GET", undefined, peerCookie)).status).toBe(
      403,
    );
  });
});
