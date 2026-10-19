import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { z } from "zod";
export const ownerEmail = "owner@example.test";
export const ownerPassword = "test-only-owner-password-234";
const setupSchema = z.object({ setupRequired: z.boolean() });
// Signs the owner in and lands on Projects. A fresh test server's first case creates the owner
// through the login page. After that, a case whose purpose is not signing in gets its own session
// from the sign-in API; cases about signing in pass `form` to use the login page.
export async function signIn(page: Page, { form = false } = {}) {
  const { setupRequired } = setupSchema.parse(
    await (await page.request.get("/api/v1/info")).json(),
  );
  if (!setupRequired && !form) {
    const response = await page.request.post("/api/auth/sign-in/email", {
      data: { email: ownerEmail, password: ownerPassword },
      headers: { Origin: new URL(test.info().project.use.baseURL ?? "").origin },
    });
    expect(response.ok()).toBe(true);
    await page.goto("/");
  } else {
    await page.goto("/login");
    await expect(
      page.getByRole("heading", {
        name: setupRequired ? "Create your owner account" : "Sign in",
        exact: true,
      }),
    ).toBeVisible();
    if (setupRequired) {
      await page.getByLabel("Name", { exact: true }).fill("Test Owner");
      await page
        .getByLabel("Setup token", { exact: true })
        .fill("kanvil-browser-tests-only-setup-token");
    } else await useEmailLogin(page);
    await page.getByLabel("Email", { exact: true }).fill(ownerEmail);
    await page.getByLabel("Password", { exact: true }).fill(ownerPassword);
    await page
      .getByRole("button", { name: setupRequired ? "Create account" : "Sign in", exact: true })
      .click();
  }
  await expect(page.getByRole("heading", { name: "Projects", exact: true })).toBeVisible();
}
// Opens the password form, which configured sign-in providers fold behind a button.
export async function useEmailLogin(page: Page) {
  const choice = page.getByRole("button", { name: "Use email and password", exact: true });
  await expect(choice.or(page.getByLabel("Email", { exact: true }))).toBeVisible();
  if (await choice.isVisible()) await choice.click();
}

// Mail the test server's SMTP fake received for an address, oldest first.
export function mailTo(email: string) {
  const file = join(tmpdir(), `kanvil-e2e-${process.env.KANVIL_TEST_PORT ?? "5190"}.mail`);
  return readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => z.string().parse(JSON.parse(line)))
    .filter((message) => message.includes(`To: ${email}`));
}
// Waits for the email code at `index` among an address's mail and returns it with its link.
export async function codeFor(email: string, index: number) {
  await expect.poll(() => mailTo(email).length).toBeGreaterThan(index);
  const message = mailTo(email)[index] ?? "";
  return {
    code: /code is (\d{6})\./.exec(message)?.[1] ?? "",
    link: /(https?:\/\/\S+\?\S*code=\S+)/.exec(message)?.[1] ?? "",
  };
}
