import { expect, test } from "./test.ts";
import { signIn } from "./auth.ts";
import { setLayout } from "./controls.ts";

const day = 86_400_000;
// Whole days in the browser's zone, as the pickers store them.
function startOf(offset: number) {
  const date = new Date(Date.now() + offset * day);
  date.setHours(0, 0, 0, 0);
  return date.toISOString();
}
function endOf(offset: number) {
  const date = new Date(Date.now() + offset * day);
  date.setHours(23, 59, 59, 999);
  return date.toISOString();
}
const longDay = (date: Date) =>
  new Intl.DateTimeFormat(undefined, { dateStyle: "full" }).format(date);

test("calendar and timeline layouts show scheduled tickets with period navigation", async ({
  page,
}) => {
  await signIn(page);
  const project = await (
    await page.request.post("/api/v1/projects", {
      data: { key: "SCHEDULE", name: "Schedule views" },
    })
  ).json();
  const create = async (data: Record<string, unknown>) =>
    (await page.request.post(`/api/v1/projects/${project.id}/tickets`, { data })).json();
  const spanning = await create({
    title: "Spanning release work that wraps across several words",
    startAt: startOf(-1),
    dueAt: endOf(1),
  });
  for (const index of [1, 2, 3, 4]) await create({ title: `Due today ${index}`, dueAt: endOf(0) });
  await create({ title: "Never scheduled" });

  await page.goto(`/projects/${project.id}`);
  await setLayout(page, "Calendar");
  const month = new Intl.DateTimeFormat(undefined, { month: "long", year: "numeric" }).format(
    new Date(),
  );
  const calendar = page.getByRole("table", { name: `Tickets in ${month}`, exact: true });
  await expect(calendar).toBeVisible();
  await expect(calendar.locator('time[aria-current="date"]')).toHaveCount(1);
  await expect(calendar.getByRole("link", { name: /Never scheduled/ })).toHaveCount(0);
  // Five tickets fall on today; three show and the rest open from an accessible overflow.
  const overflow = page.getByRole("button", {
    name: `Show all 5 tickets on ${longDay(new Date())}`,
    exact: true,
  });
  await expect(overflow).toContainText("2 more");
  await overflow.click();
  const dialog = page.locator('[data-slot="popover-content"]');
  await expect(dialog.getByRole("link")).toHaveCount(5);
  await expect(dialog.getByRole("link", { name: /Spanning release work/ })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  // An entry opens the preview sheet over the calendar, which keeps its period.
  await page.getByRole("button", { name: "Next month", exact: true }).click();
  await page.getByRole("button", { name: "Previous month", exact: true }).click();
  await expect(page).toHaveURL(/period=/);
  const entry = calendar.getByRole("link", { name: /Spanning release work/ }).first();
  await entry.click();
  const sheet = page.getByRole("dialog", { name: spanning.title, exact: true });
  await expect(sheet).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`period=.*peek=${spanning.id}`));
  await page.keyboard.press("Escape");
  await expect(sheet).toHaveCount(0);
  await expect(page).toHaveURL(/period=/);
  await expect(calendar).toBeVisible();
  await expect(entry).toBeFocused();

  await page.getByRole("button", { name: "Next month", exact: true }).click();
  await expect(page).toHaveURL(/period=/);
  await expect(calendar).toHaveCount(0);
  await page.getByRole("button", { name: "Today", exact: true }).click();
  await expect(calendar).toBeVisible();

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(overflow).toContainText("5");
  expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
  await page.setViewportSize({ width: 1280, height: 800 });

  await setLayout(page, "Timeline");
  const rows = page.getByRole("list", { name: "Scheduled tickets", exact: true });
  await expect(rows.getByRole("listitem")).toHaveCount(5);
  await expect(rows.getByRole("listitem").first()).toContainText(spanning.key);
  await expect(rows.getByRole("link", { name: /Never scheduled/ })).toHaveCount(0);
  await page.reload();
  await expect(rows.getByRole("listitem")).toHaveCount(5);
  await page.getByRole("button", { name: "Next two weeks", exact: true }).click();
  await page.getByRole("button", { name: "Next two weeks", exact: true }).click();
  await page.getByRole("button", { name: "Next two weeks", exact: true }).click();
  await expect(page.getByText("Nothing scheduled in these weeks", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Today", exact: true }).click();
  await expect(rows.getByRole("listitem")).toHaveCount(5);

  // The layout is a personal preference; List returns to the table.
  await setLayout(page, "List");
  await expect(page.getByRole("table", { name: "Tickets", exact: true })).toBeVisible();
});

test("start dates edit beside due dates", async ({ page }) => {
  await signIn(page);
  const project = await (
    await page.request.post("/api/v1/projects", { data: { key: "STARTS", name: "Start dates" } })
  ).json();
  const ticket = await (
    await page.request.post(`/api/v1/projects/${project.id}/tickets`, {
      data: { title: "Needs a start", dueAt: endOf(3) },
    })
  ).json();
  await page.goto(`/projects/${project.id}/tickets/${ticket.id}`);
  await page.getByRole("button", { name: "Start date", exact: true }).click();
  await page.getByRole("button", { name: /^Today/ }).click();
  await expect
    .poll(async () => {
      const stored = await (
        await page.request.get(`/api/v1/projects/${project.id}/tickets/${ticket.id}`)
      ).json();
      return stored.ticket.startAt;
    })
    .toBe(startOf(0));
});

test("project administrators share and revoke calendar feeds", async ({ page }) => {
  await signIn(page);
  const project = await (
    await page.request.post("/api/v1/projects", { data: { key: "FEEDS", name: "Feed sharing" } })
  ).json();
  const ticket = await (
    await page.request.post(`/api/v1/projects/${project.id}/tickets`, {
      data: { title: "Shared on the calendar", dueAt: endOf(2), labels: ["release"] },
    })
  ).json();
  await page.goto(`/projects/${project.id}/settings?section=calendar`);
  await expect(page.getByRole("heading", { name: "Calendar feeds", exact: true })).toBeVisible();
  await expect(page.getByText("No calendar feeds", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "New calendar feed", exact: true }).click();
  await page.getByRole("textbox", { name: "Feed name", exact: true }).fill("Release calendar");
  await page.getByLabel("Only tickets with these labels", { exact: true }).fill("release");
  await page.getByLabel("Only tickets with these labels", { exact: true }).press("Enter");
  await page.getByRole("button", { name: "Create feed", exact: true }).click();
  const link = page.getByRole("group", { name: "Feed link" }).locator("code");
  await expect(link).toContainText("/api/calendar/kvcal_");
  const url = (await link.textContent())!;
  const feed = await page.request.get(url);
  expect(feed.status()).toBe(200);
  expect(await feed.text()).toContain(`SUMMARY:${ticket.key} · Shared on the calendar`);
  await page.getByRole("button", { name: "Done", exact: true }).click();
  await expect(page.getByText("Release calendar", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Revoke Release calendar", exact: true }).click();
  await page
    .getByRole("alertdialog")
    .getByRole("button", { name: "Revoke Release calendar", exact: true })
    .click();
  await expect(page.getByText("No calendar feeds", { exact: true })).toBeVisible();
  expect((await page.request.get(url)).status()).toBe(404);
});
