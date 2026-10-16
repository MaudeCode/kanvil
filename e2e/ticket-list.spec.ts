import { expect, test, type Locator } from "@playwright/test";
import { signIn } from "./auth.ts";
import { choose, chooseTicketView, openSaveView, ticketRows } from "./controls.ts";
import { priorities, priorityLabels } from "../packages/contracts/src/index.ts";

async function expectFullWidth(table: Locator) {
  expect(
    await table.evaluate((node) => {
      const content = node.closest<HTMLElement>(".content")!;
      const style = getComputedStyle(content);
      const available =
        content.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
      return Math.abs(node.getBoundingClientRect().width - available);
    }),
  ).toBeLessThan(1);
}

test("project settings manage reusable colored labels across live ticket views", async ({
  page,
}) => {
  await signIn(page);
  const project = await (
    await page.request.post("/api/v1/projects", {
      data: { key: "LABELSET", name: "Label settings" },
    })
  ).json();
  const ticket = await (
    await page.request.post(`/api/v1/projects/${project.id}/tickets`, {
      data: { title: "Ticket with managed labels", labels: ["bug", "keep"] },
    })
  ).json();
  const observer = await page.context().newPage();
  await observer.goto(`/projects/${project.id}/tickets/${ticket.id}`);
  await expect(
    observer.locator(".ticket-heading [data-label-color]").filter({ hasText: /^bug$/ }),
  ).toHaveAttribute("data-label-color", "gray");
  await page.goto(`/projects/${project.id}/settings?section=labels`);
  await expect(page.getByRole("heading", { name: "Labels", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Edit label bug", exact: true }).click();
  await page.getByRole("textbox", { name: "Label name", exact: true }).fill("Defect");
  await page.getByRole("button", { name: "red label color", exact: true }).click();
  await page.getByRole("button", { name: "Save label", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  const liveLabel = observer
    .locator(".ticket-heading [data-label-color]")
    .filter({ hasText: /^Defect$/ });
  await expect(liveLabel).toHaveAttribute("data-label-color", "red");
  await page.getByRole("button", { name: "Edit label Defect", exact: true }).click();
  await page.getByRole("button", { name: "orange label color", exact: true }).click();
  await page.getByRole("button", { name: "Save label", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(liveLabel).toHaveAttribute("data-label-color", "orange");
  await page.getByRole("button", { name: "New label", exact: true }).click();
  await page.getByRole("textbox", { name: "Label name", exact: true }).fill("release, ready");
  await page.getByRole("button", { name: "purple label color", exact: true }).click();
  await page.getByRole("button", { name: "Save label", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Edit label release, ready", exact: true }),
  ).toBeVisible();
  await page.getByRole("searchbox", { name: "Search labels", exact: true }).fill("release");
  await expect(page.getByRole("button", { name: "Edit label Defect", exact: true })).toHaveCount(0);
  await page.goto(`/projects/${project.id}`);
  const table = page.getByRole("table", { name: "Tickets" });
  await expect(
    table.locator('[data-label-color="orange"]').filter({ hasText: /^Defect$/ }),
  ).toBeVisible();
  await page.getByRole("button", { name: "New ticket", exact: true }).click();
  await page.getByRole("textbox", { name: "Title", exact: true }).fill("Ticket from managed label");
  await page.getByRole("button", { name: "Choose labels", exact: true }).click();
  await page.getByRole("option", { name: "release, ready", exact: true }).click();
  await expect(
    page
      .getByRole("dialog")
      .locator('[data-label-color="purple"]')
      .filter({ hasText: /release, ready/ }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Save ticket", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(
    table.locator('[data-label-color="purple"]').filter({ hasText: /^release, ready$/ }),
  ).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/projects/${project.id}/settings?section=labels`);
  await expect(
    page.getByRole("combobox", { name: "Project settings section", exact: true }),
  ).toContainText("Labels");
  const labelRow = page
    .locator('[data-slot="item"]')
    .filter({ has: page.getByRole("button", { name: "Edit label release, ready", exact: true }) });
  expect((await labelRow.boundingBox())!.height).toBeLessThanOrEqual(72);
  await page.getByRole("button", { name: "Edit label release, ready", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "purple label color", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await page.getByRole("button", { name: "Delete label Defect", exact: true }).click();
  await page
    .getByRole("alertdialog")
    .getByRole("button", { name: "Delete label Defect", exact: true })
    .click();
  await expect(page.getByRole("alertdialog")).toHaveCount(0);
  await expect(liveLabel).toHaveCount(0);
  const stored = await (
    await page.request.get(`/api/v1/projects/${project.id}/tickets/${ticket.id}`)
  ).json();
  expect(stored.ticket.labels).toEqual(["keep"]);
  await observer.close();
});

test("priority icons distinguish every level and keep names in pickers", async ({ page }) => {
  await signIn(page);
  const project = await (
    await page.request.post("/api/v1/projects", {
      data: { key: "PRIORITYUX", name: "Priority icons" },
    })
  ).json();
  for (const priority of priorities)
    expect(
      (
        await page.request.post(`/api/v1/projects/${project.id}/tickets`, {
          data: { title: `Priority ${priority}`, priority },
        })
      ).ok(),
    ).toBe(true);
  await page.goto(`/projects/${project.id}`);
  const table = page.getByRole("table", { name: "Tickets" });
  await expect(ticketRows(page)).toHaveCount(priorities.length);
  const glyphs = await table
    .locator('td[data-column="priority"] svg')
    .evaluateAll((icons) => icons.map((icon) => icon.innerHTML));
  expect(new Set(glyphs).size).toBe(priorities.length);
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 900 });
    for (const priority of priorities) {
      const cell = table
        .getByRole("row")
        .filter({ has: page.getByRole("link", { name: `Priority ${priority}`, exact: true }) })
        .locator('[data-column="priority"]');
      const name =
        priority === "none" ? priorityLabels[priority] : `${priorityLabels[priority]} priority`;
      await expect(cell.getByRole("img", { name, exact: true })).toBeVisible();
      await expect(cell.getByRole("img")).toHaveAttribute("title", name);
      await expect(cell).toHaveText("");
    }
  }
  await page.getByRole("button", { name: "Filters", exact: true }).click();
  await page.getByRole("combobox", { name: "Priority", exact: true }).click();
  for (const priority of priorities) {
    const option = page.getByRole("option", { name: priorityLabels[priority], exact: true });
    await expect(option).toBeVisible();
    await expect(option.locator(`svg`)).toHaveCount(1);
  }
  await page.getByRole("option", { name: "Urgent", exact: true }).click();
  await page.keyboard.press("Escape");
  await expect(ticketRows(page)).toHaveCount(1);
  await expect(table.getByRole("link", { name: "Priority urgent", exact: true })).toBeVisible();
});

test("list properties persist and labels filter and sort the entire project", async ({ page }) => {
  await signIn(page);
  const project = await (
    await page.request.post("/api/v1/projects", {
      data: { key: "LABELUX", name: "Ticket list preferences" },
    })
  ).json();
  for (let i = 1; i <= 51; i++) {
    const result = await page.request.post(`/api/v1/projects/${project.id}/tickets`, {
      data: {
        title: `Ticket ${String(i).padStart(2, "0")} with readable requirements`,
        labels: i === 51 ? ["rare, quoted 'label'"] : ["standard"],
        scopes: ["web"],
        difficulty: "med",
      },
    });
    expect(result.ok()).toBe(true);
  }
  await page.goto(`/projects/${project.id}`);
  const table = page.getByRole("table", { name: "Tickets" });
  for (const width of [1440, 1920, 2560]) {
    await page.setViewportSize({ width, height: 900 });
    await expect(ticketRows(page).first()).toBeVisible();
    await expectFullWidth(table);
    expect((await table.locator('th[data-column="key"]').boundingBox())!.width).toBeCloseTo(100, 0);
  }
  await expect(table.locator('td[data-column="labels"]').first()).toContainText("standard");
  await expect(table.getByText("rare, quoted 'label'", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Display", exact: true }).click();
  for (const property of ["Ticket", "Labels", "Status", "Priority", "Difficulty"])
    await page.getByRole("checkbox", { name: property, exact: true }).uncheck();
  await expect(table.locator("thead th")).toHaveCount(2);
  await expectFullWidth(table);
  await page.getByRole("button", { name: "Reset display", exact: true }).click();
  await page.getByRole("checkbox", { name: "Priority", exact: true }).uncheck();
  await page.getByRole("checkbox", { name: "Labels", exact: true }).uncheck();
  await page.getByRole("checkbox", { name: "Kind", exact: true }).check();
  await page.getByRole("checkbox", { name: "Scopes", exact: true }).check();
  await page.getByRole("checkbox", { name: "Assignee", exact: true }).check();
  await page.getByRole("checkbox", { name: "Created", exact: true }).check();
  await page.getByRole("checkbox", { name: "Updated", exact: true }).check();
  await page.reload();
  await expect(table.locator('[data-column="priority"]')).toHaveCount(0);
  await expect(table.locator('[data-column="labels"]')).toHaveCount(0);
  await expect(table.locator('td[data-column="kind"]').first()).toContainText("feature");
  await expect(table.locator('td[data-column="scopes"]').first()).toContainText("web");
  await expect(table.locator('td[data-column="assigneeId"]').first()).toContainText("Unassigned");
  await expect(table.locator('td[data-column="createdAt"]').first()).not.toBeEmpty();
  await expectFullWidth(table);
  await page.getByRole("button", { name: "Display", exact: true }).click();
  await page.getByRole("button", { name: "Reset display", exact: true }).click();
  await expect(page.getByRole("checkbox", { name: "Labels", exact: true })).toBeChecked();
  await choose(page, "Order by", "Labels A–Z");
  await page.getByRole("button", { name: "Display", exact: true }).click();
  await expect(ticketRows(page).first()).toContainText("Ticket 51");
  await page.getByRole("button", { name: "Filters", exact: true }).click();
  await page.getByRole("combobox", { name: "Label", exact: true }).click();
  await page.getByRole("combobox", { name: "Search labels", exact: true }).fill("rare");
  await page.getByRole("option", { name: /rare, quoted 'label'/ }).click();
  await page.getByRole("button", { name: "Filters (1)", exact: true }).click();
  await expect(ticketRows(page)).toHaveCount(1);
  await expect(ticketRows(page).first()).toContainText("LABELUX-51");
  await expect(
    page.getByRole("button", { name: "Label: rare, quoted 'label'", exact: true }),
  ).toBeVisible();
  await openSaveView(page);
  await page.getByLabel("View name", { exact: true }).fill("Rare labels");
  await page.getByRole("button", { name: "Save view", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.reload();
  await expect(ticketRows(page)).toHaveCount(1);
  await page.getByRole("button", { name: "Clear filters", exact: true }).click();
  await expect(ticketRows(page)).toHaveCount(51);
  await chooseTicketView(page, "Rare labels");
  await expect(ticketRows(page)).toHaveCount(1);
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 844 });
    await expect(table.getByRole("link", { name: /Ticket 51/ })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(
      false,
    );
    expect(await table.evaluate((node) => node.scrollWidth > node.clientWidth)).toBe(false);
  }
  await page.getByRole("button", { name: "Ticket views", exact: true }).click();
  await page.getByRole("menuitem", { name: "Delete view Rare labels", exact: true }).click();
  await page
    .getByRole("alertdialog")
    .getByRole("button", { name: "Delete view Rare labels", exact: true })
    .click();
  await expect(page.getByRole("alertdialog")).toHaveCount(0);
  expect(await (await page.request.get(`/api/v1/projects/${project.id}/views`)).json()).toEqual([]);
  await expect(ticketRows(page)).toHaveCount(1);
});

test("selection floats without moving rows and retains selection on failed updates", async ({
  page,
}) => {
  await signIn(page);
  const project = await (
    await page.request.post("/api/v1/projects", {
      data: { key: "SELECTUX", name: "Stable selection" },
    })
  ).json();
  for (const title of ["First selected ticket", "Second selected ticket"])
    expect(
      (
        await page.request.post(`/api/v1/projects/${project.id}/tickets`, {
          data: { title, labels: ["ux"] },
        })
      ).ok(),
    ).toBe(true);
  await page.goto(`/projects/${project.id}`);
  const first = page.getByRole("row").filter({ hasText: "First selected ticket" });
  await expect(first).toBeVisible();
  const before = await first.boundingBox();
  await page.getByRole("checkbox", { name: "Select SELECTUX-1", exact: true }).check();
  const dock = page.getByRole("region", { name: "Selected tickets", exact: true });
  await expect(dock).toBeVisible();
  expect(Math.abs((await first.boundingBox())!.y - before!.y)).toBeLessThan(1);
  await page.getByRole("checkbox", { name: "Select SELECTUX-2", exact: true }).check();
  await expect(dock.getByRole("status")).toHaveText("2 selected");
  await choose(page, "New status", "In review");
  const bulkPath = `**/api/v1/projects/${project.id}/tickets/bulk`;
  await page.route(bulkPath, (route) =>
    route.fulfill({
      status: 409,
      json: { error: { code: "version_conflict", message: "Reload changed tickets" } },
    }),
  );
  await dock.getByRole("button", { name: "Apply status", exact: true }).click();
  await expect(dock.getByRole("alert")).toBeVisible();
  await expect(dock.getByRole("status")).toHaveText("2 selected");
  await page.unroute(bulkPath);
  await dock.getByRole("button", { name: "Apply status", exact: true }).click();
  await expect(dock).toHaveCount(0);
  await expect(first).toContainText("In review");
  for (const width of [1440, 390, 320]) {
    await page.setViewportSize({ width, height: 844 });
    await page.getByRole("checkbox", { name: "Select SELECTUX-1", exact: true }).check();
    const box = await dock.boundingBox();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(width);
    expect(box!.y + box!.height).toBeLessThanOrEqual(844);
    expect(box!.height).toBeLessThanOrEqual(width >= 768 ? 64 : 128);
    await dock.getByRole("button", { name: "Clear selection", exact: true }).click();
  }
});

test("relationships can be created from either direction with readable inverse labels", async ({
  page,
}) => {
  await signIn(page);
  const project = await (
    await page.request.post("/api/v1/projects", {
      data: { key: "LINKUX", name: "Relationship directions" },
    })
  ).json();
  const current = await (
    await page.request.post(`/api/v1/projects/${project.id}/tickets`, {
      data: { title: "Current deliverable" },
    })
  ).json();
  const prerequisite = await (
    await page.request.post(`/api/v1/projects/${project.id}/tickets`, {
      data: { title: "Selected prerequisite" },
    })
  ).json();
  await page.goto(`/projects/${project.id}/tickets/${current.id}`);
  await page.getByRole("button", { name: "Add relationship", exact: true }).click();
  await page.getByRole("combobox", { name: "Relationship", exact: true }).click();
  for (const name of [
    "Is blocked by",
    "Duplicates",
    "Is duplicated by",
    "Causes",
    "Is caused by",
    "Clones",
    "Is cloned by",
    "Implements",
    "Is implemented by",
    "Reviews",
    "Is reviewed by",
  ])
    await expect(page.getByRole("option", { name, exact: true })).toBeVisible();
  await page.getByRole("option", { name: "Is blocked by", exact: true }).click();
  await page.getByRole("combobox", { name: "Ticket", exact: true }).click();
  await page.getByRole("combobox", { name: "Search ticket", exact: true }).fill(prerequisite.key);
  await page.getByRole("option", { name: new RegExp(prerequisite.title) }).click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Add relationship", exact: true })
    .click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.getByText("Is blocked by", { exact: true })).toBeVisible();
  await expect(
    page.getByRole("link", { name: `${prerequisite.key} · ${prerequisite.title}`, exact: true }),
  ).toBeVisible();
  const links = await (
    await page.request.get(`/api/v1/projects/${project.id}/tickets/${current.id}/relations`)
  ).json();
  expect(links[0].sourceId).toBe(prerequisite.id);
  expect(links[0].targetId).toBe(current.id);
  await page.goto(`/projects/${project.id}/tickets/${prerequisite.id}`);
  await expect(page.getByText("Blocks", { exact: true })).toBeVisible();
});
