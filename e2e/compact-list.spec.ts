import { expect, test, type Locator } from "@playwright/test";
import { signIn } from "./auth.ts";
import { appearance, choose } from "./controls.ts";

async function expectSeparateTagRows(table: Locator) {
  const layouts = await table.locator("tbody tr.ticket-row").evaluateAll((rows) =>
    rows.map((row) => {
      const cells = [...row.querySelectorAll<HTMLTableCellElement>("td")];
      const metadata = cells.filter(
        (cell) => !["select", "title", "labels", "scopes"].includes(cell.dataset.column ?? ""),
      );
      const metadataBottom = Math.max(
        ...metadata.map((cell) => cell.getBoundingClientRect().bottom),
      );
      const titleLeft = row.querySelector('[data-column="title"]')!.getBoundingClientRect().left;
      return cells
        .filter((cell) => ["labels", "scopes"].includes(cell.dataset.column ?? ""))
        .every((cell) => {
          const bounds = cell.getBoundingClientRect();
          if (!cell.querySelector(".ticket-tags-trigger")) return bounds.height === 0;
          return bounds.top >= metadataBottom && Math.abs(bounds.left - titleLeft) < 1;
        });
    }),
  );
  expect(layouts).toEqual(layouts.map(() => true));
}

test("narrow ticket lists keep one toolbar, compact metadata, and accessible label previews", async ({
  page,
}) => {
  await signIn(page);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const project = await (
    await page.request.post("/api/v1/projects", {
      data: { key: "DENSE", name: "Compact ticket workflow" },
    })
  ).json();
  const title =
    "Preserve ticket ownership when an agent reconnects after an interrupted handoff and the previous worker is still active";
  const labels = [
    "low",
    "agent-compat",
    "bug",
    "sf",
    "web",
    "upstream",
    "compatibility-with-reconnected-workers",
  ];
  for (let i = 0; i < 3; i++)
    expect(
      (
        await page.request.post(`/api/v1/projects/${project.id}/tickets`, {
          data: {
            title: i === 0 ? title : `Related work ${i}`,
            labels: i === 0 ? labels : i === 1 ? ["bug"] : labels.slice(-2),
            scopes: i === 2 ? ["server"] : [],
            difficulty: "low",
            priority: "urgent",
            status: "done",
          },
        })
      ).ok(),
    ).toBe(true);
  await page.goto(`/projects/${project.id}`);
  const table = page.getByRole("table", { name: "Tickets" }),
    row = table.locator("tbody tr.ticket-row").first();
  for (const mode of ["Light", "Dark"]) {
    await appearance(page, mode);
    for (const width of [1440, 650, 390, 320]) {
      await page.setViewportSize({ width, height: 900 });
      await page.evaluate(() => scrollTo(0, 0));
      await expect(row).toBeVisible();
      const bounds = await row.boundingBox();
      expect(bounds!.y).toBeLessThanOrEqual(200);
      if (width <= 650) {
        const titleBounds = await row.locator(".ticket-title").boundingBox();
        expect(bounds!.height - titleBounds!.height).toBeLessThanOrEqual(96);
        await expectSeparateTagRows(table);
      }
      expect(
        await row
          .locator(".ticket-title")
          .evaluate((e) => e.scrollHeight <= e.clientHeight && e.scrollWidth <= e.clientWidth),
      ).toBe(true);
      expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(
        false,
      );
      await expect(page.getByRole("heading", { name: project.name, exact: true })).toBeVisible();
      await expect(page.getByRole("button", { name: "New ticket", exact: true })).toBeVisible();
      await row.getByRole("button", { name: `Labels: ${labels.join(", ")}`, exact: true }).click();
      const popup = page.locator('[data-slot="popover-content"]');
      for (const label of labels)
        await expect(popup.getByText(label, { exact: true })).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(popup).toHaveCount(0);
    }
  }
  await page.getByRole("button", { name: "Display", exact: true }).click();
  for (const property of ["Status", "Priority", "Difficulty"])
    await page.getByRole("checkbox", { name: property, exact: true }).uncheck();
  await page.getByRole("checkbox", { name: "Scopes", exact: true }).check();
  await choose(page, "Label display", "All labels");
  await page.keyboard.press("Escape");
  await expect(page.locator('[data-slot="popover-content"]')).toHaveCount(0);
  for (const mode of ["Light", "Dark"]) {
    await appearance(page, mode);
    for (const width of [1440, 390, 320]) {
      await page.setViewportSize({ width, height: 900 });
      if (width <= 650) await expectSeparateTagRows(table);
      const inlineLabels = row.getByRole("button", {
        name: `Labels: ${labels.join(", ")}`,
        exact: true,
      });
      for (const label of labels)
        await expect(inlineLabels.getByText(label, { exact: true })).toBeVisible();
      await expect(inlineLabels.locator(".ticket-tags-overflow")).toBeHidden();
      expect(
        await inlineLabels
          .locator(".ticket-tag")
          .evaluateAll((tags) =>
            tags.every(
              (tag) => tag.scrollWidth <= tag.clientWidth && tag.scrollHeight <= tag.clientHeight,
            ),
          ),
      ).toBe(true);
      expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(
        false,
      );
    }
  }
  await page.reload();
  await expect(table).toHaveAttribute("data-label-display", "all");
  await expect(row.getByText(labels.at(-1)!, { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Display", exact: true }).click();
  await expect(page.getByRole("combobox", { name: "Label display", exact: true })).toContainText(
    "All labels",
  );
  await page.getByRole("button", { name: "Reset display", exact: true }).click();
  await page.keyboard.press("Escape");
  await expect(page.locator('[data-slot="popover-content"]')).toHaveCount(0);
  await expect(table).toHaveAttribute("data-label-display", "compact");
  await expect(row.getByText(labels.at(-1)!, { exact: true })).toBeHidden();
  await expect(row.locator(".ticket-tags-overflow")).toBeVisible();
  await page.getByRole("button", { name: "Ticket views", exact: true }).click();
  await page.getByRole("menuitem", { name: "Select all displayed tickets", exact: true }).click();
  await expect(
    page.getByRole("region", { name: "Selected tickets", exact: true }).getByRole("status"),
  ).toHaveText("3 selected");
  await page.getByRole("button", { name: "Clear selection", exact: true }).click();
  await page.getByRole("button", { name: "New ticket", exact: true }).click();
  await page.getByLabel("Title", { exact: true }).fill("Created from the compact toolbar");
  await page.getByRole("button", { name: "Save ticket", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(
    table.getByRole("link", { name: "Created from the compact toolbar", exact: true }),
  ).toBeVisible();
  expect(errors).toEqual([]);
});
