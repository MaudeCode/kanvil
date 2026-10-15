import { expect, test } from "@playwright/test";
import { signIn } from "./auth.ts";
test("sidebar resizing and contextual ticket and project actions work", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await signIn(page);
  const suffix = crypto.randomUUID().slice(0, 4).toUpperCase();
  const project = await (
    await page.request.post("/api/v1/projects", {
      data: { key: `MENU${suffix}`, name: `Context menu fixture ${suffix}` },
    })
  ).json();
  const ticket = await (
    await page.request.post(`/api/v1/projects/${project.id}/tickets`, {
      data: { title: "Contextual ticket actions", status: "todo" },
    })
  ).json();
  await page.goto(`/projects/${project.id}`);
  await expect(page.getByRole("heading", { name: project.name, exact: true })).toBeVisible();
  const rail = page.getByRole("separator", { name: "Resize sidebar", exact: true });
  await expect(rail).toBeVisible();
  const box = await rail.boundingBox();
  if (!box) throw new Error("Sidebar rail is missing");
  await page.mouse.move(box.x + box.width / 2, box.y + 100);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 120, box.y + 100, { steps: 8 });
  await page.mouse.up();
  await expect(rail).toHaveAttribute("aria-valuenow", "376");
  await page.reload();
  await expect(rail).toHaveAttribute("aria-valuenow", "376");
  await rail.focus();
  await page.keyboard.press("ArrowLeft");
  await expect(rail).toHaveAttribute("aria-valuenow", "360");
  await expect(page.getByRole("link", { name: ticket.title, exact: true })).toBeVisible();
  await rail.dblclick();
  await expect(rail).toHaveAttribute("aria-valuenow", "256");
  await page
    .getByRole("navigation", { name: "Workspace", exact: true })
    .getByRole("link", { name: project.name, exact: true })
    .click({ button: "right" });
  await expect(page.getByRole("menuitem", { name: "Project settings", exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  const link = () => page.getByRole("link", { name: "Contextual ticket actions", exact: true });
  await link().click({ button: "right" });
  await page.getByRole("menuitem", { name: "Status", exact: true }).hover();
  await page.getByRole("menuitemradio", { name: "In progress", exact: true }).click();
  await expect(page.getByRole("cell", { name: "In progress", exact: false })).toBeVisible();
  await link().click({ button: "right" });
  await page.getByRole("menuitem", { name: "Copy key and title", exact: true }).click();
  await expect(page.getByText("Ticket copied", { exact: true })).toBeVisible();
  await link().click({ button: "right" });
  await page.getByRole("menuitem", { name: "Edit ticket", exact: true }).click();
  await page.getByLabel("Title", { exact: true }).fill("Edited from the context menu");
  await page.getByRole("button", { name: "Save ticket", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  const edited = page.getByRole("link", { name: "Edited from the context menu", exact: true });
  await edited.click({ button: "right" });
  await page.screenshot({ path: "test-results/ticket-context-menu.png", fullPage: true });
  await page.getByRole("menuitem", { name: "Delete ticket", exact: true }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(edited).toBeVisible();
  await edited.click({ button: "right" });
  await page.getByRole("menuitem", { name: "Delete ticket", exact: true }).click();
  await page
    .getByRole("alertdialog")
    .getByRole("button", { name: "Delete ticket", exact: true })
    .click();
  await expect(page.getByRole("alertdialog")).toHaveCount(0);
  await expect(edited).toHaveCount(0);
  expect(
    (await page.request.get(`/api/v1/projects/${project.id}/tickets/${ticket.id}`)).status(),
  ).toBe(404);
  expect(errors).toEqual([]);
});
