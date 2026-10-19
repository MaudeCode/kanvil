import { createHash } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { z } from "zod";
import { infoSchema } from "@kanvil/contracts";
import { createFixture, startMailbox } from "./test-fixture.ts";
import { createApplication } from "./app.ts";
import { fakeOAuthCode, fakeOAuthProviders, type FakeIdentity } from "./oauth-provider-fixture.ts";

// Every provider and the SMTP relay are local fakes; no request leaves the machine.
const password = "Isolated-sign-in-password-234";
const origin = "http://localhost:5180";
const cookies = (response: Response) =>
  response.headers
    .getSetCookie()
    .map((value) => value.split(";")[0])
    .join("; ");
const sessionSchema = z.object({ user: z.object({ id: z.string(), email: z.string() }) });
let providers: ReturnType<typeof fakeOAuthProviders>;
let fixture: Awaited<ReturnType<typeof createFixture>>;
let mailbox: Awaited<ReturnType<typeof startMailbox>>;
let application: Awaited<ReturnType<typeof createApplication>>;
let ownerId = "";
let ownerCookie = "";
const request = (path: string, method = "GET", body?: unknown, cookie = ownerCookie) =>
  application.app.fetch(
    new Request(`${origin}${path}`, {
      method,
      headers: { Cookie: cookie, Origin: origin, "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );
const session = async (cookie: string) =>
  z
    .unknown()
    .parse(await (await request("/api/auth/get-session", "GET", undefined, cookie)).json());
async function userCount() {
  return (await fixture.database.pool.query('SELECT count(*)::int AS count FROM "user"')).rows[0]
    ?.count;
}
async function createPerson(email: string) {
  const created = await application.auth.api.createUser({
    body: { name: email.split("@")[0] ?? email, email, password, role: "user" },
  });
  return created.user.id;
}
// Waits for the mail sent after a response and returns its code; the send runs in the background.
async function nextCode(email: string, after: number) {
  await vi.waitFor(() => expect(mailbox.messages.length).toBeGreaterThan(after), {
    timeout: 5000,
  });
  const message = mailbox.messages[after] ?? "";
  expect(message).toContain(`To: ${email}`);
  return {
    code: /code is (\d{6})\./.exec(message)?.[1] ?? "",
    link: /(http:\/\/localhost:5180\/\S*\?\S*code=\S+)/.exec(message)?.[1] ?? "",
  };
}
// Lets a background send settle, then confirms none was made.
async function noMail(before: number) {
  await new Promise((resolve) => setTimeout(resolve, 300));
  expect(mailbox.messages).toHaveLength(before);
}
async function setPasswordPolicy(emailPasswordEnabled: boolean) {
  const current = z
    .object({ version: z.number() })
    .parse(await (await request("/api/v1/admin/instance")).json());
  return request("/api/v1/admin/instance", "PATCH", {
    expectedVersion: current.version,
    name: "Kanvil",
    description: "",
    storage: { provider: "local" },
    search: { provider: "postgres" },
    authentication: { emailPasswordEnabled, ssoAutoProvision: true },
  });
}

beforeAll(async () => {
  providers = fakeOAuthProviders(globalThis.fetch, "google-client");
  vi.stubGlobal("fetch", providers.fetch);
  mailbox = await startMailbox();
  fixture = await createFixture();
  Object.assign(fixture.config, {
    SMTP_URL: mailbox.url,
    SMTP_FROM: "Kanvil <kanvil@example.test>",
    GITHUB_CLIENT_ID: "github-client",
    GITHUB_CLIENT_SECRET: "github-secret",
    GOOGLE_CLIENT_ID: "google-client",
    GOOGLE_CLIENT_SECRET: "google-secret",
    DISCORD_CLIENT_ID: "discord-client",
    DISCORD_CLIENT_SECRET: "discord-secret",
  });
  application = await createApplication(fixture.database, fixture.config);
  ownerId = (
    await application.auth.api.createUser({
      body: { name: "Owner", email: "owner@sign-in.test", password, role: "admin" },
    })
  ).user.id;
  ownerCookie = cookies(
    await request("/api/auth/sign-in/email", "POST", { email: "owner@sign-in.test", password }, ""),
  );
});
afterAll(async () => {
  await application?.close();
  await fixture?.close();
  await mailbox?.close();
  vi.unstubAllGlobals();
});

it("lists only configured methods and keeps them absent otherwise", async () => {
  const info = infoSchema.parse(await (await request("/api/v1/info")).json());
  expect(info.providers).toEqual([
    { id: "github", name: "GitHub" },
    { id: "google", name: "Google" },
    { id: "discord", name: "Discord" },
  ]);
  expect(info).toMatchObject({ oidc: null, emailCodes: true });
  const bare = await createApplication(fixture.database, {
    ...fixture.config,
    SMTP_URL: undefined,
    SMTP_FROM: undefined,
    GITHUB_CLIENT_ID: undefined,
    GITHUB_CLIENT_SECRET: undefined,
    GOOGLE_CLIENT_ID: undefined,
    GOOGLE_CLIENT_SECRET: undefined,
    DISCORD_CLIENT_ID: undefined,
    DISCORD_CLIENT_SECRET: undefined,
  });
  try {
    const plain = infoSchema.parse(
      await (await bare.app.fetch(new Request(`${origin}/api/v1/info`))).json(),
    );
    expect(plain).toMatchObject({ providers: [], emailCodes: false });
    const code = await bare.app.fetch(
      new Request(`${origin}/api/auth/email-otp/send-verification-otp`, {
        method: "POST",
        headers: { Origin: origin, "Content-Type": "application/json" },
        body: JSON.stringify({ email: "owner@sign-in.test", type: "sign-in" }),
      }),
    );
    expect(code.status).toBe(403);
    expect(await code.json()).toMatchObject({ code: "email_codes_unavailable" });
    const social = await bare.app.fetch(
      new Request(`${origin}/api/auth/sign-in/social`, {
        method: "POST",
        headers: { Origin: origin, "Content-Type": "application/json" },
        body: JSON.stringify({ provider: "github", callbackURL: `${origin}/` }),
      }),
    );
    expect(social.ok).toBe(false);
  } finally {
    await bare.close();
  }
});

const send = (email: string) =>
  request("/api/auth/email-otp/send-verification-otp", "POST", { email, type: "sign-in" }, "");
const signInWithCode = (email: string, otp: string) =>
  request("/api/auth/sign-in/email-otp", "POST", { email, otp }, "");
describe("email codes", () => {
  beforeEach(() => {
    mailbox.messages.length = 0;
  });
  it("signs an existing account in once with an emailed code and link", async () => {
    await createPerson("code@sign-in.test");
    const response = await send("Code@Sign-In.test");
    expect(response.status).toBe(200);
    const { code, link } = await nextCode("code@sign-in.test", 0);
    expect(new URL(link).searchParams.get("code")).toBe(code);
    expect(new URL(link).searchParams.get("email")).toBe("code@sign-in.test");
    const stored = await fixture.database.pool.query<{ value: string }>(
      "SELECT value FROM verification WHERE identifier = 'sign-in-otp-code@sign-in.test'",
    );
    expect(stored.rows[0]?.value).not.toContain(code);
    const signedIn = await signInWithCode("code@sign-in.test", code);
    expect(signedIn.status).toBe(200);
    expect(sessionSchema.parse(await session(cookies(signedIn))).user.email).toBe(
      "code@sign-in.test",
    );
    expect((await signInWithCode("code@sign-in.test", code)).status).toBe(400);
  });

  it("answers unknown, disabled, and deleted addresses the same way without sending", async () => {
    const banned = await createPerson("banned@sign-in.test");
    await fixture.database.pool.query(`UPDATE "user" SET banned = true WHERE id = $1`, [banned]);
    const deleted = await createPerson("deleted@sign-in.test");
    expect(
      (
        await request(`/api/v1/accounts/${deleted}`, "DELETE", {
          confirmEmail: "deleted@sign-in.test",
        })
      ).status,
    ).toBe(200);
    for (const email of [
      "nobody@sign-in.test",
      "banned@sign-in.test",
      `deleted+${deleted}@kanvil.invalid`,
    ]) {
      const response = await send(email);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ success: true });
    }
    await noMail(0);
    const count = await userCount();
    expect((await signInWithCode("nobody@sign-in.test", "123456")).status).toBe(400);
    expect(await userCount()).toBe(count);
  });

  it("drops a code when its account is deleted or changes address", async () => {
    const leaving = await createPerson("leaver@sign-in.test");
    await send("leaver@sign-in.test");
    const left = await nextCode("leaver@sign-in.test", 0);
    expect(
      (
        await request(`/api/v1/accounts/${leaving}`, "DELETE", {
          confirmEmail: "leaver@sign-in.test",
        })
      ).status,
    ).toBe(200);
    const moving = await createPerson("mover@sign-in.test");
    await send("mover@sign-in.test");
    const moved = await nextCode("mover@sign-in.test", 1);
    await fixture.database.pool.query(
      `UPDATE "user" SET email = 'moved@sign-in.test' WHERE id = $1`,
      [moving],
    );
    // Each address now belongs to someone else, who must not inherit the earlier code.
    await createPerson("leaver@sign-in.test");
    await createPerson("mover@sign-in.test");
    expect((await signInWithCode("leaver@sign-in.test", left.code)).ok).toBe(false);
    expect((await signInWithCode("mover@sign-in.test", moved.code)).ok).toBe(false);
  });

  it("drops a reset code when the account is disabled, so it cannot set a password", async () => {
    const id = await createPerson("banned-reset@sign-in.test");
    await request(
      "/api/auth/email-otp/request-password-reset",
      "POST",
      { email: "banned-reset@sign-in.test" },
      "",
    );
    const { code } = await nextCode("banned-reset@sign-in.test", 0);
    expect((await request("/api/auth/admin/ban-user", "POST", { userId: id })).status).toBe(200);
    const reset = await request(
      "/api/auth/email-otp/reset-password",
      "POST",
      { email: "banned-reset@sign-in.test", otp: code, password: "Isolated-banned-password-89" },
      "",
    );
    expect(reset.ok).toBe(false);
  });

  it("refuses a reset while a renewed ban is in force", async () => {
    const id = await createPerson("rebanned@sign-in.test");
    // An expired ban leaves `banned` set; the account is active and may ask for a code.
    await fixture.database.pool.query(
      `UPDATE "user" SET banned = true, ban_expires = now() - interval '1 minute' WHERE id = $1`,
      [id],
    );
    await request(
      "/api/auth/email-otp/request-password-reset",
      "POST",
      { email: "rebanned@sign-in.test" },
      "",
    );
    const { code } = await nextCode("rebanned@sign-in.test", 0);
    await fixture.database.pool.query(
      `UPDATE "user" SET ban_expires = now() + interval '1 day' WHERE id = $1`,
      [id],
    );
    const reset = await request(
      "/api/auth/email-otp/reset-password",
      "POST",
      { email: "rebanned@sign-in.test", otp: code, password: "Isolated-rebanned-password-89" },
      "",
    );
    expect(reset.ok).toBe(false);
  });

  it("links back to the page the request started on, and only within Kanvil", async () => {
    await createPerson("returning@sign-in.test");
    const ask = (path: string) =>
      application.app.fetch(
        new Request(`${origin}/api/auth/email-otp/send-verification-otp`, {
          method: "POST",
          headers: { Origin: origin, "Content-Type": "application/json", "X-Kanvil-Return": path },
          body: JSON.stringify({ email: "returning@sign-in.test", type: "sign-in" }),
        }),
      );
    await ask("/invite/abc_DEF-123");
    expect(new URL((await nextCode("returning@sign-in.test", 0)).link).pathname).toBe(
      "/invite/abc_DEF-123",
    );
    await ask("//evil.example/steal");
    const offsite = new URL((await nextCode("returning@sign-in.test", 1)).link);
    expect(`${offsite.origin}${offsite.pathname}`).toBe(`${origin}/login`);
  });

  it("refuses a code issued before the account was disabled", async () => {
    const id = await createPerson("later-banned@sign-in.test");
    await send("later-banned@sign-in.test");
    const { code } = await nextCode("later-banned@sign-in.test", 0);
    await fixture.database.pool.query(`UPDATE "user" SET banned = true WHERE id = $1`, [id]);
    const response = await signInWithCode("later-banned@sign-in.test", code);
    expect(response.ok).toBe(false);
    expect(response.headers.getSetCookie().join()).not.toContain("session_token=");
  });

  it("expires codes and discards them after three wrong attempts", async () => {
    await createPerson("expiring@sign-in.test");
    await send("expiring@sign-in.test");
    const first = await nextCode("expiring@sign-in.test", 0);
    await fixture.database.pool.query(
      "UPDATE verification SET expires_at = now() - interval '1 second' WHERE identifier = 'sign-in-otp-expiring@sign-in.test'",
    );
    expect((await signInWithCode("expiring@sign-in.test", first.code)).status).toBe(400);
    await send("expiring@sign-in.test");
    const second = await nextCode("expiring@sign-in.test", 1);
    const wrong = second.code === "000000" ? "111111" : "000000";
    for (let attempt = 0; attempt < 3; attempt++)
      expect((await signInWithCode("expiring@sign-in.test", wrong)).ok).toBe(false);
    expect((await signInWithCode("expiring@sign-in.test", second.code)).ok).toBe(false);
  });

  it("sends at most three codes per address in fifteen minutes and keeps the last one valid", async () => {
    await createPerson("busy@sign-in.test");
    for (let attempt = 0; attempt < 3; attempt++) {
      expect((await send("busy@sign-in.test")).status).toBe(200);
      await nextCode("busy@sign-in.test", attempt);
    }
    const { code } = await nextCode("busy@sign-in.test", 2);
    expect((await send("busy@sign-in.test")).status).toBe(200);
    await noMail(3);
    expect((await signInWithCode("busy@sign-in.test", code)).status).toBe(200);
  });

  it("keeps the mailed code and the send allowance when a later email fails", async () => {
    await createPerson("bounced@sign-in.test");
    await send("bounced@sign-in.test");
    const { code } = await nextCode("bounced@sign-in.test", 0);
    mailbox.state.rejecting = true;
    try {
      expect((await send("bounced@sign-in.test")).status).toBe(200);
      await noMail(1);
    } finally {
      mailbox.state.rejecting = false;
    }
    for (let attempt = 1; attempt < 3; attempt++) {
      await send("bounced@sign-in.test");
      expect((await nextCode("bounced@sign-in.test", attempt)).code).toBe(code);
    }
    expect((await signInWithCode("bounced@sign-in.test", code)).status).toBe(200);
  });

  it("resets a password with a code and signs out every session", async () => {
    await createPerson("reset@sign-in.test");
    const before = cookies(
      await request(
        "/api/auth/sign-in/email",
        "POST",
        { email: "reset@sign-in.test", password },
        "",
      ),
    );
    expect(sessionSchema.safeParse(await session(before)).success).toBe(true);
    expect(
      (
        await request(
          "/api/auth/email-otp/request-password-reset",
          "POST",
          { email: "reset@sign-in.test" },
          "",
        )
      ).status,
    ).toBe(200);
    const { code, link } = await nextCode("reset@sign-in.test", 0);
    expect(mailbox.messages[0]).toContain("Subject: Reset your Kanvil password");
    expect(new URL(link).searchParams.get("reset")).toBe("1");
    const next = "Isolated-reset-password-567";
    const reset = (otp: string) =>
      request(
        "/api/auth/email-otp/reset-password",
        "POST",
        { email: "reset@sign-in.test", otp, password: next },
        "",
      );
    expect((await reset(code)).status).toBe(200);
    expect(await session(before)).toBeNull();
    expect((await reset(code)).ok).toBe(false);
    const old = await request(
      "/api/auth/sign-in/email",
      "POST",
      { email: "reset@sign-in.test", password },
      "",
    );
    expect(old.status).toBe(401);
    const fresh = await request(
      "/api/auth/sign-in/email",
      "POST",
      { email: "reset@sign-in.test", password: next },
      "",
    );
    expect(fresh.status).toBe(200);
  });

  it("closes the plugin's other email-code endpoints", async () => {
    for (const [path, body] of [
      [
        "/api/auth/email-otp/send-verification-otp",
        { email: "x@sign-in.test", type: "forget-password" },
      ],
      [
        "/api/auth/email-otp/send-verification-otp",
        { email: "x@sign-in.test", type: "email-verification" },
      ],
      ["/api/auth/email-otp/verify-email", { email: "x@sign-in.test", otp: "123456" }],
      [
        "/api/auth/email-otp/check-verification-otp",
        { email: "x@sign-in.test", type: "sign-in", otp: "123456" },
      ],
      ["/api/auth/email-otp/request-email-change", { newEmail: "y@sign-in.test" }],
      ["/api/auth/forget-password/email-otp", { email: "x@sign-in.test" }],
    ] as const)
      expect((await request(path, "POST", body)).status, path).toBe(404);
  });

  it("turns email codes off while password sign-in is disabled", async () => {
    await fixture.database.pool.query(
      `UPDATE instance_settings SET email_password_enabled = false WHERE id = 1`,
    );
    try {
      const info = infoSchema.parse(await (await request("/api/v1/info")).json());
      expect(info.emailCodes).toBe(false);
      expect((await send("owner@sign-in.test")).status).toBe(403);
      expect(
        (
          await request(
            "/api/auth/email-otp/reset-password",
            "POST",
            { email: "owner@sign-in.test", otp: "123456", password: "Isolated-other-password-89" },
            "",
          )
        ).status,
      ).toBe(403);
      await noMail(0);
    } finally {
      await fixture.database.pool.query(
        `UPDATE instance_settings SET email_password_enabled = true WHERE id = 1`,
      );
    }
    expect((await setPasswordPolicy(true)).status).toBe(200);
  });
});

describe.each(["github", "google", "discord"] as const)("%s sign-in", (provider) => {
  let subject = 9000;
  const identity = (email: string, extra: Partial<FakeIdentity> = {}): FakeIdentity => ({
    id: String((subject += 1)),
    email,
    verified: true,
    ...extra,
  });
  async function begin(path: string, cookie: string) {
    const response = await request(
      path,
      "POST",
      { provider, callbackURL: `${origin}/`, errorCallbackURL: `${origin}/login` },
      cookie,
    );
    expect(response.status, await response.clone().text()).toBe(200);
    const { url } = z.object({ url: z.string() }).parse(await response.json());
    return { url: new URL(url), cookie: [cookie, cookies(response)].filter(Boolean).join("; ") };
  }
  async function finish(
    flow: Awaited<ReturnType<typeof begin>>,
    person: FakeIdentity,
    state?: string,
  ) {
    const code = fakeOAuthCode(person);
    return request(
      `/api/auth/callback/${provider}?code=${code}&state=${state ?? flow.url.searchParams.get("state")}`,
      "GET",
      undefined,
      flow.cookie,
    );
  }
  const signIn = async (person: FakeIdentity) =>
    finish(await begin("/api/auth/sign-in/social", ""), person);

  it("never creates or implicitly claims an account, even with SSO provisioning on", async () => {
    expect((await setPasswordPolicy(true)).status).toBe(200);
    const count = await userCount();
    const stranger = await signIn(identity(`stranger-${provider}@sign-in.test`));
    expect(stranger.headers.get("location")).toMatch(/error=(signup_disabled|account_not_linked)/);
    const collision = await signIn(identity("owner@sign-in.test"));
    expect(collision.headers.get("location")).toContain("error=account_not_linked");
    expect(await userCount()).toBe(count);
  });

  // Discord's OAuth flow has no PKCE; state still binds its callback to the browser that began it.
  it("links explicitly, then signs that account in with state and PKCE", async () => {
    const person = identity(`linked-${provider}@elsewhere.test`);
    const link = await begin("/api/auth/link-social", ownerCookie);
    const challenge = link.url.searchParams.get("code_challenge");
    expect(link.url.searchParams.get("state")).toBeTruthy();
    if (provider !== "discord")
      expect(link.url.searchParams.get("code_challenge_method")).toBe("S256");
    const linked = await finish(link, person);
    expect(linked.headers.get("location")).toBe(`${origin}/`);
    if (provider !== "discord")
      expect(
        createHash("sha256")
          .update(providers.tokenRequests.at(-1)?.get("code_verifier") ?? "")
          .digest("base64url"),
      ).toBe(challenge);
    const accounts = await fixture.database.pool.query(
      "SELECT user_id FROM account WHERE provider_id = $1 AND account_id = $2",
      [provider, person.id],
    );
    expect(accounts.rows).toEqual([{ user_id: ownerId }]);
    const flow = await begin("/api/auth/sign-in/social", "");
    expect((await finish(flow, person, "forged-state")).headers.get("location")).toContain(
      "error=",
    );
    const response = await finish(flow, person);
    expect(response.headers.get("location")).toBe(`${origin}/`);
    expect(sessionSchema.parse(await session(cookies(response))).user.id).toBe(ownerId);
    expect((await finish(flow, person)).headers.get("location")).toContain("error=");
  });

  it("refuses identities the provider has not verified", async () => {
    const response = await signIn(
      identity(`unverified-${provider}@sign-in.test`, { verified: false }),
    );
    expect(response.headers.get("location")).toContain("error=");
    expect(response.headers.getSetCookie().join()).not.toContain("session_token=");
  });

  it.runIf(provider === "google").each(["signature", "audience"] as const)(
    "rejects a Google ID token with a bad %s",
    async (invalid) => {
      const person = identity("google-bad@elsewhere.test", { invalid });
      const link = await begin("/api/auth/link-social", ownerCookie);
      expect((await finish(link, person)).headers.get("location")).toContain("error=");
      const accounts = await fixture.database.pool.query(
        "SELECT 1 FROM account WHERE provider_id = 'google' AND account_id = $1",
        [person.id],
      );
      expect(accounts.rowCount).toBe(0);
    },
  );

  it.runIf(provider === "google")(
    "refuses posted ID tokens outside the redirect flow",
    async () => {
      const response = await request(
        "/api/auth/sign-in/social",
        "POST",
        { provider, idToken: { token: providers.googleToken({ sub: "1", aud: "google-client" }) } },
        "",
      );
      expect(response.ok).toBe(false);
    },
  );
});
