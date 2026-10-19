import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { codeFor, mailTo, ownerEmail, signIn, useEmailLogin } from "./auth.ts";
import { fakeOAuthCode } from "../apps/server/src/oauth-provider-fixture.ts";

const password = "Sign-in methods password 234!";
async function createPerson(page: Page, email: string) {
  expect(
    (
      await page.request.post("/api/auth/admin/create-user", {
        headers: { Origin: new URL(page.url()).origin },
        data: { email, password, name: email.split("@")[0], role: "user" },
      })
    ).ok(),
  ).toBe(true);
}
// The fake GitHub authorizes at once and returns to Kanvil with a code naming `id`.
async function answerGitHub(context: BrowserContext, id: string, email: string) {
  await context.route("https://github.com/login/oauth/authorize**", async (route) => {
    const request = new URL(route.request().url()),
      callback = new URL(request.searchParams.get("redirect_uri") ?? "");
    callback.search = new URLSearchParams({
      code: fakeOAuthCode({ id, email, verified: true }),
      state: request.searchParams.get("state") ?? "",
    }).toString();
    await route.fulfill({ status: 302, headers: { Location: callback.href } });
  });
}
// Switches the system appearance and waits for the page to follow it.
async function scheme(guest: Page, value: "light" | "dark") {
  await guest.emulateMedia({ colorScheme: value });
  await expect(guest.locator("html")).toHaveCSS("color-scheme", value);
}
async function openLogin(guest: Page) {
  await guest.goto("/login");
  await expect(guest.getByRole("heading", { name: "Sign in", exact: true })).toBeVisible();
}
async function signedOut(page: Page, run: (guest: Page, context: BrowserContext) => Promise<void>) {
  const context = await page
    .context()
    .browser()
    ?.newContext({ baseURL: new URL(page.url()).origin });
  if (!context) throw new Error("Expected a browser");
  try {
    await run(await context.newPage(), context);
  } finally {
    await context.close();
  }
}

test("lists configured providers and signs in with an emailed code or its link", async ({
  page,
}) => {
  await signIn(page);
  const email = "coder@sign-in.test";
  await createPerson(page, email);
  await signedOut(page, async (guest) => {
    await guest.emulateMedia({ reducedMotion: "reduce" });
    await openLogin(guest);
    await expect(guest.getByRole("button", { name: "Sign in with GitHub" })).toBeVisible();
    await expect(guest.getByRole("button", { name: "Sign in with Google" })).toBeVisible();
    await expect(guest.getByRole("button", { name: /Discord/ })).toHaveCount(0);
    for (const appearance of ["light", "dark"] as const) {
      await scheme(guest, appearance);
      for (const [width, height, name] of [
        [1440, 1000, "desktop"],
        [390, 844, "mobile"],
      ] as const) {
        await guest.setViewportSize({ width, height });
        await guest.screenshot({ path: `test-results/sign-in-${appearance}-${name}.png` });
      }
    }
    await useEmailLogin(guest);
    for (const appearance of ["light", "dark"] as const) {
      await scheme(guest, appearance);
      await guest.setViewportSize({ width: 390, height: 844 });
      await guest.screenshot({ path: `test-results/sign-in-email-${appearance}-mobile.png` });
      await guest.setViewportSize({ width: 1440, height: 1000 });
      await guest.screenshot({ path: `test-results/sign-in-email-${appearance}-desktop.png` });
    }
    await guest.getByLabel("Email", { exact: true }).fill(email);
    await guest.getByRole("button", { name: "Email me a sign-in code", exact: true }).click();
    await expect(
      guest.getByRole("heading", { name: "Sign in with a code", exact: true }),
    ).toBeVisible();
    await expect(guest.getByLabel("Email", { exact: true })).toHaveValue(email);
    const sent = mailTo(email).length;
    await guest.getByRole("button", { name: "Email me a code", exact: true }).click();
    await expect(
      guest.getByText(`If ${email} has an account, a code is on its way.`),
    ).toBeVisible();
    const { code } = await codeFor(email, sent);
    await expect(guest.getByLabel("Code", { exact: true })).toBeFocused();
    await guest.getByLabel("Code", { exact: true }).fill(code === "000000" ? "111111" : "000000");
    await guest.getByRole("button", { name: "Sign in", exact: true }).click();
    await expect(guest.getByRole("alert")).toContainText("That code is wrong, used, or expired.");
    for (const appearance of ["light", "dark"] as const) {
      await scheme(guest, appearance);
      await guest.screenshot({ path: `test-results/sign-in-code-${appearance}-desktop.png` });
      await guest.setViewportSize({ width: 390, height: 844 });
      await guest.screenshot({ path: `test-results/sign-in-code-${appearance}-mobile.png` });
      await guest.setViewportSize({ width: 1440, height: 1000 });
    }
    await guest.getByLabel("Code", { exact: true }).fill(code);
    await guest.getByRole("button", { name: "Sign in", exact: true }).click();
    await expect(guest.getByRole("heading", { name: "Projects", exact: true })).toBeVisible();
  });
  await signedOut(page, async (guest) => {
    await openLogin(guest);
    await useEmailLogin(guest);
    await guest.getByLabel("Email", { exact: true }).fill(email);
    await guest.getByRole("button", { name: "Email me a sign-in code", exact: true }).click();
    const sent = mailTo(email).length;
    await guest.getByRole("button", { name: "Email me a code", exact: true }).click();
    const { link } = await codeFor(email, sent);
    await guest.goto(link);
    await expect(guest.getByLabel("Code", { exact: true })).not.toHaveValue("");
    await guest.getByRole("button", { name: "Sign in", exact: true }).click();
    await expect(guest.getByRole("heading", { name: "Projects", exact: true })).toBeVisible();
  });
});

test("resets a forgotten password with an emailed code", async ({ page }) => {
  await signIn(page);
  const email = "forgetful@sign-in.test",
    next = "Sign-in methods new password 567!";
  await createPerson(page, email);
  await signedOut(page, async (guest) => {
    await openLogin(guest);
    await useEmailLogin(guest);
    await guest.getByRole("button", { name: "Forgot password?", exact: true }).click();
    await expect(guest.getByRole("heading", { name: "Reset password", exact: true })).toBeVisible();
    await guest.getByLabel("Email", { exact: true }).fill(email);
    const sent = mailTo(email).length;
    await guest.getByRole("button", { name: "Email me a code", exact: true }).click();
    const { code } = await codeFor(email, sent);
    expect(mailTo(email)[sent]).toContain("Subject: Reset your Kanvil password");
    await guest.getByLabel("Code", { exact: true }).fill(code);
    await guest.getByLabel("New password", { exact: true }).fill(next);
    await guest.getByRole("button", { name: "Reset password", exact: true }).click();
    await expect(guest.getByText("Password reset. Sign in with the new password.")).toBeVisible();
    await expect(guest.getByRole("heading", { name: "Sign in", exact: true })).toBeVisible();
    await guest.getByLabel("Password", { exact: true }).fill(next);
    await guest.getByRole("button", { name: "Sign in", exact: true }).click();
    await expect(guest.getByRole("heading", { name: "Projects", exact: true })).toBeVisible();
  });
});

test("a password reset from an invitation link returns to the invitation", async ({ page }) => {
  await signIn(page);
  const email = "invited-reset@sign-in.test",
    next = "Sign-in methods invited password 567!";
  await createPerson(page, email);
  const workspace = await (
    await page.request.post("/api/v1/workspaces", {
      data: { name: "Reset invitations", slug: "reset-invitations" },
    })
  ).json();
  const { url } = await (
    await page.request.post(`/api/v1/workspaces/${workspace.id}/invitations`, {
      data: { email, role: "reader" },
    })
  ).json();
  await signedOut(page, async (guest) => {
    await guest.goto(url);
    await useEmailLogin(guest);
    await guest.getByRole("button", { name: "Forgot password?", exact: true }).click();
    await guest.getByLabel("Email", { exact: true }).fill(email);
    const sent = mailTo(email).length;
    await guest.getByRole("button", { name: "Email me a code", exact: true }).click();
    await guest.getByLabel("Code", { exact: true }).fill((await codeFor(email, sent)).code);
    await guest.getByLabel("New password", { exact: true }).fill(next);
    await guest.getByRole("button", { name: "Reset password", exact: true }).click();
    await expect(guest.getByText("Password reset. Sign in with the new password.")).toBeVisible();
    expect(new URL(guest.url()).pathname).toBe(new URL(url).pathname);
    await guest.getByLabel("Password", { exact: true }).fill(next);
    await guest.getByRole("button", { name: "Sign in", exact: true }).click();
    await expect(
      guest.getByRole("heading", { name: "Join Reset invitations", exact: true }),
    ).toBeVisible();
  });
});

test("links GitHub in settings, signs in with it, and refuses an unlinked identity", async ({
  page,
}) => {
  await signIn(page);
  await answerGitHub(page.context(), "4242", "octo@elsewhere.test");
  await page.goto("/settings?section=account");
  await expect(page.getByRole("button", { name: "Link Google", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Link GitHub", exact: true }).click();
  await page.waitForURL("**/settings?section=account");
  await expect(page.getByText("Linked", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Link GitHub", exact: true })).toHaveCount(0);
  await page.getByText("Linked", { exact: true }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: "test-results/sign-in-settings-desktop.png" });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByText("Linked", { exact: true }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: "test-results/sign-in-settings-mobile.png" });
  await signedOut(page, async (guest, context) => {
    await answerGitHub(context, "4242", "octo@elsewhere.test");
    await openLogin(guest);
    await guest.getByRole("button", { name: "Sign in with GitHub", exact: true }).click();
    await expect(guest.getByRole("heading", { name: "Projects", exact: true })).toBeVisible();
    const session = await (await guest.request.get("/api/auth/get-session")).json();
    expect(session.user.email).toBe(ownerEmail);
  });
  await signedOut(page, async (guest, context) => {
    await answerGitHub(context, "4343", "stranger@elsewhere.test");
    await openLogin(guest);
    await guest.getByRole("button", { name: "Sign in with GitHub", exact: true }).click();
    await expect(guest.getByRole("alert")).toContainText(
      "This identity is not linked to a Kanvil account.",
    );
  });
});
