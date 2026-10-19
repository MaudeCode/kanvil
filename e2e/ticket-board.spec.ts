import { expect, test, type Page } from "@playwright/test";
import { signIn, useEmailLogin } from "./auth.ts";
import { choose, setLayout, toggleDisplay } from "./controls.ts";

const lane = (page: Page, name: string) =>
  page.getByRole("region", { name: `${name} tickets`, exact: true });
const card = (page: Page, title: string) => page.locator("li.ticket-row", { hasText: title });

test("the board keeps filters and selection and moves tickets by drag or keyboard", async ({
  page,
  browser,
}) => {
  await signIn(page);
  const project = await (
    await page.request.post("/api/v1/projects", {
      data: { key: "BOARD", name: "Board layout" },
    })
  ).json();
  const create = async (title: string, status: string, labels: string[]) =>
    (
      await page.request.post(`/api/v1/projects/${project.id}/tickets`, {
        data: { title, status, labels },
      })
    ).json();
  await create("Alpha", "todo", ["board"]);
  const bravo = await create(
    "Bravo has a long title that wraps across the lane instead of being cut off",
    "todo",
    ["board"],
  );
  await create("Charlie", "in_progress", ["board"]);
  await create("Delta", "todo", ["elsewhere"]);
  await page.goto(`/projects/${project.id}?label=board`);
  await page.getByRole("checkbox", { name: "Select BOARD-1", exact: true }).check();
  await setLayout(page, "Board");
  await expect(page.getByRole("region", { name: "Ticket board", exact: true })).toBeVisible();
  // Lanes scroll inside the board; the page itself never gains a horizontal scrollbar.
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  // The URL filter, the selection, and every lane survive the switch; empty lanes stay as targets.
  expect(new URL(page.url()).searchParams.get("label")).toContain("board");
  await expect(page.getByRole("region", { name: "Selected tickets", exact: true })).toBeVisible();
  await expect(page.getByRole("checkbox", { name: "Select BOARD-1", exact: true })).toBeChecked();
  await expect(lane(page, "To do").locator("li.ticket-row")).toHaveCount(2);
  await expect(lane(page, "In progress").locator("li.ticket-row")).toHaveCount(1);
  await expect(lane(page, "Backlog")).toBeVisible();
  await expect(card(page, "Delta")).toHaveCount(0);
  const title = card(page, "Bravo").locator(".ticket-title");
  expect(await title.evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true);

  await card(page, "Bravo").dragTo(lane(page, "Backlog"));
  await expect(lane(page, "Backlog").locator("li.ticket-row")).toContainText("Bravo");
  await expect
    .poll(
      async () =>
        (
          await (
            await page.request.get(`/api/v1/projects/${project.id}/tickets/${bravo.id}`)
          ).json()
        ).ticket.status,
    )
    .toBe("backlog");

  // A rejected move returns the ticket to its lane and reports the failure.
  await page.route("**/api/v1/projects/*/tickets/*/move", (route) =>
    route.fulfill({
      status: 409,
      json: { error: { code: "version_conflict", message: "Someone changed this ticket" } },
    }),
  );
  await card(page, "Charlie").dragTo(lane(page, "To do"));
  await expect(page.getByText("Someone changed this ticket")).toBeVisible();
  await expect(lane(page, "In progress").locator("li.ticket-row")).toContainText("Charlie");
  await expect(lane(page, "To do").locator("li.ticket-row")).toHaveCount(1);
  await page.unroute("**/api/v1/projects/*/tickets/*/move");

  // Keyboard: J highlights the first ticket, S opens its status picker.
  await page.keyboard.press("j");
  // Lanes read left to right, so Bravo, now in Backlog, comes first.
  await expect(page.locator("li.ticket-row[data-active=true]")).toContainText("Bravo");
  await page.keyboard.press("s");
  await page.getByRole("option", { name: /Done/ }).click();
  await expect(lane(page, "Done").locator("li.ticket-row")).toContainText("Bravo");
  await page.reload();
  await expect(lane(page, "Done").locator("li.ticket-row")).toContainText("Bravo");

  await setLayout(page, "List");
  await expect(page.getByRole("table", { name: "Tickets", exact: true })).toBeVisible();
  expect(new URL(page.url()).searchParams.get("label")).toContain("board");

  // Readers see the same board without selection, inline editors, or dragging.
  const email = "board-reader@example.test",
    password = "Board reader password 234!";
  expect(
    (
      await page.request.post("/api/auth/admin/create-user", {
        headers: { Origin: new URL(page.url()).origin },
        data: { email, password, name: "Board reader", role: "user" },
      })
    ).ok(),
  ).toBe(true);
  await page.request.post(`/api/v1/projects/${project.id}/members`, {
    data: { email, role: "reader" },
  });
  const context = await browser.newContext({ baseURL: new URL(page.url()).origin });
  try {
    const reader = await context.newPage();
    await reader.goto("/login");
    await useEmailLogin(reader);
    await reader.getByLabel("Email", { exact: true }).fill(email);
    await reader.getByLabel("Password", { exact: true }).fill(password);
    await reader.getByRole("button", { name: "Sign in", exact: true }).click();
    await expect(reader.getByRole("heading", { name: "Projects", exact: true })).toBeVisible();
    await reader.goto(`/projects/${project.id}`);
    await setLayout(reader, "Board");
    await expect(card(reader, "Charlie")).toHaveAttribute("draggable", "false");
    await expect(reader.locator(".ticket-board [role=checkbox]")).toHaveCount(0);
    await expect(reader.locator(".ticket-board [role=combobox]")).toHaveCount(0);
  } finally {
    await context.close();
  }
});

test("project workflow states drive the status picker, list sections, and board lanes", async ({
  page,
}) => {
  await signIn(page);
  const project = await (
    await page.request.post("/api/v1/projects", {
      data: { key: "FLOW", name: "Workflow states" },
    })
  ).json();
  const ticketUrl = (id: string) => `/api/v1/projects/${project.id}/tickets/${id}`;
  const ticket = await (
    await page.request.post(`/api/v1/projects/${project.id}/tickets`, {
      data: { title: "Needs a quality check" },
    })
  ).json();
  await page.goto(`/projects/${project.id}/settings?section=workflow`);
  await expect(page.getByRole("heading", { name: "Workflow", exact: true })).toBeVisible();
  // Every category keeps a state, so a lone state cannot be deleted.
  await expect(
    page.getByRole("button", { name: "Backlog is the only Backlog state", exact: true }),
  ).toBeDisabled();
  await page.getByRole("button", { name: "New state", exact: true }).click();
  await page.getByRole("textbox", { name: "State name", exact: true }).fill("QA");
  await choose(page, "Category", "In review");
  await page.getByRole("button", { name: "Save state", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.getByRole("button", { name: "Move QA up", exact: true }).click();
  await expect(page.getByRole("button", { name: "Move QA up", exact: true })).toBeDisabled();

  await page.goto(`/projects/${project.id}`);
  const row = page.getByRole("row").filter({ hasText: "Needs a quality check" });
  await row.getByRole("combobox", { name: "Status", exact: true }).click();
  await page.getByRole("option", { name: "QA", exact: true }).click();
  await expect(
    page.getByRole("rowgroup", { name: "QA tickets", exact: true }).locator(".ticket-row"),
  ).toContainText("Needs a quality check");
  const read = async () => (await (await page.request.get(ticketUrl(ticket.id))).json()).ticket;
  await expect.poll(async () => (await read()).status).toBe("in_review");
  const workflow = await (await page.request.get(`/api/v1/projects/${project.id}/workflow`)).json();
  const id = (name: string) => workflow.find((state: { name: string }) => state.name === name).id;
  expect((await read()).stateId).toBe(id("QA"));

  await setLayout(page, "Board");
  await expect(lane(page, "QA").locator("li.ticket-row")).toContainText("Needs a quality check");
  await card(page, "Needs a quality check").dragTo(lane(page, "In review"));
  await expect(lane(page, "In review").locator("li.ticket-row")).toContainText(
    "Needs a quality check",
  );
  await expect.poll(async () => (await read()).stateId).toBe(id("In review"));
  await card(page, "Needs a quality check").dragTo(lane(page, "QA"));
  await expect.poll(async () => (await read()).stateId).toBe(id("QA"));
  await setLayout(page, "List");

  // Deleting a state asks where its tickets go.
  await page.goto(`/projects/${project.id}/settings?section=workflow`);
  await page.getByRole("button", { name: "Delete state QA", exact: true }).click();
  await choose(page, "Move 1 ticket to", "Done");
  await page.getByRole("button", { name: "Delete state", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Edit state QA", exact: true })).toHaveCount(0);
  await expect.poll(async () => (await read()).status).toBe("done");
});

test("project backgrounds upload, hide per person, and remove", async ({ page }) => {
  await signIn(page);
  const project = await (
    await page.request.post("/api/v1/projects", {
      data: { key: "BACKDROP", name: "Backdrop" },
    })
  ).json();
  await page.goto(`/projects/${project.id}/settings`);
  await page
    .getByLabel("Project background file", { exact: true })
    .setInputFiles("apps/web/public/brand/icon-192.png");
  await expect(page.getByText("Background updated")).toBeVisible();
  await expect(page.getByRole("img", { name: "Current background", exact: true })).toBeVisible();
  await page.goto(`/projects/${project.id}`);
  const layer = page.locator(
    `img.project-background[src^="/api/v1/projects/${project.id}/background"]`,
  );
  await expect(layer).toBeVisible();
  const source = await layer.getAttribute("src");
  // An empty project shows its empty state in place of the lanes.
  await setLayout(page, "Board");
  await expect(page.getByText("No tickets yet", { exact: true })).toBeVisible();
  await expect(page.getByRole("region", { name: "Backlog tickets", exact: true })).toHaveCount(0);

  await page.getByRole("button", { name: "Display", exact: true }).click();
  await toggleDisplay(page, "Hide");
  await page.keyboard.press("Escape");
  await expect(layer).toHaveCount(0);
  // Hiding is personal: the project keeps its image.
  expect((await page.request.get(source!)).status()).toBe(200);
  await page.goto("/settings?section=preferences");
  await toggleDisplay(page, "Show");
  await page.goto(`/projects/${project.id}`);
  await expect(layer).toBeVisible();

  await page.goto(`/projects/${project.id}/settings`);
  await page.getByRole("button", { name: "Remove", exact: true }).click();
  await expect(page.getByText("Background removed")).toBeVisible();
  await expect(page.getByRole("img", { name: "Current background", exact: true })).toHaveCount(0);
  expect((await page.request.get(`/api/v1/projects/${project.id}/background`)).status()).toBe(404);
});
