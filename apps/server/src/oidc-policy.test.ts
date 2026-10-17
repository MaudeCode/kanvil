import { createServer } from "node:http";
import { generateKeyPairSync, sign } from "node:crypto";
import { afterAll, beforeAll, expect, it } from "vite-plus/test";
import { z } from "zod";
import { createFixture } from "./test-fixture.ts";
import { createApplication } from "./app.ts";
import { createAuth } from "./auth.ts";
import { recoverLocalPassword } from "./recover-account.ts";

const password = "Isolated-owner-password-234";
const cookies = (response: Response) =>
  response.headers
    .getSetCookie()
    .map((value) => value.split(";")[0])
    .join("; ");
const sessionSchema = z.object({
  user: z.object({ id: z.string(), role: z.string().nullable().optional() }),
});
const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwk = {
  ...publicKey.export({ format: "jwk" }),
  kid: "policy-test",
  alg: "RS256",
  use: "sig",
};
let fixture: Awaited<ReturnType<typeof createFixture>>;
let application: Awaited<ReturnType<typeof createApplication>>;
let origin = "";
let ownerId = "";
let ownerCookie = "";
let credential = "";
const grants = new Map<
  string,
  { sub: string; email?: string; email_verified: boolean; nonce: string; invalid?: string }
>();
function signedToken(claims: Record<string, unknown>, invalidSignature = false) {
  const body = `${Buffer.from(JSON.stringify({ alg: "RS256", kid: "policy-test" })).toString("base64url")}.${Buffer.from(JSON.stringify(claims)).toString("base64url")}`;
  const signature = sign("RSA-SHA256", Buffer.from(body), privateKey).toString("base64url");
  return `${body}.${invalidSignature ? "invalid" : signature}`;
}
const provider = createServer(async (req, res) => {
  res.setHeader("Content-Type", "application/json");
  if (req.url === "/.well-known/openid-configuration")
    return res.end(
      JSON.stringify({
        issuer: origin,
        authorization_endpoint: `${origin}/authorize`,
        token_endpoint: `${origin}/token`,
        userinfo_endpoint: `${origin}/userinfo`,
        jwks_uri: `${origin}/jwks`,
        response_types_supported: ["code"],
        subject_types_supported: ["public"],
        id_token_signing_alg_values_supported: ["RS256"],
      }),
    );
  if (req.url === "/jwks") return res.end(JSON.stringify({ keys: [jwk] }));
  if (req.url === "/token") {
    const parts: Buffer[] = [];
    for await (const chunk of req) parts.push(Buffer.from(chunk));
    const grant = grants.get(
      new URLSearchParams(Buffer.concat(parts).toString()).get("code") ?? "",
    );
    if (!grant) {
      res.statusCode = 400;
      return res.end("{}");
    }
    const { nonce, invalid, ...identity } = grant;
    const claims = {
      ...identity,
      ...(["userinfo-email", "userinfo-mismatch"].includes(invalid ?? "")
        ? { email: undefined }
        : {}),
      ...(invalid === "userinfo-verification" ? { email_verified: undefined } : {}),
      iss: invalid === "issuer" ? `${origin}/wrong` : origin,
      aud: invalid === "audience" ? "other-client" : "policy-client",
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + (invalid === "expired" ? -300 : 300),
      nonce: invalid === "nonce" ? "wrong" : nonce,
    };
    return res.end(
      JSON.stringify({
        access_token: identity.sub,
        token_type: "Bearer",
        expires_in: 300,
        ...(invalid === "missing-token"
          ? {}
          : { id_token: signedToken(claims, invalid === "signature") }),
      }),
    );
  }
  if (req.url === "/userinfo") {
    const sub = req.headers.authorization?.replace("Bearer ", "");
    const identity = [...grants.values()].find((value) => value.sub === sub);
    return res.end(
      JSON.stringify({
        ...identity,
        ...(identity?.invalid === "userinfo-mismatch" ? { sub: "another-subject" } : {}),
        name: "SSO person",
      }),
    );
  }
  res.statusCode = 404;
  return res.end("{}");
});
const request = (path: string, method = "GET", body?: unknown, cookie = ownerCookie) =>
  application.app.fetch(
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
async function setPolicy(emailPasswordEnabled: boolean, ssoAutoProvision: boolean) {
  const current = z
    .object({ version: z.number() })
    .parse(await (await request("/api/v1/admin/instance")).json());
  return request("/api/v1/admin/instance", "PATCH", {
    expectedVersion: current.version,
    name: "Kanvil",
    description: "",
    storage: { provider: "local" },
    search: { provider: "postgres" },
    authentication: { emailPasswordEnabled, ssoAutoProvision },
  });
}
async function begin() {
  const response = await request(
    "/api/auth/sign-in/social",
    "POST",
    { provider: "oidc", callbackURL: "http://localhost:5180/" },
    "",
  );
  expect(response.status, await response.clone().text()).toBe(200);
  const { url } = z.object({ url: z.string() }).parse(await response.json());
  return { url: new URL(url), cookie: cookies(response) };
}
async function callback(identity: {
  sub: string;
  email?: string;
  email_verified: boolean;
  invalid?: string;
}) {
  const flow = await begin();
  return finish(flow, identity);
}
async function finish(
  flow: Awaited<ReturnType<typeof begin>>,
  identity: { sub: string; email?: string; email_verified: boolean; invalid?: string },
) {
  const code = crypto.randomUUID();
  grants.set(code, { ...identity, nonce: flow.url.searchParams.get("nonce") ?? "" });
  return request(
    `/api/auth/callback/oidc?code=${code}&state=${flow.url.searchParams.get("state")}`,
    "GET",
    undefined,
    flow.cookie,
  );
}
async function userCount() {
  return (await fixture.database.pool.query('SELECT count(*)::int AS count FROM "user"')).rows[0]
    ?.count;
}
async function linkedOwner() {
  await fixture.database.pool.query("DELETE FROM account WHERE user_id=$1 AND provider_id='oidc'", [
    ownerId,
  ]);
  await fixture.database.pool.query(
    `INSERT INTO account (id, account_id, provider_id, user_id, id_token, created_at, updated_at) VALUES ($1, 'owner-subject', 'oidc', $2, $3, now(), now()) ON CONFLICT DO NOTHING`,
    [
      crypto.randomUUID(),
      ownerId,
      signedToken({
        sub: "owner-subject",
        iss: origin,
        aud: "policy-client",
        exp: Math.floor(Date.now() / 1000) + 300,
      }),
    ],
  );
}
beforeAll(async () => {
  await new Promise<void>((resolve) => provider.listen(0, "127.0.0.1", resolve));
  const address = provider.address();
  if (!address || typeof address === "string") throw new Error("Missing fixture address");
  origin = `http://127.0.0.1:${address.port}`;
  fixture = await createFixture();
  Object.assign(fixture.config, {
    OIDC_DISCOVERY_URL: `${origin}/.well-known/openid-configuration`,
    OIDC_CLIENT_ID: "policy-client",
    OIDC_CLIENT_SECRET: "policy-secret",
  });
  application = await createApplication(fixture.database, fixture.config);
  const owner = await application.auth.api.createUser({
    body: { name: "Owner", email: "owner@policy.test", password, role: "admin" },
  });
  ownerId = owner.user.id;
  ownerCookie = cookies(
    await request("/api/auth/sign-in/email", "POST", { email: owner.user.email, password }, ""),
  );
  const space = z
    .object({ id: z.string() })
    .parse(
      await (
        await request("/api/v1/workspaces", "POST", { name: "Policy", slug: "policy" })
      ).json(),
    );
  const project = z.object({ id: z.string() }).parse(
    await (
      await request("/api/v1/projects", "POST", {
        workspaceId: space.id,
        name: "Policy",
        key: "POL",
      })
    ).json(),
  );
  credential = z.object({ key: z.string() }).parse(
    await (
      await request("/api/v1/credentials", "POST", {
        name: "Policy fixture",
        projectIds: [project.id],
        scopes: ["read"],
      })
    ).json(),
  ).key;
});
afterAll(async () => {
  await application?.close();
  await fixture?.close();
  await new Promise<void>((resolve, reject) =>
    provider.close((error) => (error ? reject(error) : resolve())),
  );
});
it("requires the acting administrator's OIDC binding before disabling passwords", async () => {
  const rejected = await setPolicy(false, true);
  expect(rejected.status).toBe(409);
  expect(await rejected.json()).toMatchObject({ error: { code: "oidc_binding_required" } });
  await linkedOwner();
});
it.each([
  [true, false],
  [true, true],
  [false, false],
  [false, true],
])(
  "enforces password=%s provisioning=%s on direct endpoints",
  async (passwordEnabled, provisioning) => {
    expect((await setPolicy(passwordEnabled, provisioning)).status).toBe(200);
    expect(
      (
        await request(
          "/api/auth/sign-in/email",
          "POST",
          { email: "owner@policy.test", password },
          "",
        )
      ).status,
    ).toBe(passwordEnabled ? 200 : 403);
    expect(
      (
        await request(
          "/api/auth/sign-up/email",
          "POST",
          { name: "Public", email: "public@policy.test", password },
          "",
        )
      ).ok,
    ).toBe(false);
    const sub = `person-${passwordEnabled}-${provisioning}`;
    const count = await userCount();
    const response = await callback({ sub, email: `${sub}@policy.test`, email_verified: true });
    if (!provisioning) {
      expect(response.headers.get("location")).toContain("error=signup_disabled");
      expect(await userCount()).toBe(count);
    } else {
      const session = sessionSchema.parse(
        await (await request("/api/auth/get-session", "GET", undefined, cookies(response))).json(),
      );
      expect(session.user.role).toBe("user");
      expect(await userCount()).toBe(count + 1);
      const memberships = await fixture.database.pool.query(
        `SELECT user_id FROM workspace_members WHERE user_id=$1 UNION ALL SELECT user_id FROM project_members WHERE user_id=$1`,
        [session.user.id],
      );
      expect(memberships.rowCount).toBe(0);
      const again = await callback({ sub, email: `${sub}@policy.test`, email_verified: true });
      expect(
        sessionSchema.parse(
          await (await request("/api/auth/get-session", "GET", undefined, cookies(again))).json(),
        ).user.id,
      ).toBe(session.user.id);
      expect((await setPolicy(passwordEnabled, false)).status).toBe(200);
      const returning = await callback({ sub, email: `${sub}@policy.test`, email_verified: true });
      expect(
        sessionSchema.parse(
          await (
            await request("/api/auth/get-session", "GET", undefined, cookies(returning))
          ).json(),
        ).user.id,
      ).toBe(session.user.id);
    }
    expect((await request("/api/v1/admin/instance")).status).toBe(200);
    const machine = await application.app.fetch(
      new Request("http://localhost:5180/api/v1/projects", {
        headers: { Authorization: `Bearer ${credential}` },
      }),
    );
    expect(machine.status).toBe(200);
  },
);
it.each([
  "unverified",
  "missing-email",
  "nonce",
  "signature",
  "issuer",
  "audience",
  "expired",
  "missing-token",
])("rejects %s identities without creating users", async (invalid) => {
  expect((await setPolicy(true, true)).status).toBe(200);
  const count = await userCount();
  const response = await callback({
    sub: invalid,
    ...(invalid === "missing-email" ? {} : { email: `${invalid}@policy.test` }),
    email_verified: invalid !== "unverified",
    invalid,
  });
  expect(response.headers.get("location")).toContain("error=");
  expect(await userCount()).toBe(count);
});
it("does not implicitly claim a same-email local account or accept missing state", async () => {
  const count = await userCount();
  const collision = await callback({
    sub: "unlinked-owner",
    email: "owner@policy.test",
    email_verified: true,
  });
  expect(collision.headers.get("location")).toContain("account_not_linked");
  expect(await userCount()).toBe(count);
  const invalid = await request("/api/auth/callback/oidc?code=invalid", "GET", undefined, "");
  expect(invalid.headers.get("location")).toContain("error=");
  expect(await userCount()).toBe(count);
});
it("reads policy after reload and rejects a new identity when provisioning changes during authorization", async () => {
  expect((await setPolicy(false, true)).status).toBe(200);
  const flow = await begin();
  expect((await setPolicy(false, false)).status).toBe(200);
  const count = await userCount();
  const response = await finish(flow, {
    sub: "in-flight",
    email: "in-flight@policy.test",
    email_verified: true,
  });
  expect(response.headers.get("location")).toContain("signup_disabled");
  expect(await userCount()).toBe(count);
  const reloaded = createAuth(fixture.database, fixture.config);
  await expect(
    reloaded.api.signInEmail({ body: { email: "owner@policy.test", password } }),
  ).rejects.toMatchObject({ status: "FORBIDDEN" });
  await recoverLocalPassword(fixture.database, fixture.config, "owner@policy.test", password);
  await expect(
    reloaded.api.signInEmail({ body: { email: "owner@policy.test", password } }),
  ).rejects.toMatchObject({ status: "FORBIDDEN" });
  await recoverLocalPassword(fixture.database, fixture.config, "owner@policy.test", password, true);
  const recovered = await request(
    "/api/auth/sign-in/email",
    "POST",
    { email: "owner@policy.test", password },
    "",
  );
  expect(recovered.status).toBe(200);
  ownerCookie = cookies(recovered);
});

it("rolls back new users if their provider binding cannot be saved", async () => {
  expect((await setPolicy(true, true)).status).toBe(200);
  await fixture.database.pool
    .query(`CREATE FUNCTION reject_policy_account() RETURNS trigger AS $$ BEGIN IF NEW.account_id = 'reject-binding' THEN RAISE EXCEPTION 'test-owned binding failure'; END IF; RETURN NEW; END; $$ LANGUAGE plpgsql;
    CREATE TRIGGER reject_policy_account BEFORE INSERT ON account FOR EACH ROW EXECUTE FUNCTION reject_policy_account()`);
  try {
    const count = await userCount();
    const response = await callback({
      sub: "reject-binding",
      email: "reject-binding@policy.test",
      email_verified: true,
    });
    expect(response.headers.get("location")).toContain("error=");
    expect(await userCount()).toBe(count);
  } finally {
    await fixture.database.pool.query(
      "DROP TRIGGER reject_policy_account ON account; DROP FUNCTION reject_policy_account()",
    );
  }
});

it.each(["userinfo-email", "userinfo-verification"])(
  "accepts verified UserInfo identity when %s is omitted from the ID token",
  async (invalid) => {
    expect((await setPolicy(true, true)).status).toBe(200);
    const response = await callback({
      sub: invalid,
      email: `${invalid}@policy.test`,
      email_verified: true,
      invalid,
    });
    expect(response.headers.get("location")).toBe("http://localhost:5180/");
    expect(
      sessionSchema.parse(
        await (await request("/api/auth/get-session", "GET", undefined, cookies(response))).json(),
      ).user.role,
    ).toBe("user");
  },
);
it("rejects a UserInfo subject that differs from the verified ID token", async () => {
  const count = await userCount();
  const response = await callback({
    sub: "userinfo-mismatch",
    email: "userinfo-mismatch@policy.test",
    email_verified: true,
    invalid: "userinfo-mismatch",
  });
  expect(response.headers.get("location")).toContain("error=");
  expect(await userCount()).toBe(count);
});
it("rejects an administrator binding from a previous provider configuration", async () => {
  const previous = fixture.config.OIDC_CLIENT_ID;
  fixture.config.OIDC_CLIENT_ID = "replacement-client";
  try {
    const response = await setPolicy(false, false);
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: { code: "oidc_binding_required" } });
  } finally {
    fixture.config.OIDC_CLIENT_ID = previous;
    expect((await setPolicy(true, false)).status).toBe(200);
  }
});

it("keeps an SSO-only administrator's last matching binding until passwords are enabled", async () => {
  await linkedOwner();
  const binding = z
    .object({ id: z.string() })
    .parse(
      (
        await fixture.database.pool.query(
          "SELECT id FROM account WHERE user_id=$1 AND provider_id='oidc'",
          [ownerId],
        )
      ).rows[0],
    );
  expect((await setPolicy(false, false)).status).toBe(200);
  try {
    const rejected = await request("/api/auth/unlink-account", "POST", { accountId: binding.id });
    expect(rejected.status).toBe(409);
    expect(await rejected.json()).toMatchObject({ error: { code: "oidc_binding_required" } });
    expect(
      (await fixture.database.pool.query("SELECT id FROM account WHERE id=$1", [binding.id]))
        .rowCount,
    ).toBe(1);
    expect((await setPolicy(true, false)).status).toBe(200);
    expect(
      (await request("/api/auth/unlink-account", "POST", { accountId: binding.id })).status,
    ).toBe(200);
    expect(
      (await fixture.database.pool.query("SELECT id FROM account WHERE id=$1", [binding.id]))
        .rowCount,
    ).toBe(0);
  } finally {
    expect((await setPolicy(true, false)).status).toBe(200);
    await linkedOwner();
  }
});
it("serializes password disabling with account unlinking", async () => {
  expect((await setPolicy(true, false)).status).toBe(200);
  await linkedOwner();
  const binding = z
    .object({ id: z.string() })
    .parse(
      (
        await fixture.database.pool.query(
          "SELECT id FROM account WHERE user_id=$1 AND provider_id='oidc'",
          [ownerId],
        )
      ).rows[0],
    );
  try {
    const [policy, unlink] = await Promise.all([
      setPolicy(false, false),
      request("/api/auth/unlink-account", "POST", { accountId: binding.id }),
    ]);
    expect([policy.status, unlink.status].toSorted((left, right) => left - right)).toEqual([
      200, 409,
    ]);
  } finally {
    expect((await setPolicy(true, false)).status).toBe(200);
    await linkedOwner();
  }
});

it("permits unlinking one of several matching OIDC bindings in SSO-only mode", async () => {
  await linkedOwner();
  const binding = z
    .object({ id: z.string() })
    .parse(
      (
        await fixture.database.pool.query(
          "SELECT id FROM account WHERE user_id=$1 AND provider_id='oidc'",
          [ownerId],
        )
      ).rows[0],
    );
  await fixture.database.pool.query(
    `INSERT INTO account (id, account_id, provider_id, user_id, id_token, created_at, updated_at) VALUES ($1,'owner-second','oidc',$2,$3,now(),now())`,
    [
      crypto.randomUUID(),
      ownerId,
      signedToken({ sub: "owner-second", iss: origin, aud: "policy-client" }),
    ],
  );
  expect((await setPolicy(false, false)).status).toBe(200);
  try {
    expect(
      (await request("/api/auth/unlink-account", "POST", { accountId: binding.id })).status,
    ).toBe(200);
    expect(
      (
        await fixture.database.pool.query(
          "SELECT id FROM account WHERE user_id=$1 AND provider_id='oidc'",
          [ownerId],
        )
      ).rowCount,
    ).toBe(1);
  } finally {
    expect((await setPolicy(true, false)).status).toBe(200);
    await linkedOwner();
  }
});
it("preserves ordinary users' usable sign-in methods without requiring administrator access to unlink", async () => {
  const person = await application.auth.api.createUser({
    body: { name: "Member", email: "unlink-member@policy.test", password, role: "user" },
  });
  const memberCookie = cookies(
    await request("/api/auth/sign-in/email", "POST", { email: person.user.email, password }, ""),
  );
  const id = crypto.randomUUID();
  await fixture.database.pool.query(
    `INSERT INTO account (id, account_id, provider_id, user_id, id_token, created_at, updated_at) VALUES ($1,'member-subject','oidc',$2,$3,now(),now())`,
    [id, person.user.id, signedToken({ sub: "member-subject", iss: origin, aud: "policy-client" })],
  );
  expect((await setPolicy(false, false)).status).toBe(200);
  try {
    expect(
      (await request("/api/auth/unlink-account", "POST", { accountId: id }, memberCookie)).status,
    ).toBe(409);
    expect((await setPolicy(true, false)).status).toBe(200);
    expect(
      (await request("/api/auth/unlink-account", "POST", { accountId: id }, memberCookie)).status,
    ).toBe(200);
  } finally {
    expect((await setPolicy(true, false)).status).toBe(200);
  }
});
