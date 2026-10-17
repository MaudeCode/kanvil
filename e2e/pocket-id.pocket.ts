import { accountMenu, appearance, signOut } from "./controls.ts";
import { test, expect, type Page } from "@playwright/test";
import { z } from "zod";
import { signIn, ownerEmail, ownerPassword } from "./auth.ts";

const pocket = `http://localhost:${process.env.KANVIL_TEST_POCKET_PORT ?? 51411}`;
const headers = { "X-API-Key": "kanvil-isolated-test-admin-api-key" };
const sessionSchema = z.object({
  user: z.object({ id: z.string(), email: z.string(), role: z.string() }),
});
async function accounts(page: Page) {
  return z
    .array(z.object({ id: z.string(), providerId: z.string() }))
    .parse(await (await page.request.get("/api/auth/list-accounts")).json());
}
async function unlink(page: Page, origin: string) {
  const account = (await accounts(page)).find((candidate) => candidate.providerId === "oidc");
  if (!account) return;
  const result = await page.request.post("/api/auth/unlink-account", {
    headers: { Origin: origin },
    data: { accountId: account.id },
  });
  expect(result.ok(), await result.text()).toBe(true);
}
async function resetProvider(page: Page) {
  await page.context().clearCookies({ name: "access_token" });
  await page.context().clearCookies({ name: "session" });
}
async function authorize(page: Page) {
  await page.waitForURL(`${pocket}/interaction?**`);
  // PocketID can require passkey authentication followed by a separate consent step.
  for (let step = 0; step < 2; step++) {
    const completed = page.waitForResponse(
      (response) =>
        response.url().startsWith(`${pocket}/api/oidc/interactions/`) &&
        response.url().endsWith("/complete") &&
        response.request().method() === "POST",
    );
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    const response = await completed;
    expect(response.ok()).toBe(true);
    const result = z
      .object({ interaction: z.object({ currentStep: z.string() }).optional() })
      .parse(await response.json());
    if (result.interaction?.currentStep === "consent") continue;
    await page.waitForURL((url) => url.origin !== pocket);
    return;
  }
  throw new Error("PocketID did not finish authentication and consent");
}
async function provisionPasskey(page: Page, email: string) {
  const created = await page.request.post(`${pocket}/api/users`, {
    headers,
    data: {
      username: `kanvil-${crypto.randomUUID().slice(0, 8)}`,
      email,
      emailVerified: true,
      firstName: "Kanvil",
      lastName: "Test",
      isAdmin: false,
    },
  });
  expect(created.status(), await created.text()).toBe(201);
  const user = z.object({ id: z.string(), username: z.string() }).parse(await created.json());
  try {
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("WebAuthn.enable");
    await cdp.send("WebAuthn.addVirtualAuthenticator", {
      options: {
        protocol: "ctap2",
        transport: "internal",
        hasResidentKey: true,
        hasUserVerification: true,
        isUserVerified: true,
        automaticPresenceSimulation: true,
      },
    });
    const codeResponse = await page.request.post(
      `${pocket}/api/users/${user.id}/one-time-access-token`,
      { headers, data: { ttl: "1h" } },
    );
    expect(codeResponse.status()).toBe(201);
    const access = z.object({ token: z.string() }).parse(await codeResponse.json());
    await page.goto(`${pocket}/lc/${access.token}`);
    await expect(
      page.getByRole("heading", { name: "Set up your passkey", exact: true }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Add Passkey", exact: true }).click();
    await page.waitForURL(`${pocket}/settings/account`);
    return user;
  } catch (error) {
    await fetch(`${pocket}/api/users/${user.id}`, { method: "DELETE", headers });
    throw error;
  }
}
async function oidcSignIn(page: Page) {
  await resetProvider(page);
  await page.getByRole("button", { name: "Sign in with PocketID", exact: true }).click();
  await authorize(page);
}
for (const email of [ownerEmail, "sso-different@example.test"]) {
  test(`PocketID explicitly links ${email} and preserves local identity`, async ({
    page,
    baseURL,
    request,
  }, testInfo) => {
    if (!baseURL) throw new Error("Expected an isolated test server");
    const origin = baseURL;
    test.setTimeout(60_000);
    const user = await provisionPasskey(page, email);
    try {
      await signIn(page);
      const before = sessionSchema.parse(
        await (await page.request.get("/api/auth/get-session")).json(),
      );
      const project = await page.request.post("/api/v1/projects", {
        data: {
          key: `L${crypto.randomUUID().slice(0, 6).toUpperCase()}`,
          name: "Linked identity access",
        },
      });
      expect(project.status()).toBe(200);
      const { id: projectId } = z.object({ id: z.string() }).parse(await project.json());
      const membersBefore = await (
        await page.request.get(`/api/v1/projects/${projectId}/members`)
      ).json();
      const projectsBefore = await (await page.request.get("/api/v1/projects")).json();
      const usersBefore = await (await page.request.get("/api/auth/admin/list-users")).json();
      await accountMenu(page);
      await page.getByRole("menuitem", { name: "User settings", exact: true }).click();
      await resetProvider(page);
      await page.getByRole("button", { name: "Link PocketID", exact: true }).click();
      await authorize(page);
      await expect(page.getByText("Linked", { exact: true })).toBeVisible();
      await page.reload();
      await expect(page.getByText("Linked", { exact: true })).toBeVisible();
      const screenshot = testInfo.outputPath("linked.png");
      await page.screenshot({ path: screenshot, animations: "disabled" });
      await testInfo.attach("Linked account after reload", {
        path: screenshot,
        contentType: "image/png",
      });
      let linked = await accounts(page);
      await expect(page.getByRole("alert")).toHaveCount(0);
      expect(new URL(page.url()).searchParams.has("error")).toBe(false);
      // Retrying the same explicit binding must keep exactly the same account records.
      const repeat = await page.request.post("/api/auth/link-social", {
        headers: { Origin: origin },
        data: {
          provider: "oidc",
          callbackURL: `${origin}/settings?section=account`,
          errorCallbackURL: `${origin}/settings?section=account`,
          disableRedirect: true,
        },
      });
      expect(repeat.ok()).toBe(true);
      await resetProvider(page);
      await page.goto(z.object({ url: z.string() }).parse(await repeat.json()).url);
      await authorize(page);
      await expect(page.getByText("Linked", { exact: true })).toBeVisible();
      expect(await accounts(page)).toEqual(linked);
      expect(await (await page.request.get("/api/auth/admin/list-users")).json()).toEqual(
        usersBefore,
      );
      expect(linked.filter((account) => account.providerId === "oidc")).toHaveLength(1);
      await unlink(page, origin);
      await page.reload();
      if (email !== ownerEmail) {
        const profile = {
          username: user.username,
          email,
          firstName: "Kanvil",
          lastName: "Test",
          isAdmin: false,
        };
        const unverify = await request.put(`${pocket}/api/users/${user.id}`, {
          headers,
          data: { ...profile, emailVerified: false },
        });
        expect(unverify.ok(), await unverify.text()).toBe(true);
        await resetProvider(page);
        await page.getByRole("button", { name: "Link PocketID", exact: true }).click();
        await authorize(page);
        await expect(page.getByRole("alert")).toContainText("Sign-in could not be completed.");
        expect(
          (await accounts(page)).filter((account) => account.providerId === "oidc"),
        ).toHaveLength(0);
        const verify = await request.put(`${pocket}/api/users/${user.id}`, {
          headers,
          data: { ...profile, emailVerified: true },
        });
        expect(verify.ok(), await verify.text()).toBe(true);
      }
      // A real state-bound callback must return cancellation to Settings without binding.
      await page.route(
        `${pocket}/authorize?**`,
        async (route) => {
          const state = new URL(route.request().url()).searchParams.get("state");
          expect(state).toBeTruthy();
          const callback = new URL("/api/auth/callback/oidc", origin);
          callback.search = new URLSearchParams({
            state: state ?? "",
            error: "access_denied",
            error_description: "secret-provider-detail",
          }).toString();
          await route.fulfill({ status: 302, headers: { location: callback.href } });
        },
        { times: 1 },
      );
      await resetProvider(page);
      await page.getByRole("button", { name: "Link PocketID", exact: true }).click();
      await expect(page.getByRole("alert")).toContainText("Sign-in was cancelled.");
      await expect(page.getByText("secret-provider-detail")).toHaveCount(0);
      expect(
        (await accounts(page)).filter((account) => account.providerId === "oidc"),
      ).toHaveLength(0);
      await page.reload();
      await expect(page.getByRole("alert")).toContainText("Sign-in was cancelled.");
      await resetProvider(page);
      await page.getByRole("button", { name: "Link PocketID", exact: true }).click();
      await authorize(page);
      await expect(page.getByText("Linked", { exact: true })).toBeVisible();
      await expect(page.getByRole("alert")).toHaveCount(0);
      await signOut(page);
      await expect(page.getByRole("heading", { name: "Sign in", exact: true })).toBeVisible();
      await resetProvider(page);
      await page.getByRole("button", { name: "Sign in with PocketID", exact: true }).click();
      await authorize(page);
      await expect(page.getByRole("heading", { name: "Projects", exact: true })).toBeVisible();
      const after = sessionSchema.parse(
        await (await page.request.get("/api/auth/get-session")).json(),
      );
      expect(after.user).toEqual(before.user);
      expect(await (await page.request.get("/api/v1/projects")).json()).toEqual(projectsBefore);
      expect(
        await (await page.request.get(`/api/v1/projects/${projectId}/members`)).json(),
      ).toEqual(membersBefore);
      await signOut(page);
      await expect(page.getByRole("heading", { name: "Sign in", exact: true })).toBeVisible();
      await signIn(page);
      const local = sessionSchema.parse(
        await (await page.request.get("/api/auth/get-session")).json(),
      );
      expect(local.user).toEqual(before.user);
      linked = await accounts(page);
      // A second local user cannot steal the provider subject from its existing owner.
      const otherEmail = `other-${crypto.randomUUID()}@example.test`;
      const createdOther = await page.request.post("/api/auth/admin/create-user", {
        headers: { Origin: origin },
        data: {
          email: otherEmail,
          password: ownerPassword,
          name: "Other local user",
          role: "user",
        },
      });
      expect(createdOther.ok()).toBe(true);
      await signOut(page);
      const otherLogin = await page.request.post("/api/auth/sign-in/email", {
        headers: { Origin: origin },
        data: { email: otherEmail, password: ownerPassword },
      });
      expect(otherLogin.ok()).toBe(true);
      await page.goto("/settings");
      await resetProvider(page);
      await page.getByRole("button", { name: "Link PocketID", exact: true }).click();
      await authorize(page);
      await expect(page.getByRole("alert")).toContainText(
        "already linked to another Kanvil account",
      );
      expect(
        (await accounts(page)).filter((account) => account.providerId === "oidc"),
      ).toHaveLength(0);
      await signOut(page);
      await signIn(page);
      expect(await accounts(page)).toEqual(linked);
      await unlink(page, origin);
      await signOut(page);
      const unauthenticated = await request.post("/api/auth/link-social", {
        headers: { Origin: origin },
        data: { provider: "oidc" },
      });
      expect(unauthenticated.status()).toBe(401);
      // Closed signup and implicit linking stay closed even for a matching local email.
      await resetProvider(page);
      await page.getByRole("button", { name: "Sign in with PocketID", exact: true }).click();
      await authorize(page);
      await expect(page.getByRole("alert")).toContainText("not linked to a Kanvil account");
      await signIn(page);
      expect(
        (await accounts(page)).filter((account) => account.providerId === "oidc"),
      ).toHaveLength(0);
      // An invalid OAuth state can never create a binding.
      await page.goto("/api/auth/callback/oidc?state=invalid-test-state&code=unused-test-code");
      await expect(page.getByRole("alert")).toBeVisible();
      await page.goto("/settings");
      expect(
        (await accounts(page)).filter((account) => account.providerId === "oidc"),
      ).toHaveLength(0);
    } finally {
      try {
        await page.request.post("/api/auth/sign-in/email", {
          headers: { Origin: origin },
          data: { email: ownerEmail, password: ownerPassword },
        });
        await unlink(page, origin);
      } finally {
        const removed = await request.delete(`${pocket}/api/users/${user.id}`, { headers });
        expect(removed.ok(), await removed.text()).toBe(true);
      }
    }
  });
}

test("PocketID passkeys support explicit linking and subsequent OIDC login without losing local login", async ({
  page,
  baseURL,
}) => {
  if (!baseURL) throw new Error("Expected an isolated test server");
  test.setTimeout(60_000);
  await page.emulateMedia({ reducedMotion: "reduce" });
  const user = await provisionPasskey(page, ownerEmail);
  try {
    await signIn(page);
    const before = sessionSchema.parse(
      await (await page.request.get("/api/auth/get-session")).json(),
    );
    await accountMenu(page);
    await page.getByRole("menuitem", { name: "User settings", exact: true }).click();
    await page.getByRole("button", { name: "Link PocketID", exact: true }).click();
    await authorize(page);
    await expect(page.getByText("Linked", { exact: true })).toBeVisible();
    await signOut(page);
    await expect(page.getByRole("heading", { name: "Sign in", exact: true })).toBeVisible();
    await oidcSignIn(page);
    await expect(page.getByRole("heading", { name: "Projects", exact: true })).toBeVisible();
    const after = sessionSchema.parse(
      await (await page.request.get("/api/auth/get-session")).json(),
    );
    expect(after.user.id).toBe(before.user.id);
    await signOut(page);
    await expect(page.getByRole("heading", { name: "Sign in", exact: true })).toBeVisible();
    await signIn(page);
    const local = sessionSchema.parse(
      await (await page.request.get("/api/auth/get-session")).json(),
    );
    expect(local.user.id).toBe(before.user.id);
    await page.goto("/admin?section=authentication");
    await page.getByRole("switch", { name: "Email and password sign-in", exact: true }).uncheck();
    await page
      .getByRole("switch", { name: "Automatically create users from SSO", exact: true })
      .check();
    await page.getByRole("button", { name: "Save authentication", exact: true }).click();
    await expect(page.getByText("Authentication saved", { exact: true })).toBeVisible();
    const ownerBinding = (await accounts(page)).find((account) => account.providerId === "oidc");
    expect(ownerBinding).toBeDefined();
    const blockedUnlink = await page.request.post("/api/auth/unlink-account", {
      headers: { Origin: baseURL },
      data: { accountId: ownerBinding?.id },
    });
    expect(blockedUnlink.status()).toBe(409);
    expect(await blockedUnlink.json()).toMatchObject({ error: { code: "oidc_binding_required" } });
    await appearance(page, "Dark");
    await signOut(page);
    await expect(
      page.getByRole("button", { name: "Use email and password", exact: true }),
    ).toHaveCount(0);
    await expect(page.getByLabel("Password", { exact: true })).toHaveCount(0);
    await page.screenshot({
      path: "test-results/sso-only-login-desktop.png",
      fullPage: true,
      animations: "disabled",
    });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({
      path: "test-results/sso-only-login-mobile.png",
      fullPage: true,
      animations: "disabled",
    });
    await page.setViewportSize({ width: 1440, height: 1000 });
    await oidcSignIn(page);
    await expect(page.getByRole("heading", { name: "Projects", exact: true })).toBeVisible();
    const second = await page.context().browser()!.newContext();
    const newPage = await second.newPage();
    const newcomer = await provisionPasskey(
      newPage,
      `newcomer-${crypto.randomUUID()}@example.test`,
    );
    try {
      await page.goto("/admin?section=authentication");
      await page
        .getByRole("switch", { name: "Automatically create users from SSO", exact: true })
        .uncheck();
      await page.getByRole("button", { name: "Save authentication", exact: true }).click();
      await expect(page.getByText("Authentication saved", { exact: true })).toBeVisible();
      await newPage.goto(`${baseURL}/login`);
      await oidcSignIn(newPage);
      await expect(newPage).toHaveURL(/error=signup_disabled/);
      await page
        .getByRole("switch", { name: "Automatically create users from SSO", exact: true })
        .check();
      await page.getByRole("button", { name: "Save authentication", exact: true }).click();
      await expect(page.getByText("Authentication saved", { exact: true })).toBeVisible();
      await newPage.goto(`${baseURL}/login`);
      await oidcSignIn(newPage);
      await expect(newPage.getByRole("heading", { name: "Projects", exact: true })).toBeVisible();
      const firstSSO = sessionSchema.parse(
        await (await newPage.request.get(`${baseURL}/api/auth/get-session`)).json(),
      );
      expect(firstSSO.user.id).not.toBe(before.user.id);
      expect(await (await newPage.request.get(`${baseURL}/api/v1/workspaces`)).json()).toEqual([]);
      await page.goto("/admin?section=authentication");
      await page
        .getByRole("switch", { name: "Automatically create users from SSO", exact: true })
        .uncheck();
      await page.getByRole("button", { name: "Save authentication", exact: true }).click();
      await expect(page.getByText("Authentication saved", { exact: true })).toBeVisible();
      await signOut(newPage);
      await oidcSignIn(newPage);
      await expect(newPage.getByRole("heading", { name: "Projects", exact: true })).toBeVisible();
      expect(
        sessionSchema.parse(
          await (await newPage.request.get(`${baseURL}/api/auth/get-session`)).json(),
        ).user.id,
      ).toBe(firstSSO.user.id);
    } finally {
      await fetch(`${pocket}/api/users/${newcomer.id}`, { method: "DELETE", headers });
      await second.close();
    }
  } finally {
    const current = await page.request.get("/api/v1/admin/instance");
    if (current.ok()) {
      const settings = z
        .object({ version: z.number(), name: z.string(), description: z.string() })
        .parse(await current.json());
      await page.request.patch("/api/v1/admin/instance", {
        data: {
          expectedVersion: settings.version,
          name: settings.name,
          description: settings.description,
          storage: { provider: "local" },
          search: { provider: "postgres" },
          authentication: { emailPasswordEnabled: true, ssoAutoProvision: false },
        },
      });
    }
    await unlink(page, baseURL);
    await fetch(`${pocket}/api/users/${user.id}`, { method: "DELETE", headers });
  }
});
