import { expect, test } from "@playwright/test";
import { signIn } from "./auth.ts";
import { choose } from "./controls.ts";
import { builtInThemes } from "../apps/web/src/lib/themes.ts";

test("Aligned is the default and every named theme applies in both appearances", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
  await signIn(page);
  await expect(page.locator("html")).toHaveAttribute("data-theme", "aligned");
  await page.evaluate(() => {
    localStorage.setItem("kanvil:color-theme", "linear");
    localStorage.setItem("kanvil:theme-halves:v1", '{"light":42}');
  });
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "aligned");
  expect(await page.evaluate(() => localStorage.getItem("kanvil:color-theme"))).toBe("aligned");
  await expect
    .poll(() => page.evaluate(() => document.documentElement.style.colorScheme))
    .toBe("dark");
  await page.goto("/settings?section=appearance");
  await expect(page.getByRole("radio", { name: "Aligned", exact: true })).toBeChecked();
  await expect(page.getByRole("radio", { name: "Linear", exact: true })).toHaveCount(0);
  await expect(page.locator(".theme-choice .lucide-check")).toHaveCount(0);
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

test("paired theme orbs persist independent appearances and safely remove a mixed custom theme", async ({
  page,
}) => {
  await page.emulateMedia({ colorScheme: "light", reducedMotion: "reduce" });
  await signIn(page);
  await page.goto("/settings?section=appearance");
  await page.getByRole("radio", { name: "System", exact: true }).check();
  await page.getByRole("button", { name: "Use GitHub light mode", exact: true }).focus();
  await page.keyboard.press("Enter");
  await page.getByRole("button", { name: "Use Dracula dark mode", exact: true }).focus();
  await page.keyboard.press("Space");
  await expect(page.getByRole("radio", { name: "System", exact: true })).toBeChecked();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "github");
  for (const name of ["Use GitHub light mode", "Use Dracula dark mode"])
    await expect(page.getByRole("button", { name, exact: true })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dracula");
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dracula");
  await page.getByRole("radio", { name: "Light", exact: true }).check();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "github");
  await page.getByRole("radio", { name: "Dark", exact: true }).check();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dracula");
  for (const width of [1440, 390, 320]) {
    await page.setViewportSize({ width, height: 1000 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(
      false,
    );
    await page.evaluate(() => scrollTo(0, 0));
    await page.screenshot({
      path: `test-results/theme-picker-paired-${width}.png`,
      animations: "disabled",
    });
  }
  const aligned = page.getByRole("radio", { name: "Aligned", exact: true });
  await aligned.check();
  for (const mode of ["light", "dark"])
    await expect(
      page.getByRole("button", { name: `Use Aligned ${mode} mode`, exact: true }),
    ).toHaveAttribute("aria-pressed", "true");
  await aligned.focus();
  await page.keyboard.press("ArrowRight");
  await expect(page.getByRole("radio", { name: "Catppuccin Mocha", exact: true })).toBeChecked();
  await page.getByRole("button", { name: "Duplicate Dracula", exact: true }).click();
  await page.getByRole("textbox", { name: "Theme name", exact: true }).fill("Mixed custom");
  await page.getByRole("button", { name: "Save theme", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.getByRole("radio", { name: "Aligned", exact: true }).check();
  await page.getByRole("button", { name: "Use Mixed custom dark mode", exact: true }).click();
  await page.getByRole("button", { name: "Use GitHub light mode", exact: true }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", /^custom-/);
  await page.getByRole("button", { name: "Delete Mixed custom", exact: true }).click();
  await page
    .getByRole("alertdialog")
    .getByRole("button", { name: "Delete Mixed custom", exact: true })
    .click();
  await expect(page.getByRole("alertdialog")).toHaveCount(0);
  await expect(page.locator("html")).toHaveAttribute("data-theme", "aligned");
  await expect(
    page.getByRole("button", { name: "Use GitHub light mode", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("radio", { name: "System", exact: true }).check();
  await page.reload();
  await page.emulateMedia({ colorScheme: "light", reducedMotion: "reduce" });
  await expect(page.locator("html")).toHaveAttribute("data-theme", "github");
  await expect(page.getByRole("radio", { name: "Mixed custom", exact: true })).toHaveCount(0);
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
