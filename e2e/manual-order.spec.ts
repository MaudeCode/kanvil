import { expect, test, type Page } from "@playwright/test";
import { z } from "zod";
import { signIn } from "./auth.ts";
import { toggleDisplay } from "./controls.ts";

const titles = (page: Page, section: string) =>
  page
    .getByRole("rowgroup", { name: `${section} tickets`, exact: true })
    .locator("tr.ticket-row .ticket-title")
    .allInnerTexts();
const row = (page: Page, title: string) => page.locator("tr.ticket-row", { hasText: title });
async function serverOrder(page: Page, projectId: string, status: string) {
  const response = await page.request.get(
    `/api/v1/projects/${projectId}/tickets?sort=manual&status=${status}`,
  );
  return z
    .object({ items: z.array(z.object({ title: z.string() })) })
    .parse(await response.json())
    .items.map((item) => item.title);
}

test("the manual order moves tickets by keyboard, menu, and drag across list and board", async ({
  page,
}) => {
  await signIn(page);
  const project = await (
    await page.request.post("/api/v1/projects", { data: { key: "ORDER", name: "Manual order" } })
  ).json();
  for (const [title, status] of [
    ["Alpha", "todo"],
    ["Bravo", "todo"],
    ["Charlie", "todo"],
    ["Delta", "in_progress"],
  ])
    await page.request.post(`/api/v1/projects/${project.id}/tickets`, { data: { title, status } });
  await page.goto(`/projects/${project.id}`);
  // Manual is an explicit order choice that rides in the URL.
  await page.getByRole("button", { name: "Display", exact: true }).click();
  await page.getByRole("combobox", { name: "Order by", exact: true }).click();
  await page.getByRole("option", { name: "Manual", exact: true }).click();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page).toHaveURL(/sort=manual/);
  await expect.poll(() => titles(page, "To do")).toEqual(["Alpha", "Bravo", "Charlie"]);

  // Keyboard: Option+arrows move the highlighted ticket, with Shift to the ends.
  await page.keyboard.press("j");
  await expect(page.locator("tr.ticket-row[data-active=true]")).toContainText("Alpha");
  // Two quick moves both land: the second waits for the first and uses its new version.
  await page.keyboard.press("Alt+ArrowDown");
  await page.keyboard.press("Alt+ArrowDown");
  await expect
    .poll(() => serverOrder(page, project.id, "todo"))
    .toEqual(["Bravo", "Charlie", "Alpha"]);
  await expect.poll(() => titles(page, "To do")).toEqual(["Bravo", "Charlie", "Alpha"]);
  await page.keyboard.press("Alt+Shift+ArrowUp");
  await expect
    .poll(() => serverOrder(page, project.id, "todo"))
    .toEqual(["Alpha", "Bravo", "Charlie"]);
  await page.keyboard.press("Alt+Shift+ArrowDown");
  await expect
    .poll(() => serverOrder(page, project.id, "todo"))
    .toEqual(["Bravo", "Charlie", "Alpha"]);
  await expect(page.getByRole("status").filter({ hasText: "ORDER-1 moved" })).toBeAttached();
  // ] moves it to the top of the next status.
  await page.keyboard.press("]");
  await expect.poll(() => serverOrder(page, project.id, "in_progress")).toEqual(["Alpha", "Delta"]);
  await expect(page.locator("tr.ticket-row[data-active=true]")).toContainText("Alpha");

  // The ticket menu offers the same moves.
  await row(page, "Charlie").click({ button: "right" });
  await page.getByRole("menuitem", { name: "Move", exact: true }).click();
  await expect(page.getByRole("menuitem", { name: /^Move down/ })).toHaveAttribute(
    "aria-disabled",
    "true",
  );
  await page.getByRole("menuitem", { name: /^Move to top/ }).click();
  await expect.poll(() => serverOrder(page, project.id, "todo")).toEqual(["Charlie", "Bravo"]);

  // Dragging onto the top half of a row in another status section places the ticket above it
  // in that status.
  await row(page, "Delta").dragTo(row(page, "Bravo"), { targetPosition: { x: 40, y: 4 } });
  await expect
    .poll(() => serverOrder(page, project.id, "todo"))
    .toEqual(["Charlie", "Delta", "Bravo"]);
  await expect.poll(() => titles(page, "To do")).toEqual(["Charlie", "Delta", "Bravo"]);

  // A saved view keeps the manual order; computed orders ignore it.
  await page.getByRole("button", { name: "Ticket views", exact: true }).click();
  await page.getByRole("menuitem", { name: "Save current view", exact: true }).click();
  await page.getByLabel("View name", { exact: true }).fill("Planned order");
  await page.getByRole("button", { name: "Save view", exact: true }).click();
  await expect(page.getByText("View saved", { exact: true })).toBeVisible();
  const views = z
    .array(z.object({ name: z.string(), filters: z.object({ sort: z.string() }) }))
    .parse(await (await page.request.get(`/api/v1/projects/${project.id}/views`)).json());
  expect(views.find((view) => view.name === "Planned order")?.filters.sort).toBe("manual");
  await page.goto(`/projects/${project.id}?sort=title`);
  await expect.poll(() => titles(page, "To do")).toEqual(["Bravo", "Charlie", "Delta"]);

  // The board shares the order: a card dropped on the lower half of another lands below it.
  await page.goto(`/projects/${project.id}?sort=manual`);
  await page.getByRole("button", { name: "Display", exact: true }).click();
  await toggleDisplay(page, "Board");
  await page.keyboard.press("Escape");
  const lane = page.getByRole("region", { name: "To do tickets", exact: true });
  await expect(lane.locator("li.ticket-row .ticket-title")).toHaveText([
    "Charlie",
    "Delta",
    "Bravo",
  ]);
  const bravo = lane.locator("li.ticket-row", { hasText: "Bravo" }),
    box = await bravo.boundingBox();
  await lane
    .locator("li.ticket-row", { hasText: "Charlie" })
    .dragTo(bravo, { targetPosition: { x: 40, y: (box?.height ?? 40) - 4 } });
  await expect
    .poll(() => serverOrder(page, project.id, "todo"))
    .toEqual(["Delta", "Bravo", "Charlie"]);
  await expect(lane.locator("li.ticket-row .ticket-title")).toHaveText([
    "Delta",
    "Bravo",
    "Charlie",
  ]);
  // [ steps back a status on the board too.
  await page.keyboard.press("j");
  await expect(page.locator("li.ticket-row[data-active=true]")).toContainText("Delta");
  await page.keyboard.press("[");
  await expect.poll(() => serverOrder(page, project.id, "backlog")).toEqual(["Delta"]);
  await page.getByRole("button", { name: "Display", exact: true }).click();
  await toggleDisplay(page, "List");
  await page.keyboard.press("Escape");
});

test("project administrators reorder the workspace's projects from the sidebar", async ({
  page,
}) => {
  await signIn(page);
  const names = ["Order first", "Order second", "Order third"];
  for (const [index, name] of names.entries())
    await page.request.post("/api/v1/projects", { data: { key: `PORDER${index}`, name } });
  await page.goto("/");
  const link = (name: string) => page.getByRole("link", { name, exact: true }),
    order = async () =>
      (
        await page.getByRole("link", { name: /^Order (first|second|third)$/ }).allTextContents()
      ).map((text) => names.find((name) => text.startsWith(name)));
  await expect.poll(order).toEqual(names);
  await link("Order third").click({ button: "right" });
  await page.getByRole("menuitem", { name: "Move up", exact: true }).click();
  await expect.poll(order).toEqual(["Order first", "Order third", "Order second"]);
  await link("Order first").dragTo(link("Order second"), { targetPosition: { x: 20, y: 20 } });
  await expect.poll(order).toEqual(["Order third", "Order second", "Order first"]);
  await page.reload();
  await expect.poll(order).toEqual(["Order third", "Order second", "Order first"]);
});

test("My work steps a writable ticket's status from the keyboard and the ticket menu", async ({
  page,
}) => {
  await signIn(page);
  const session = z
    .object({ user: z.object({ id: z.string() }) })
    .parse(await (await page.request.get("/api/auth/get-session")).json());
  const project = await (
    await page.request.post("/api/v1/projects", { data: { key: "WORKSTEP", name: "Work steps" } })
  ).json();
  const ticket = z.object({ id: z.string() }).parse(
    await (
      await page.request.post(`/api/v1/projects/${project.id}/tickets`, {
        data: { title: "Stepped from My work", assigneeId: session.user.id },
      })
    ).json(),
  );
  const status = async () =>
    z
      .object({ ticket: z.object({ status: z.string() }) })
      .parse(
        await (
          await page.request.get(`/api/v1/projects/${project.id}/tickets/${ticket.id}`)
        ).json(),
      ).ticket.status;
  await page.goto("/my-work?q=Stepped");
  await expect(row(page, "Stepped from My work")).toBeVisible();
  await page.keyboard.press("j");
  await expect(page.locator("tr.ticket-row[data-active=true]")).toContainText("Stepped");
  await page.keyboard.press("]");
  await expect.poll(status).toBe("in_progress");
  await row(page, "Stepped from My work").click({ button: "right" });
  await page.getByRole("menuitem", { name: "Move", exact: true }).click();
  await page.getByRole("menuitem", { name: /^Move to previous status/ }).click();
  await expect.poll(status).toBe("todo");
});
