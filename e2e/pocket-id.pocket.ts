import { test, expect } from "@playwright/test";
import { z } from "zod";
import { signIn, ownerEmail } from "./auth.ts";

const pocket = "http://localhost:51411";
const headers = { "X-API-Key": "kanvil-isolated-test-admin-api-key" };
const sessionSchema = z.object({ user: z.object({ id: z.string() }) });
test("PocketID passkeys support explicit linking and subsequent OIDC login without losing local login", async ({
  page,
}) => {
  const created = await page.request.post(`${pocket}/api/users`, {
    headers,
    data: {
      username: `kanvil-${crypto.randomUUID().slice(0, 8)}`,
      email: ownerEmail,
      emailVerified: true,
      firstName: "Kanvil",
      lastName: "Test",
      isAdmin: false,
    },
  });
  expect(created.status(), await created.text()).toBe(201);
  const user = z.object({ id: z.string() }).parse(await created.json());
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
    await signIn(page);
    const before = sessionSchema.parse(
      await (await page.request.get("/api/auth/get-session")).json(),
    );
    await page.getByRole("link", { name: "Settings", exact: true }).click();
    await page.getByRole("button", { name: "Link PocketID", exact: true }).click();
    await page.waitForURL(`${pocket}/interaction?**`);
    await expect(page.getByRole("button", { name: "Sign in", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await expect(
      page.getByText("Account linked. You can sign in with PocketID.", { exact: true }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Sign out", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Sign in", exact: true })).toBeVisible();
    await page.context().clearCookies({ name: "access_token" });
    await page.context().clearCookies({ name: "session" });
    await page.getByRole("button", { name: "Sign in with PocketID", exact: true }).click();
    await page.waitForURL(`${pocket}/interaction?**`);
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Projects", exact: true })).toBeVisible();
    const after = sessionSchema.parse(
      await (await page.request.get("/api/auth/get-session")).json(),
    );
    expect(after.user.id).toBe(before.user.id);
    await page.getByRole("button", { name: "Sign out", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Sign in", exact: true })).toBeVisible();
    await signIn(page);
    const local = sessionSchema.parse(
      await (await page.request.get("/api/auth/get-session")).json(),
    );
    expect(local.user.id).toBe(before.user.id);
  } finally {
    await fetch(`${pocket}/api/users/${user.id}`, { method: "DELETE", headers });
  }
});
