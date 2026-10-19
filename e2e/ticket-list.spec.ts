import { expect, test, type Locator } from "@playwright/test";
import { signIn } from "./auth.ts";
import {
  choose,
  chooseTicketView,
  openSaveView,
  openSearch,
  setProperty,
  ticketRows,
  toggleDisplay,
} from "./controls.ts";
import { operations, priorities, priorityLabels } from "../packages/contracts/src/index.ts";

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
    observer.locator(".ticket-properties [data-label-color]").filter({ hasText: /^bug$/ }),
  ).toHaveAttribute("data-label-color", "gray");
  await page.goto(`/projects/${project.id}/settings?section=labels`);
  await expect(page.getByRole("heading", { name: "Labels", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Edit label bug", exact: true }).click();
  await page.getByRole("textbox", { name: "Label name", exact: true }).fill("Defect");
  await page.getByRole("button", { name: "red label color", exact: true }).click();
  await page.getByRole("button", { name: "Save label", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  const liveLabel = observer
    .locator(".ticket-properties [data-label-color]")
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
  await (await openSearch(page, "Search labels")).fill("release");
  await expect(page.getByRole("button", { name: "Edit label Defect", exact: true })).toHaveCount(0);
  await page.goto(`/projects/${project.id}`);
  const table = page.getByRole("table", { name: "Tickets" });
  await expect(
    table.locator('[data-label-color="orange"]').filter({ hasText: /^Defect$/ }),
  ).toBeVisible();
  await page.getByRole("button", { name: "New ticket", exact: true }).click();
  await page.getByRole("textbox", { name: "Title", exact: true }).fill("Ticket from managed label");
  await page.getByRole("button", { name: "Edit labels", exact: true }).click();
  await page.getByRole("button", { name: "Choose labels", exact: true }).click();
  await page.getByRole("option", { name: "release, ready", exact: true }).click();
  await page.keyboard.press("Escape");
  await expect(
    page
      .getByRole("dialog")
      .locator('[data-label-color="purple"]')
      .filter({ hasText: /release, ready/ })
      .first(),
  ).toBeVisible();
  await page.getByRole("button", { name: "Create ticket", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(
    table.locator('[data-label-color="purple"]').filter({ hasText: /^release, ready$/ }),
  ).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/projects/${project.id}/settings?section=labels`);
  await expect(page.getByRole("combobox", { name: "Settings section", exact: true })).toContainText(
    "Labels",
  );
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
  await page
    .locator('[data-slot="popover-content"]')
    .getByRole("combobox", { name: "Priority", exact: true })
    .click();
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
  for (const property of ["Ticket", "Labels", "Status", "Priority", "Difficulty", "Due"])
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
  await expect(table.locator('td[data-column="kind"]').first()).toContainText(/feature/i);
  await expect(table.locator('td[data-column="scopes"]').first()).toContainText("web");
  await expect(table.locator('td[data-column="assigneeId"]').first()).toContainText("Unassigned");
  await expect(table.locator('td[data-column="createdAt"]').first()).not.toBeEmpty();
  await expectFullWidth(table);
  await page.getByRole("button", { name: "Display", exact: true }).click();
  await page.getByRole("button", { name: "Reset display", exact: true }).click();
  await expect(page.getByRole("checkbox", { name: "Labels", exact: true })).toBeChecked();
  await choose(page, "Order by", "Labels");
  await page.getByRole("button", { name: "Display", exact: true }).click();
  await expect(ticketRows(page).first()).toContainText("Ticket 51");
  // Column headers sort too: first click uses the column's natural direction, second flips it.
  const ticketHeader = table.locator('th[data-column="key"]');
  await ticketHeader.getByRole("button", { name: "Ticket", exact: true }).click();
  await expect(ticketHeader).toHaveAttribute("aria-sort", "ascending");
  await expect(ticketRows(page).first().locator('td[data-column="key"]')).toHaveText("LABELUX-1");
  await ticketHeader.getByRole("button", { name: "Ticket", exact: true }).click();
  await expect(ticketHeader).toHaveAttribute("aria-sort", "descending");
  await expect(ticketRows(page).first().locator('td[data-column="key"]')).toHaveText("LABELUX-51");
  await page.getByRole("button", { name: "Display", exact: true }).click();
  await toggleDisplay(page, "None");
  await expect(page.getByRole("rowgroup", { name: "To do tickets" })).toHaveCount(0);
  await expect(ticketRows(page)).toHaveCount(51);
  await page.getByRole("button", { name: "Reset display", exact: true }).click();
  await expect(page.getByRole("rowgroup", { name: "To do tickets" })).toBeVisible();
  await expect(ticketHeader).not.toHaveAttribute("aria-sort");
  await page.keyboard.press("Escape");
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
  const bulkPath = `**/api/v1/projects/${project.id}/tickets/bulk`;
  await page.route(bulkPath, (route) =>
    route.fulfill({
      status: 409,
      json: { error: { code: "version_conflict", message: "Reload changed tickets" } },
    }),
  );
  // The failure refetch is slow; until it lands the selection still holds stale versions.
  const listPath = (url: URL) => url.pathname === `/api/v1/projects/${project.id}/tickets`;
  await page.route(listPath, async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 2000));
    await route.fallback();
  });
  const failed = page.waitForResponse((response) => response.url().endsWith("/tickets/bulk"));
  await setProperty(dock, "Status", "In review");
  await failed;
  await page.waitForTimeout(300);
  const status = dock.getByRole("combobox", { name: "Status", exact: true });
  expect(await status.isDisabled()).toBe(true);
  await expect(page.getByText("Reload changed tickets", { exact: true })).toBeVisible();
  await expect(status).toBeEnabled();
  await page.unroute(listPath);
  await expect(dock.getByRole("status")).toHaveText("2 selected");
  await page.unroute(bulkPath);
  await setProperty(dock, "Status", "In review");
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

test("a mixed selection applies the first row's value to every ticket", async ({ page }) => {
  await signIn(page);
  const project = await (
    await page.request.post("/api/v1/projects", { data: { key: "MIXED", name: "Mixed selection" } })
  ).json();
  for (const [title, status] of [
    ["Mixed todo ticket", "todo"],
    ["Mixed progress ticket", "in_progress"],
  ])
    expect(
      (
        await page.request.post(`/api/v1/projects/${project.id}/tickets`, {
          data: { title, status },
        })
      ).ok(),
    ).toBe(true);
  await page.goto(`/projects/${project.id}`);
  await page.getByRole("checkbox", { name: "Select MIXED-1", exact: true }).check();
  await page.getByRole("checkbox", { name: "Select MIXED-2", exact: true }).check();
  const dock = page.getByRole("region", { name: "Selected tickets", exact: true });
  await setProperty(dock, "Status", "To do");
  await expect(dock).toHaveCount(0);
  await expect(page.getByRole("row").filter({ hasText: "Mixed progress ticket" })).toContainText(
    "To do",
  );
});

test("bulk edits replace labels, set and clear due dates, and change difficulty", async ({
  page,
}) => {
  await signIn(page);
  const project = await (
    await page.request.post("/api/v1/projects", { data: { key: "BULKSET", name: "Bulk set" } })
  ).json();
  for (const [title, label] of [
    ["Bulk labelled ux", "ux"],
    ["Bulk labelled api", "api"],
  ])
    expect(
      (
        await page.request.post(`/api/v1/projects/${project.id}/tickets`, {
          data: { title, labels: [label] },
        })
      ).ok(),
    ).toBe(true);
  const stored = async () =>
    operations.list_tickets.output.parse(
      await (await page.request.get(`/api/v1/projects/${project.id}/tickets`)).json(),
    ).items;
  await page.goto(`/projects/${project.id}`);
  const dock = page.getByRole("region", { name: "Selected tickets", exact: true });
  const selectBoth = async () => {
    for (const key of ["BULKSET-1", "BULKSET-2"])
      await page.getByRole("checkbox", { name: `Select ${key}`, exact: true }).check();
    await expect(dock.getByRole("status")).toHaveText("2 selected");
  };
  await selectBoth();
  await dock.getByRole("button", { name: "Edit labels: mixed", exact: true }).click();
  const labels = page.getByLabel("Labels", { exact: true });
  await expect(page.locator('[data-slot="popover-content"]').getByText("ux")).toHaveCount(0);
  await labels.fill("shared");
  await labels.press("Enter");
  await page.getByRole("button", { name: "Replace labels", exact: true }).click();
  await expect(dock).toHaveCount(0);
  await expect
    .poll(async () => (await stored()).map((ticket) => ticket.labels))
    .toEqual([["shared"], ["shared"]]);
  await selectBoth();
  // A pending write disables every control so the same edit cannot be applied twice.
  const bulkPath = `**/api/v1/projects/${project.id}/tickets/bulk`;
  await page.route(bulkPath, async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    await route.fallback();
  });
  await setProperty(dock, "Difficulty", "High");
  await expect(dock.getByRole("combobox", { name: "Status", exact: true })).toBeDisabled();
  await expect(dock.getByRole("button", { name: "Due date", exact: true })).toBeDisabled();
  await expect(dock).toHaveCount(0);
  await page.unroute(bulkPath);
  await expect
    .poll(async () => (await stored()).map((ticket) => ticket.difficulty))
    .toEqual(["high", "high"]);
  await selectBoth();
  await dock.getByRole("button", { name: "Due date", exact: true }).click();
  await page.getByRole("button", { name: /^Today/ }).click();
  await expect(dock).toHaveCount(0);
  await expect
    .poll(async () => (await stored()).every((ticket) => ticket.dueAt !== null))
    .toBe(true);
  await selectBoth();
  await dock.getByRole("button", { name: "Due date", exact: true }).click();
  await page.getByRole("button", { name: "Clear due date", exact: true }).click();
  await expect(dock).toHaveCount(0);
  await expect
    .poll(async () => (await stored()).map((ticket) => ticket.dueAt))
    .toEqual([null, null]);
  await selectBoth();
  await dock.getByRole("button", { name: "Edit labels: shared", exact: true }).click();
  await page.getByRole("button", { name: "Clear labels", exact: true }).click();
  await expect.poll(async () => (await stored()).map((ticket) => ticket.labels)).toEqual([[], []]);
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
  await page.getByRole("menuitem", { name: "Link existing ticket", exact: true }).click();
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
test("a preview sheet opens the highlighted ticket over the list and returns to its row", async ({
  page,
}) => {
  await signIn(page);
  const project = await (
    await page.request.post("/api/v1/projects", { data: { key: "PEEK", name: "Peek" } })
  ).json();
  const created: { id: string }[] = [];
  for (const title of ["Alpha", "Bravo", "Charlie"])
    created.push(
      await (
        await page.request.post(`/api/v1/projects/${project.id}/tickets`, { data: { title } })
      ).json(),
    );
  await page.goto(`/projects/${project.id}?sort=number&order=asc`);
  await expect(ticketRows(page)).toHaveCount(3);
  await page.keyboard.press("j");
  await page.keyboard.press("x");
  await page.keyboard.press("j");
  await page.keyboard.press(" ");
  const bravo = page.getByRole("dialog", { name: "Bravo", exact: true });
  await expect(bravo).toBeVisible();
  await expect(page).toHaveURL(/sort=number/);
  await expect(page).toHaveURL(new RegExp(`peek=${created[1]!.id}`));
  // The list behind keeps its rows, highlight, and selection; the modal sheet hides it from
  // assistive technology, so these checks use the DOM.
  await expect(page.locator("tr.ticket-row")).toHaveCount(3);
  await expect(page.locator("tr[data-selected=true]")).toContainText("Alpha");
  await expect(page.locator("tr[data-active=true]")).toContainText("Bravo");
  // The preview is the ticket detail: its property edits reach the list row.
  await setProperty(bravo, "Priority", "High");
  await expect(page.locator("tr[data-active=true] [data-priority=high]")).toHaveCount(1);
  await expect(page.locator("[data-slot=popover-content]")).toHaveCount(0);
  await page.keyboard.press("j");
  await expect(page.getByRole("dialog", { name: "Charlie", exact: true })).toBeVisible();
  await expect(page.locator("tr[data-active=true]")).toContainText("Charlie");
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page).not.toHaveURL(/peek=/);
  await expect(page.locator("tr[data-active=true] .ticket-title")).toBeFocused();
  // Space on a control inside the highlighted row keeps the control's own behavior.
  await page.locator("tr[data-active=true] td[data-column=status] [role=combobox]").focus();
  await page.keyboard.press(" ");
  await expect(page.getByRole("option", { name: /In progress/ })).toBeVisible();
  await expect(page.getByRole("dialog", { name: "Charlie", exact: true })).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(page.locator("[data-slot=popover-content]")).toHaveCount(0);
  await page.locator("tr[data-active=true] .ticket-title").focus();
  // Back closes a preview opened from the list.
  await page.keyboard.press(" ");
  await expect(page.getByRole("dialog", { name: "Charlie", exact: true })).toBeVisible();
  await page.goBack();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page).toHaveURL(new RegExp(`/projects/${project.id}\\?`));
  // The context menu opens a preview without the keyboard.
  await ticketRows(page).filter({ hasText: "Alpha" }).click({ button: "right" });
  await page.getByRole("menuitem", { name: "Preview", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "Alpha", exact: true })).toBeVisible();
  // A refreshed preview resolves from the URL and hands over to the full page.
  await page.reload();
  const alpha = page.getByRole("dialog", { name: "Alpha", exact: true });
  await expect(alpha).toBeVisible();
  await alpha.getByRole("link", { name: "Open in full page", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/projects/${project.id}/tickets/${created[0]!.id}$`));
  await expect(page.getByRole("heading", { name: "Alpha", exact: true })).toBeVisible();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  // My work keeps showing a preview whose edit removes its row from the list.
  const me = (await (await page.request.get("/api/auth/get-session")).json()).user;
  await page.request.post(`/api/v1/projects/${project.id}/tickets`, {
    data: { title: "Delta", assigneeId: me.id },
  });
  await page.goto("/my-work");
  await page.locator("tr.ticket-row", { hasText: "Delta" }).click({ button: "right" });
  await page.getByRole("menuitem", { name: "Preview", exact: true }).click();
  const delta = page.getByRole("dialog", { name: "Delta", exact: true });
  await setProperty(delta, "Status", "Done");
  await expect(page.locator("tr.ticket-row", { hasText: "Delta" })).toHaveCount(0);
  await expect(delta).toBeVisible();
  await expect(delta.getByRole("combobox", { name: "Status", exact: true })).toContainText("Done");
  await page.reload();
  await expect(page.getByRole("dialog", { name: "Delta", exact: true })).toBeVisible();
});
test("keyboard highlight walks the list, opens tickets, and the detail steps through the same order", async ({
  page,
}) => {
  await signIn(page);
  const project = await (
    await page.request.post("/api/v1/projects", {
      data: { key: "KEYNAV", name: "Keyboard navigation" },
    })
  ).json();
  const me = (await (await page.request.get("/api/auth/get-session")).json()).user;
  for (const [index, title] of ["Alpha", "Bravo", "Charlie"].entries())
    await page.request.post(`/api/v1/projects/${project.id}/tickets`, {
      data: { title, ...(index === 1 ? { assigneeId: me.id } : {}) },
    });
  await page.goto("/");
  await expect(
    page.locator(".project-list").getByRole("listitem").filter({ hasText: "Keyboard navigation" }),
  ).toContainText("3 open");
  await page.goto(`/projects/${project.id}`);
  await expect(ticketRows(page)).toHaveCount(3);
  await page.keyboard.press("j");
  await page.keyboard.press("j");
  await expect(page.locator("tr[data-active=true]")).toHaveCount(1);
  await expect(page.locator("tr[data-active=true]")).toContainText("KEYNAV-2");
  await page.keyboard.press("x");
  await expect(page.getByRole("region", { name: "Selected tickets", exact: true })).toBeVisible();
  await page.keyboard.press("x");
  await page.keyboard.press("s");
  await page.getByRole("option", { name: /In progress/ }).click();
  await expect(page.locator("tr[data-active=true]")).toContainText("In progress");
  await page.keyboard.press("Enter");
  // The status change moved Bravo into the In progress section, which renders last.
  await expect(page.getByRole("heading", { name: "Bravo", exact: true })).toBeVisible();
  await expect(page.getByText("3 / 3", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Next ticket", exact: true })).toBeDisabled();
  await page.keyboard.press("k");
  await expect(page.getByRole("heading", { name: "Charlie", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Previous ticket", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Alpha", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Previous ticket", exact: true })).toBeDisabled();
  await page.goto(`/projects/${project.id}`);
  await page.getByRole("button", { name: "Filters", exact: true }).click();
  await choose(page, "Assignee", "Me");
  await page.keyboard.press("Escape");
  await expect(ticketRows(page)).toHaveCount(1);
  await expect(page.getByRole("button", { name: "Assigned to me", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Filters (1)", exact: true }).click();
  await choose(page, "Assignee", "Unassigned");
  await page.keyboard.press("Escape");
  await expect(ticketRows(page)).toHaveCount(2);
});
