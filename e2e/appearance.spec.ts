import { test, expect } from "@playwright/test";
import { palettes } from "../packages/contracts/src/theme.ts";
import { signIn } from "./auth.ts";

test("themes and responsive ticket rows preserve complete titles and actions", async ({ page }) => {
  await signIn(page);
  const project = await (
    await page.request.post("/api/v1/projects", {
      data: { key: "LOOK", name: "Agent coordination", description: "Ownership and recovery" },
    })
  ).json();
  const titles = [
    "Preserve complete ticket titles when agents provide detailed implementation context and acceptance requirements",
    "Reconnect the realtime consumer from its last durable checkpoint after a server restart",
    "Require exclusive ownership before agents attach execution evidence",
    "AnUnbrokenTitle".repeat(30),
  ] as const;
  for (const [index, title] of titles.entries()) {
    const response = await page.request.post(`/api/v1/projects/${project.id}/tickets`, {
      data: {
        title: index === 0 ? title.replace("complete ticket", "complete\nticket") : title,
        status: ["todo", "in_progress", "in_review", "backlog"][index],
        difficulty: "med",
        description: "## Context\nKeep the complete requirements readable.",
        acceptanceCriteria: "- [ ] Titles wrap\n- [ ] Changes appear live",
      },
    });
    expect(response.ok()).toBe(true);
  }
  const search = await (
    await page.request.get(`/api/v1/projects/${project.id}/tickets`, {
      params: { q: "complete ticket titles" },
    })
  ).json();
  expect(search.items).toHaveLength(1);
  expect(search.items[0].title).toBe(titles[0]);
  await page.goto(`/projects/${project.id}`);
  for (const mode of ["light", "dark"] as const) {
    await page.getByLabel("Theme", { exact: true }).selectOption(mode);
    await expect
      .poll(() => page.evaluate(() => document.documentElement.style.colorScheme))
      .toBe(mode);
    await expect
      .poll(() =>
        page.evaluate(() =>
          getComputedStyle(document.documentElement).getPropertyValue("--accent"),
        ),
      )
      .toBe(palettes[mode].accent);
    for (const width of [1440, 1024, 650, 390, 320]) {
      await page.setViewportSize({ width, height: 900 });
      await expect(page.getByRole("table", { name: "Tickets", exact: true })).toBeVisible();
      for (const title of titles) {
        const link = page.getByRole("link", { name: title, exact: true });
        await expect(link).toBeVisible();
        const layout = await link.evaluate((element) => {
          const rect = element.getBoundingClientRect();
          return {
            left: rect.left,
            right: rect.right,
            overflow: element.scrollWidth > element.clientWidth,
          };
        });
        expect(layout.left).toBeGreaterThanOrEqual(0);
        expect(layout.right).toBeLessThanOrEqual(width);
        expect(layout.overflow).toBe(false);
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(
        false,
      );
      if (width <= 650)
        expect(
          await page
            .locator(".table-scroll")
            .evaluate((element) => element.scrollWidth > element.clientWidth),
        ).toBe(false);
      if ([1440, 390].includes(width))
        await page.screenshot({
          path: `test-results/${mode}-tickets-${width}.png`,
          fullPage: true,
          animations: "disabled",
        });
    }
    await page.reload();
    await expect(page.getByLabel("Theme", { exact: true })).toHaveValue(mode);
  }
  await page.getByRole("checkbox", { name: "Select LOOK-1", exact: true }).check();
  await expect(page.getByText("1 selected", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Clear selection", exact: true }).click();
  await page.getByRole("button", { name: "Filters", exact: true }).click();
  await page.getByLabel("Status", { exact: true }).selectOption("todo");
  await expect(page.getByRole("row")).toHaveCount(2);
  await page.getByRole("button", { name: "Filters (1)", exact: true }).click();
  await expect(page.getByLabel("Status", { exact: true })).toBeHidden();
  await page.getByRole("button", { name: "Filters (1)", exact: true }).click();
  await page.getByLabel("Status", { exact: true }).selectOption("");
  await expect(page.getByRole("row")).toHaveCount(5);
  await page.getByLabel("Theme", { exact: true }).selectOption("system");
  for (const colorScheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme, reducedMotion: "reduce" });
    await expect
      .poll(() => page.evaluate(() => document.documentElement.style.colorScheme))
      .toBe(colorScheme);
  }
  await page.getByRole("link", { name: titles[0], exact: true }).click();
  await expect(page.getByRole("heading", { name: titles[0], exact: true })).toBeVisible();
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 900 });
    await page.screenshot({
      path: `test-results/dark-ticket-${width}.png`,
      fullPage: true,
      animations: "disabled",
    });
  }
  const keyboardPage = await page.context().newPage();
  await keyboardPage.goto("/");
  await expect(keyboardPage.getByRole("heading", { name: "Projects", exact: true })).toBeVisible();
  await keyboardPage.keyboard.press("Tab");
  await expect(keyboardPage.getByRole("link", { name: "Skip to content" })).toBeFocused();
  await keyboardPage.keyboard.press("Enter");
  await expect(keyboardPage.locator("#main")).toBeFocused();
  await keyboardPage.close();
});
