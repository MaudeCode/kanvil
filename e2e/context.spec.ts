import { expect, test } from "@playwright/test";
import { signIn } from "./auth.ts";
test("sidebar resizing and contextual ticket and project actions work", async ({
  page,
  context,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await signIn(page);
  await expect(page.locator('.workspace-header > [data-slot="separator"]')).toHaveCount(0);
  for (const collapsed of [false, true]) {
    if (collapsed) await page.getByRole("button", { name: "Toggle Sidebar", exact: true }).click();
    await expect(page.locator('[data-slot="sidebar-container"]')).toHaveCSS(
      "width",
      collapsed ? "66px" : "256px",
    );
    const resizeRail = page.locator('[data-slot="sidebar-rail"]');
    await expect
      .poll(() =>
        resizeRail.evaluate((rail) => {
          const bounds = rail.getBoundingClientRect(),
            header = document.querySelector(".workspace-header");
          if (!header) return false;
          return (
            document.elementFromPoint(
              bounds.x + bounds.width / 2,
              header.getBoundingClientRect().y + 24,
            ) === rail
          );
        }),
      )
      .toBe(true);
  }
  await page.getByRole("button", { name: "Toggle Sidebar", exact: true }).click();
  const suffix = crypto.randomUUID().slice(0, 4).toUpperCase();
  const project = await (
    await page.request.post("/api/v1/projects", {
      data: { key: `MENU${suffix}`, name: `Context menu fixture ${suffix}` },
    })
  ).json();
  const ticket = await (
    await page.request.post(`/api/v1/projects/${project.id}/tickets`, {
      data: {
        title: "Contextual ticket actions",
        status: "todo",
        description: "Keep **Markdown**",
        acceptanceCriteria: "- [ ] Copied",
      },
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
  await expect(
    page.getByRole("row").filter({ hasText: "Contextual ticket actions" }).first(),
  ).toContainText("In progress");
  const stored = async () =>
    (await (await page.request.get(`/api/v1/projects/${project.id}/tickets/${ticket.id}`)).json())
      .ticket;
  await link().click({ button: "right" });
  await page.getByRole("menuitem", { name: "Difficulty", exact: true }).hover();
  await page.getByRole("menuitemradio", { name: "Medium", exact: true }).click();
  await expect.poll(async () => (await stored()).difficulty).toBe("med");
  await link().click({ button: "right" });
  await page.getByRole("menuitem", { name: "Due date", exact: true }).hover();
  await page.getByRole("button", { name: /^Today/ }).click();
  await expect(page.getByRole("menu")).toHaveCount(0);
  await expect.poll(async () => (await stored()).dueAt).not.toBeNull();
  await link().click({ button: "right" });
  await page.getByRole("menuitem", { name: "Due date", exact: true }).hover();
  await page.getByRole("button", { name: "Clear due date", exact: true }).click();
  await expect.poll(async () => (await stored()).dueAt).toBeNull();
  await link().click({ button: "right" });
  await page.getByRole("menuitem", { name: "Copy key and title", exact: true }).click();
  await expect(page.getByText("Ticket copied", { exact: true })).toBeVisible();
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  const copied = async (item: string, expected: string) => {
    await link().click({ button: "right" });
    await page.getByRole("menuitem", { name: item, exact: true }).click();
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(expected);
  };
  await copied("Copy title", "Contextual ticket actions");
  await copied(
    "Copy as Markdown",
    `# ${ticket.key}: Contextual ticket actions\n\n## Description\n\nKeep **Markdown**\n\n## Acceptance criteria\n\n- [ ] Copied\n`,
  );
  await copied("Copy branch name", `${ticket.key}-contextual-ticket-actions`);
  await page.goto(`/projects/${project.id}/tickets/${ticket.id}`);
  await page.getByRole("button", { name: "Ticket actions", exact: true }).click();
  await page.getByRole("menuitem", { name: "Copy branch name", exact: true }).click();
  await expect(page.getByText("Branch name copied", { exact: true })).toBeVisible();
  await page.goto(`/projects/${project.id}`);
  await link().click({ button: "right" });
  await page.getByRole("menuitem", { name: "Edit ticket", exact: true }).click();
  await page.getByLabel("Title", { exact: true }).fill("Edited from the context menu");
  await page.getByRole("button", { name: "Save ticket", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  const edited = page.getByRole("link", { name: "Edited from the context menu", exact: true });
  // The menu's earlier ticket read is still cached; copies must use the refreshed row.
  const ticketPath = `/api/v1/projects/${project.id}/tickets/${ticket.id}`;
  await page.route(`**${ticketPath}`, async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 3000));
    await route.fallback();
  });
  await edited.click({ button: "right" });
  await page.getByRole("menuitem", { name: "Copy title", exact: true }).click();
  await expect
    .poll(() => page.evaluate(() => navigator.clipboard.readText()))
    .toBe("Edited from the context menu");
  await page.unroute(`**${ticketPath}`);
  await edited.click({ button: "right" });
  await page.getByRole("menuitem", { name: "Duplicate ticket", exact: true }).click();
  await expect(page.getByText(`Created ${project.key}-2`, { exact: true })).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Edited from the context menu (copy)", exact: true }),
  ).toBeVisible();
  await page.goBack();
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
