import { expect, test } from "@playwright/test";
import { signIn } from "./auth.ts";
import { choose } from "./controls.ts";
import { builtInThemes, encodeThemeFile } from "../apps/web/src/lib/themes.ts";

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
  await expect(page.getByRole("radio", { name: "Ocean", exact: true })).toBeVisible();
  await expect(
    page.getByRole("radiogroup", { name: "Color theme", exact: true }).getByRole("radio"),
  ).toHaveCount(10);
  await page.getByRole("radio", { name: "Dark", exact: true }).check();
  await page.getByRole("radio", { name: "Ocean", exact: true }).check();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "ocean");
  await page.getByRole("button", { name: "New theme", exact: true }).click();
  await page.getByLabel("Theme name", { exact: true }).fill("My ocean");
  await page.getByRole("button", { name: "Save theme", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.getByRole("radio", { name: "My ocean", exact: true })).toBeChecked();
  await page.reload();
  await expect(page.getByRole("radio", { name: "My ocean", exact: true })).toBeChecked();
  await page.getByRole("button", { name: "Edit My ocean", exact: true }).click();
  await page.getByLabel("Dark text", { exact: true }).fill("#0e1a27");
  await page.getByRole("button", { name: "Save theme", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("contrast");
  await page.getByRole("button", { name: "Close", exact: true }).click();
  await page.getByLabel("Import theme file", { exact: true }).setInputFiles({
    name: "forest.json",
    mimeType: "application/json",
    buffer: Buffer.from(
      encodeThemeFile([builtInThemes.find((theme) => theme.id === "forest") ?? builtInThemes[0]]),
    ),
  });
  await expect(
    page.getByRole("radiogroup", { name: "Color theme", exact: true }).getByRole("radio"),
  ).toHaveCount(12);
  await page.getByRole("radio", { name: "Forest", exact: true }).last().check();
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export", exact: true }).click();
  expect((await download).suggestedFilename()).toContain("custom-forest");
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
  await page.getByRole("tab", { name: "Profile & security", exact: true }).click();
  await page
    .getByLabel("Profile photo file", { exact: true })
    .setInputFiles("apps/web/public/brand/icon-192.png");
  await expect(page.getByText("Photo updated", { exact: true })).toBeVisible();
  await expect(page.locator('img[src^="/api/v1/users/"]')).toHaveCount(2);
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
  expect(new Date(credential.expiresAt).toLocaleDateString("en-US")).toBe(selected);
  expect((await page.request.delete(`/api/v1/credentials/${credential.id}`)).ok()).toBe(true);
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
