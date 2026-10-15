import { expect, type Page } from "@playwright/test";
import { z } from "zod";
export const ownerEmail = "owner@example.test";
export const ownerPassword = "test-only-owner-password-234";
export async function signIn(page: Page) {
  const info = z
    .object({ setupRequired: z.boolean() })
    .parse(await (await page.request.get("/api/v1/info")).json());
  await page.goto("/login");
  await expect(
    page.getByRole("heading", {
      name: info.setupRequired ? "Create your owner account" : "Sign in",
      exact: true,
    }),
  ).toBeVisible();
  if (info.setupRequired) {
    await page.getByLabel("Name", { exact: true }).fill("Test Owner");
    await page.getByLabel("Setup token").fill("kanvil-browser-tests-only-setup-token");
  }
  await page.getByLabel("Email", { exact: true }).fill(ownerEmail);
  await page.getByLabel("Password", { exact: true }).fill(ownerPassword);
  await page
    .getByRole("button", { name: info.setupRequired ? "Create account" : "Sign in", exact: true })
    .click();
  await expect(page.getByRole("heading", { name: "Projects", exact: true })).toBeVisible();
}
