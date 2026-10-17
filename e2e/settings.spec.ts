import { expect, test } from "@playwright/test";
import { signIn } from "./auth.ts";
import { choose } from "./controls.ts";
import { builtInThemes, encodeThemeFile } from "../apps/web/src/lib/themes.ts";

test("profile avatar opens photo selection and supports replacement, errors, and retry", async ({
  page,
}) => {
  await signIn(page);
  await page.goto("/settings?section=account");
  await expect(page.getByRole("heading", { name: "Profile", exact: true })).toBeVisible();
  for (const mode of ["Light", "Dark"]) {
    await page.goto("/settings?section=appearance");
    await page.getByRole("radio", { name: mode, exact: true }).check();
    await page.goto("/settings?section=account");
    await expect(page.getByRole("heading", { name: "Profile", exact: true })).toBeVisible();
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 900 });
      await page.screenshot({
        path: `test-results/profile-${mode}-${width}.png`,
        fullPage: true,
        animations: "disabled",
      });
      expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(
        false,
      );
    }
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  const change = page.getByRole("button", { name: "Change photo", exact: true });
  await expect(change).toHaveCount(1);
  await expect(change.locator('[data-slot="avatar"]')).toBeVisible();
  await change.hover();
  await expect(change.locator("span[aria-hidden]").last()).toHaveCSS("opacity", "1");
  const images = page.locator('img[src^="/api/v1/users/"]');
  const input = page.getByLabel("Profile photo file", { exact: true });
  const file = "apps/web/public/brand/icon-192.png";
  const chooser = page.waitForEvent("filechooser");
  await change.click();
  await (await chooser).setFiles([]);
  await expect(images).toHaveCount(0);
  await expect(change).toBeEnabled();
  for (const key of ["Enter", "Space"]) {
    await change.focus();
    await expect(change).toBeFocused();
    const selection = page.waitForEvent("filechooser");
    await change.press(key);
    const updated = page.waitForResponse(
      (response) =>
        response.url().endsWith("/api/v1/profile/photo") && response.request().method() === "POST",
    );
    await (await selection).setFiles(file);
    expect((await updated).ok()).toBe(true);
    await expect(page.getByText("Photo updated", { exact: true })).toBeVisible();
    await expect(images).toHaveCount(2);
  }
  const previous = await images.first().getAttribute("src");
  for (const invalid of [
    { name: "invalid.txt", mimeType: "text/plain", buffer: Buffer.from("not an image") },
    { name: "broken.png", mimeType: "image/png", buffer: Buffer.from("not an image") },
    { name: "large.png", mimeType: "image/png", buffer: Buffer.alloc(10000001) },
  ]) {
    await input.setInputFiles(invalid);
    await expect(page.getByRole("alert")).toBeVisible();
    await expect(images.first()).toHaveAttribute("src", previous!);
    await expect(change).toBeEnabled();
  }
  await page.route("**/api/v1/profile/photo", (route) =>
    route.fulfill({
      status: 500,
      contentType: "application/json",
      body: JSON.stringify({ error: { code: "internal_error", message: "Photo upload failed" } }),
    }),
  );
  await input.setInputFiles(file);
  await expect(page.getByRole("alert")).toBeVisible();
  await expect(images.first()).toHaveAttribute("src", previous!);
  await expect(change).toBeEnabled();
  await page.unroute("**/api/v1/profile/photo");
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let writes = 0;
  await page.route("**/api/v1/profile/photo", async (route) => {
    writes++;
    await held;
    await route.continue();
  });
  await input.setInputFiles(file);
  await expect(change).toBeDisabled();
  await expect(page.getByRole("button", { name: "Remove photo", exact: true })).toBeDisabled();
  release();
  await expect(change).toBeEnabled();
  await expect(page.getByRole("alert")).toHaveCount(0);
  expect(writes).toBe(1);
  await page.unroute("**/api/v1/profile/photo");
  await page.getByRole("button", { name: "Remove photo", exact: true }).click();
  await expect(page.getByText("Photo removed", { exact: true })).toBeVisible();
  await expect(images).toHaveCount(0);
  await expect(change.locator('[data-slot="avatar-fallback"]')).toBeVisible();
});

test("settings support custom palettes, profile photos, calendar expiry, and instance administration", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await signIn(page);
  const project = await (
    await page.request.post("/api/v1/projects", {
      data: { key: "PREF", name: "Preferences fixture" },
    })
  ).json();
  await page.goto("/settings?section=appearance");
  await expect(page.getByRole("radio", { name: "Tokyo Night", exact: true })).toBeVisible();
  await expect(
    page.getByRole("radiogroup", { name: "Color theme", exact: true }).getByRole("radio"),
  ).toHaveCount(builtInThemes.length);
  await page.getByRole("radio", { name: "Dark", exact: true }).check();
  await page.getByRole("radio", { name: "Tokyo Night", exact: true }).check();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "tokyo-night");
  await page.getByRole("button", { name: "Create theme", exact: true }).click();
  await page.getByLabel("Theme name", { exact: true }).fill("My Tokyo Night");
  await page.getByRole("button", { name: "Save theme", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.getByRole("radio", { name: "My Tokyo Night", exact: true })).toBeChecked();
  await page.reload();
  await expect(page.getByRole("radio", { name: "My Tokyo Night", exact: true })).toBeChecked();
  await page.getByRole("button", { name: "Edit My Tokyo Night", exact: true }).click();
  await page.getByLabel("Dark text", { exact: true }).fill("#1a1b26");
  await page.getByRole("button", { name: "Save theme", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("contrast");
  await page.getByRole("button", { name: "Close", exact: true }).click();
  await page.getByLabel("Import theme file", { exact: true }).setInputFiles({
    name: "everforest.json",
    mimeType: "application/json",
    buffer: Buffer.from(
      encodeThemeFile([
        builtInThemes.find((theme) => theme.id === "everforest") ?? builtInThemes[0],
      ]),
    ),
  });
  await expect(
    page.getByRole("radiogroup", { name: "Color theme", exact: true }).getByRole("radio"),
  ).toHaveCount(builtInThemes.length + 2);
  await page.getByRole("radio", { name: "Everforest", exact: true }).last().check();
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export Everforest", exact: true }).click();
  expect((await download).suggestedFilename()).toContain("custom-everforest");
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: "test-results/settings-themes-dark.png", fullPage: true });
  await page.getByRole("radio", { name: "Light", exact: true }).check();
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: "test-results/settings-themes-light.png", fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: "test-results/settings-themes-mobile.png", fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(`/projects/${project.id}/settings`);
  await page.getByRole("tab", { name: "Members", exact: true }).click();
  await expect(page.locator(".member-row").filter({ hasText: "owner@example.test" })).toBeVisible();
  await page.goto("/settings?section=account");
  await page
    .getByLabel("Profile photo file", { exact: true })
    .setInputFiles("apps/web/public/brand/icon-192.png");
  await expect(page.getByText("Photo updated", { exact: true })).toBeVisible();
  await expect(page.locator('img[src^="/api/v1/users/"]')).toHaveCount(2);
  await page.goto(`/projects/${project.id}/settings`);
  await page.getByRole("tab", { name: "Members", exact: true }).click();
  const owner = page.locator(".member-row").filter({ hasText: "owner@example.test" });
  await expect(owner.locator('img[src^="/api/v1/users/"]')).toBeVisible();
  await page.goto("/settings?section=account");
  await page.reload();
  await expect(page.getByRole("button", { name: "Remove photo", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Remove photo", exact: true }).click();
  await expect(page.getByText("Photo removed", { exact: true })).toBeVisible();
  await expect(page.locator('img[src^="/api/v1/users/"]')).toHaveCount(0);
  await page.getByRole("tab", { name: "API keys", exact: true }).click();
  await page.getByRole("button", { name: "Create API key", exact: true }).click();
  await page.getByLabel("Key name", { exact: true }).fill("Calendar fixture");
  await page.getByRole("checkbox", { name: "Preferences fixture", exact: true }).check();
  await page.getByRole("button", { name: "Expires on", exact: true }).click();
  const calendar = page.locator('[data-slot="calendar"]');
  await expect(calendar).toBeVisible();
  const day = calendar
    .locator("button[data-day]:not([disabled])")
    .filter({ hasNot: page.locator('[aria-selected="true"]') })
    .nth(10);
  const selected = await day.getAttribute("data-day");
  await day.click();
  await page.getByRole("button", { name: "Create API key", exact: true }).click();
  await expect(page.getByLabel("New API key", { exact: true })).toHaveValue(/^kv_/);
  await page.getByRole("button", { name: "Done", exact: true }).click();
  const credentials = await (await page.request.get("/api/v1/credentials")).json(),
    credential = credentials.find((value: { name: string }) => value.name === "Calendar fixture");
  try {
    // Relative TTLs use whole seconds; compare the deadline rather than rounding a near-midnight response to a date.
    const deadlineError = await page.evaluate(
      ({ date, expiry }) => {
        const [month, calendarDay, year] = date!.split("/").map(Number);
        const end = new Date(year!, month! - 1, calendarDay, 23, 59, 59, 999);
        return Math.abs(new Date(expiry).getTime() - end.getTime());
      },
      { date: selected, expiry: credential.expiresAt },
    );
    expect(deadlineError).toBeLessThan(1000);
  } finally {
    expect((await page.request.delete(`/api/v1/credentials/${credential.id}`)).ok()).toBe(true);
  }
  await page.goto("/admin");
  await expect(page.getByRole("heading", { name: "Administration", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Edit instance", exact: true }).click();
  await page.getByLabel("Instance name", { exact: true }).fill("Fixture Kanvil");
  await page.getByRole("button", { name: "Save instance settings", exact: true }).click();
  await expect(page.getByText("Instance settings saved", { exact: true })).toBeVisible();
  await expect(page).toHaveTitle("Fixture Kanvil · Kanvil");
  await page.getByRole("tab", { name: "File storage", exact: true }).click();
  await page.getByRole("button", { name: "Configure storage", exact: true }).click();
  await choose(page, "Storage provider", "S3-compatible object storage");
  await expect(page.getByLabel("Bucket", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await page.getByRole("tab", { name: "Event delivery", exact: true }).click();
  await page.getByRole("button", { name: "Configure event delivery", exact: true }).click();
  await choose(page, "Event delivery provider", "RabbitMQ");
  await expect(page.getByLabel("RabbitMQ connection URL", { exact: true })).toHaveAttribute(
    "type",
    "password",
  );
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await page.getByRole("tab", { name: "Search", exact: true }).click();
  await page.getByRole("button", { name: "Configure search", exact: true }).click();
  await choose(page, "Search provider", "Elasticsearch-compatible search");
  await expect(page.getByLabel("Search endpoint", { exact: true })).toBeVisible();
  await choose(page, "Search authentication", "API key");
  await expect(page.getByLabel("Search API key", { exact: true })).toBeVisible();
  await choose(page, "Search authentication", "Username and password");
  await expect(page.getByLabel("Search password", { exact: true })).toBeVisible();
  await expect(page.getByLabel("Search API key", { exact: true })).toHaveCount(0);
  await page.reload();
  await page.getByRole("tab", { name: "General", exact: true }).click();
  await page.getByRole("button", { name: "Edit instance", exact: true }).click();
  await page.getByLabel("Instance name", { exact: true }).fill("Kanvil");
  await page.getByRole("button", { name: "Save instance settings", exact: true }).click();
  await expect(page.getByText("Instance settings saved", { exact: true })).toBeVisible();
  await page.getByRole("tab", { name: "Users", exact: true }).click();
  await expect(page.getByRole("row", { name: /owner@example.test/ })).toBeVisible();
  await page.getByRole("tab", { name: "Authentication", exact: true }).click();
  await expect(page.getByRole("group", { name: "MCP endpoint", exact: true })).toContainText(
    "http://localhost:5190/mcp",
  );
  expect(project.id).toBeTruthy();
  expect(errors).toEqual([]);
});
