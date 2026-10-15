import { test, expect } from "@playwright/test";
import { choose, appearance } from "./controls.ts";
import { signIn } from "./auth.ts";

test("themes and responsive ticket rows preserve complete titles and actions", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
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
    await appearance(page, mode === "light" ? "Light" : "Dark");
    await expect
      .poll(() => page.evaluate(() => document.documentElement.style.colorScheme))
      .toBe(mode);
    await expect(page.locator("html")).toHaveClass(mode === "dark" ? /dark/ : /^$/);
    for (const width of [1440, 1024, 650, 390, 320]) {
      await page.setViewportSize({ width, height: 900 });
      await expect(page.getByRole("table", { name: "Tickets", exact: true })).toHaveCSS(
        "display",
        width <= 1150 ? "block" : "table",
      );
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
    await expect
      .poll(() => page.evaluate(() => document.documentElement.style.colorScheme))
      .toBe(mode);
  }
  await page.getByRole("checkbox", { name: "Select LOOK-1", exact: true }).check();
  await expect(page.getByText("1 selected", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Clear selection", exact: true }).click();
  await page.getByRole("button", { name: "Filters", exact: true }).click();
  await choose(page, "Status", "To do");
  await expect(page.getByRole("row")).toHaveCount(2);
  await page.getByRole("button", { name: "Filters (1)", exact: true }).click();
  await expect(page.getByLabel("Status", { exact: true })).toBeHidden();
  await page.getByRole("button", { name: "Filters (1)", exact: true }).click();
  await choose(page, "Status", "All statuses");
  await expect(page.getByRole("row")).toHaveCount(5);
  await page.getByRole("button", { name: "Filters", exact: true }).click();
  await appearance(page, "System");
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

test("inset sidebar, project search, icon actions, and color themes work across layouts", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await signIn(page);
  const created = await page.request.post("/api/v1/projects", {
    data: { key: "NAV", name: "Navigation project" },
  });
  expect(created.ok()).toBe(true);
  const sidebar = page.locator('[data-slot="sidebar"][data-variant="inset"]');
  await expect(sidebar).toHaveAttribute("data-state", "expanded");
  const brand = page.locator("a.brand");
  await expect(brand).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
  await expect(page.getByText("Live", { exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Toggle Sidebar", exact: true }).last().click();
  await expect(sidebar).toHaveAttribute("data-state", "collapsed");
  await page.reload();
  await expect(sidebar).toHaveAttribute("data-state", "collapsed");
  await page.keyboard.press("ControlOrMeta+b");
  await expect(sidebar).toHaveAttribute("data-state", "expanded");
  await page.keyboard.press("ControlOrMeta+k");
  await page.getByRole("combobox").fill("Navigation project");
  await page.getByRole("option", { name: /Navigation project/ }).click();
  await expect(
    page.getByRole("heading", { name: "Navigation project", exact: true }),
  ).toBeVisible();
  const settings = page.getByRole("link", { name: "Project settings", exact: true });
  await expect(settings).toHaveText("");
  await settings.hover();
  await expect(page.locator('[data-slot="tooltip-content"]')).toBeVisible();
  await settings.click();
  await expect(
    page.getByRole("heading", { name: "Navigation project settings", exact: true }),
  ).toBeVisible();
  await page.getByRole("tab", { name: "Members", exact: true }).click();
  await expect(page.getByLabel("Existing account email", { exact: true })).toBeVisible();
  for (const theme of ["Graphite", "Forest", "Ember", "Kanvil"]) {
    await appearance(page, theme);
    await expect(page.locator("html")).toHaveAttribute("data-theme", theme.toLowerCase());
  }
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "kanvil");
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: "Toggle Sidebar", exact: true }).click();
  const sheet = page.getByRole("dialog", { name: "Sidebar", exact: true });
  await expect(sheet).toBeVisible();
  await sheet.getByRole("link", { name: "Inbox", exact: true }).click();
  await expect(sheet).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Inbox", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Toggle Sidebar", exact: true }).click();
  await sheet.getByRole("button", { name: /Test Owner/ }).click();
  await page.getByRole("menuitem", { name: "Account settings", exact: true }).click();
  await expect(sheet).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Settings", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Toggle Sidebar", exact: true }).click();
  await sheet.getByRole("button", { name: "New project", exact: true }).click();
  const create = page.getByRole("dialog", { name: "New project", exact: true });
  await create.getByLabel("Project name", { exact: true }).fill("Mobile project");
  await create.getByLabel("Permanent ticket prefix", { exact: true }).fill("MOB");
  await create.getByRole("button", { name: "Create project", exact: true }).click();
  await expect(sheet).toHaveCount(0);
  await expect(create).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Mobile project", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Appearance", exact: true }).click();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("button", { name: "Appearance", exact: true })).toBeFocused();
});
