import { test, expect } from "@playwright/test";
import { signIn } from "./auth.ts";
import { appearance } from "./controls.ts";

test("administrators save independent authentication options and cannot lock themselves out", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await signIn(page);
  await page.goto("/admin?section=authentication");
  await expect(page.getByRole("heading", { name: "Authentication", exact: true })).toBeVisible();
  for (const mode of ["Light", "Dark"]) {
    await page.setViewportSize({ width: 1440, height: 1000 });
    await appearance(page, mode);
    await expect(page.getByRole("heading", { name: "Authentication", exact: true })).toBeVisible();
    await page.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        ),
    );
    await page.screenshot({
      path: `test-results/authentication-${mode.toLowerCase()}-desktop.png`,
      fullPage: true,
      animations: "disabled",
    });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({
      path: `test-results/authentication-${mode.toLowerCase()}-mobile.png`,
      fullPage: true,
      animations: "disabled",
    });
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
  const password = page.getByRole("switch", { name: "Email and password sign-in", exact: true });
  const provisioning = page.getByRole("switch", {
    name: "Automatically create users from SSO",
    exact: true,
  });
  const providerLabel = page.getByText("OIDC discovery URL", { exact: true });
  if (await providerLabel.isVisible()) {
    const footer = await page
      .getByRole("button", { name: "Save authentication", exact: true })
      .locator("..")
      .boundingBox();
    const label = await providerLabel.boundingBox();
    expect(footer && label && label.y >= footer.y + footer.height).toBe(true);
  }
  await expect(password).toBeChecked();
  await expect(provisioning).not.toBeChecked();
  await provisioning.check();
  await page.getByRole("button", { name: "Save authentication", exact: true }).click();
  await expect(page.getByText("Authentication saved", { exact: true })).toBeVisible();
  await page.reload();
  await expect(provisioning).toBeChecked();
  await password.uncheck();
  await page.getByRole("button", { name: "Save authentication", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText(
    /Configure an OIDC provider|Link your OIDC account/,
  );
  await page.reload();
  await expect(password).toBeChecked();
  await expect(provisioning).toBeChecked();
  await provisioning.uncheck();
  await page.getByRole("button", { name: "Save authentication", exact: true }).click();
  await expect(page.getByText("Authentication saved", { exact: true })).toBeVisible();
});
