import { test, expect } from "@playwright/test";
import { signIn } from "./auth.ts";

test("link callback errors survive reload, hide provider details, and clear on retry", async ({
  page,
}) => {
  await signIn(page);
  await page.goto(
    "/settings?section=account&error=access_denied&error_description=secret-provider-detail",
  );
  await expect(page.getByRole("alert")).toContainText(
    "Sign-in was cancelled. Try again when you are ready.",
  );
  await expect(page.getByText("secret-provider-detail")).toHaveCount(0);
  await page.reload();
  await expect(page.getByRole("alert")).toContainText("Sign-in was cancelled.");
  await page.getByRole("button", { name: "Change password", exact: true }).click();
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(page.getByRole("alert")).toHaveCount(0);
});

test("login callback errors show safe recovery feedback", async ({ page }) => {
  await page.goto("/login?error=signup_disabled&error_description=secret-provider-detail");
  await expect(page.getByRole("alert")).toContainText(
    "This identity is not linked to a Kanvil account. Sign in with your local account and link it in Settings.",
  );
  await expect(page.getByText("secret-provider-detail")).toHaveCount(0);
});
