import { expect, test } from "@playwright/test";
import { signIn } from "./auth.ts";
import { choose } from "./controls.ts";
import { builtInThemes } from "../apps/web/src/lib/themes.ts";

test("Linear is the default and every named theme applies in both appearances", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
  await signIn(page);
  await expect(page.locator("html")).toHaveAttribute("data-theme", "linear");
  await expect
    .poll(() => page.evaluate(() => document.documentElement.style.colorScheme))
    .toBe("dark");
  await page.goto("/settings?section=appearance");
  for (const mode of ["light", "dark"] as const) {
    await page
      .getByRole("radio", { name: mode === "light" ? "Light" : "Dark", exact: true })
      .check();
    for (const theme of builtInThemes) {
      await page.getByRole("radio", { name: theme.name, exact: true }).check();
      await expect(page.locator("html")).toHaveAttribute("data-theme", theme.id);
      await expect
        .poll(() =>
          page.evaluate(() => document.documentElement.style.getPropertyValue("--background")),
        )
        .toBe(theme[mode].background);
      await expect(page.locator('meta[name="theme-color"]')).toHaveAttribute(
        "content",
        theme[mode].background,
      );
    }
  }
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-theme", builtInThemes.at(-1)!.id);
  await page.getByLabel("Search themes", { exact: true }).fill("catppuccin frappe");
  await expect(
    page.getByRole("radiogroup", { name: "Color theme", exact: true }).getByRole("radio"),
  ).toHaveCount(1);
  await page.getByRole("radio", { name: "Catppuccin Frappé", exact: true }).check();
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 844 });
    await expect(page.getByRole("radio", { name: "Catppuccin Frappé", exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(
      false,
    );
  }
  await page.getByLabel("Search themes", { exact: true }).fill("unavailable palette");
  await expect(page.getByRole("status").filter({ hasText: "No matching themes" })).toBeVisible();
  expect(errors).toEqual([]);
});

test("compact list spacing remains readable and comfortable spacing persists", async ({ page }) => {
  await signIn(page);
  const project = await (
    await page.request.post("/api/v1/projects", { data: { key: "DENSITY", name: "Row density" } })
  ).json();
  const title = "A compact row with a complete title";
  expect(
    (
      await page.request.post(`/api/v1/projects/${project.id}/tickets`, {
        data: { title, labels: ["design"] },
      })
    ).ok(),
  ).toBe(true);
  await page.goto(`/projects/${project.id}`);
  const table = page.getByRole("table", { name: "Tickets" }),
    row = table.getByRole("row").filter({ hasText: title });
  await expect(table).toHaveAttribute("data-density", "compact");
  await expect(page.getByRole("button", { name: "Resize title column", exact: true })).toBeHidden();
  await expect(row).toBeVisible();
  const compact = (await row.boundingBox())!.height;
  expect(compact).toBeLessThanOrEqual(48);
  await page.getByRole("button", { name: "Display", exact: true }).click();
  await choose(page, "Row spacing", "Comfortable");
  await page.getByRole("button", { name: "Display", exact: true }).click();
  expect((await row.boundingBox())!.height).toBeGreaterThanOrEqual(compact + 12);
  await page.reload();
  await expect(table).toHaveAttribute("data-density", "comfortable");
  await page.getByRole("button", { name: "Display", exact: true }).click();
  await page.getByRole("button", { name: "Reset display", exact: true }).click();
  await expect(table).toHaveAttribute("data-density", "compact");
  await page.getByRole("button", { name: "Display", exact: true }).click();
  await expect(row.getByRole("link", { name: title, exact: true })).toBeVisible();
});
