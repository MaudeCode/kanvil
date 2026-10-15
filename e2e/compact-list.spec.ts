import { expect, test } from "@playwright/test";
import { signIn } from "./auth.ts";
import { appearance } from "./controls.ts";

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
  const labels = ["low", "agent-compat", "bug", "sf", "web", "upstream"];
  for (let i = 0; i < 3; i++)
    expect(
      (
        await page.request.post(`/api/v1/projects/${project.id}/tickets`, {
          data: {
            title: i === 0 ? title : `Related work ${i}`,
            labels,
            difficulty: "low",
            priority: "urgent",
            status: "done",
          },
        })
      ).ok(),
    ).toBe(true);
  await page.goto(`/projects/${project.id}`);
  const table = page.getByRole("table", { name: "Tickets" }),
    row = table.locator("tbody tr").first();
  for (const mode of ["Light", "Dark"]) {
    await appearance(page, mode);
    for (const width of [1440, 650, 390, 320]) {
      await page.setViewportSize({ width, height: 900 });
      await page.evaluate(() => scrollTo(0, 0));
      await expect(row).toBeVisible();
      const bounds = await row.boundingBox();
      expect(bounds!.y).toBeLessThanOrEqual(160);
      if (width <= 650) expect(bounds!.height).toBeLessThanOrEqual(140);
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
