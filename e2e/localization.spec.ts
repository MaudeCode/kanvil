import { type Page } from "@playwright/test";
import { expect, test } from "./test.ts";
import { signIn } from "./auth.ts";
import { setProperty } from "./controls.ts";
import german from "../packages/contracts/src/i18n/de-DE/index.ts";
import french from "../packages/contracts/src/i18n/fr-FR/index.ts";

type Catalog = { readonly [key: string]: string | Catalog };
// One catalog string by its dotted key, so assertions follow the shipped translation.
function text(catalog: Catalog, key: string): string {
  let node: string | Catalog | undefined = catalog;
  for (const part of key.split(".")) node = typeof node === "string" ? undefined : node?.[part];
  if (typeof node !== "string") throw new Error(`No catalog string ${key}`);
  return node;
}
const de = (key: string) => text(german, key);
const either = (...names: string[]) =>
  new RegExp(`^(${names.map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})$`);
const noHorizontalScroll = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth <= innerWidth);

test("the chosen language changes presentation only, persists, and reads in every layout", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await signIn(page);
  const project = await (
    await page.request.post("/api/v1/projects", {
      data: { key: "LANG", name: "Language checks" },
    })
  ).json();
  const create = async (data: Record<string, unknown>) =>
    (await page.request.post(`/api/v1/projects/${project.id}/tickets`, { data })).json();
  // Stored text in any script stays exactly as written, right-to-left included.
  const arabic = "تحديث واجهة المستخدم للفريق";
  const english = "Keep stored ticket text exactly as written in every language";
  const rtl = await create({ title: arabic, status: "in_progress", priority: "urgent" });
  const ltr = await create({ title: english, status: "todo", priority: "low" });

  await page.goto("/settings?section=preferences");
  await expect(page.getByRole("combobox", { name: "Week starts on", exact: true })).toContainText(
    "Language default",
  );
  await page.getByRole("combobox", { name: "Language", exact: true }).click();
  await page.getByRole("option", { name: "Deutsch", exact: true }).click();
  await expect(page.locator("html")).toHaveAttribute("lang", "de-DE");
  const language = page.getByRole("combobox", { name: de("common.language.label"), exact: true });
  await expect(language).toContainText("Deutsch");
  // Weekday names come from the language too.
  const weekStart = page.getByRole("combobox", { name: de("settings.preferences.weekStart") });
  await expect(weekStart).toContainText(de("settings.preferences.weekStartLanguage"));
  await weekStart.click();
  await expect(page.getByRole("option", { name: "Montag", exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("lang", "de-DE");
  await expect(language).toContainText("Deutsch");

  // A filter keeps its API value in the URL; only its chip and the rows' wording change.
  await page.goto(`/projects/${project.id}?status=in_progress`);
  await expect(page).toHaveURL(/status=in_progress/);
  const table = page.getByRole("table", { name: de("ticket.list.tickets"), exact: true });
  await expect(table.getByRole("link", { name: arabic, exact: true })).toBeVisible();
  await expect(table.getByRole("link", { name: english, exact: true })).toHaveCount(0);
  await expect(page.getByText(de("common.status.in_progress")).first()).toBeVisible();
  await expect(table.getByRole("link", { name: arabic, exact: true })).toHaveAttribute(
    "dir",
    "auto",
  );

  for (const mode of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: mode, reducedMotion: "reduce" });
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(`/projects/${project.id}`);
      await expect(table.getByRole("link", { name: english, exact: true })).toBeVisible();
      await expect.poll(() => noHorizontalScroll(page)).toBe(true);
      await page.screenshot({
        path: `test-results/de-${mode}-tickets-${width}.png`,
        fullPage: true,
      });
      await page.goto("/settings?section=preferences");
      await expect(language).toBeVisible();
      await expect.poll(() => noHorizontalScroll(page)).toBe(true);
      await page.screenshot({ path: `test-results/de-${mode}-preferences-${width}.png` });
    }
  }
  await page.setViewportSize({ width: 1440, height: 900 });

  // Edits in German write the same API values.
  await page.goto(`/projects/${project.id}/tickets/${ltr.id}`);
  await expect(page.getByRole("heading", { name: english, exact: true })).toBeVisible();
  await setProperty(page, de("ticket.property.priority"), de("common.priority.high"));
  await expect
    .poll(async () => {
      const stored = await (
        await page.request.get(`/api/v1/projects/${project.id}/tickets/${ltr.id}`)
      ).json();
      return [stored.ticket.priority, stored.ticket.title];
    })
    .toEqual(["high", english]);

  // Calendars name months and weekdays in German and start weeks on Monday.
  await page.getByRole("button", { name: de("ticket.date.start"), exact: true }).click();
  const calendar = page.locator("[data-slot=popover-content]");
  await expect(calendar.locator("thead th").first()).toHaveAttribute("aria-label", "Montag");
  await page.keyboard.press("Escape");

  // A refused write explains itself in German, without the server's English text.
  await page.route(`**/api/v1/projects/${project.id}/tickets/${ltr.id}`, (route) =>
    route.request().method() === "PATCH"
      ? route.fulfill({
          status: 403,
          contentType: "application/json",
          body: JSON.stringify({
            error: { code: "forbidden", message: "Only the workspace owner can do this" },
          }),
        })
      : route.fallback(),
  );
  await setProperty(page, de("ticket.property.priority"), de("common.priority.medium"));
  await expect(page.getByText(de("common.error.code.forbidden"), { exact: true })).toBeVisible();
  await expect(page.getByText("Only the workspace owner can do this")).toHaveCount(0);
  await page.unroute(`**/api/v1/projects/${project.id}/tickets/${ltr.id}`);

  // The read-only public view reads in the same language and offers no edits.
  const current = await (await page.request.get(`/api/v1/projects/${project.id}`)).json();
  expect(
    (
      await page.request.patch(`/api/v1/projects/${project.id}`, {
        data: {
          expectedVersion: current.version,
          name: current.name,
          description: current.description,
          publicReadEnabled: true,
        },
      })
    ).ok(),
  ).toBe(true);
  await page.goto(`/public/projects/${project.id}/tickets/${rtl.id}`);
  await expect(page.getByRole("heading", { name: arabic, exact: true })).toBeVisible();
  await expect(page.getByText(de("common.priority.urgent")).first()).toBeVisible();
  await expect(page.getByRole("combobox")).toHaveCount(0);
});

test("a saved language reaches the sign-in page and unknown choices fall back to English", async ({
  page,
}) => {
  await page.addInitScript(() => localStorage.setItem("kanvil:locale", "xx-XX"));
  await page.goto("/login");
  await expect(page.locator("html")).toHaveAttribute("lang", "en-US");
  await expect(
    page.getByRole("heading", { name: either("Sign in", "Create your owner account") }),
  ).toBeVisible();
  await page.addInitScript(() => localStorage.setItem("kanvil:locale", "de-DE"));
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("lang", "de-DE");
  await expect(
    page.getByRole("heading", {
      name: either(de("shell.auth.signIn"), de("shell.auth.createOwner")),
    }),
  ).toBeVisible();
});

test.describe("without a saved choice", () => {
  test.use({ locale: "fr-CA" });
  test("the browser's language picks the closest catalog", async ({ page }) => {
    await page.goto("/login");
    await expect(page.locator("html")).toHaveAttribute("lang", "fr-FR");
    await expect(
      page.getByRole("heading", {
        name: either(text(french, "shell.auth.signIn"), text(french, "shell.auth.createOwner")),
      }),
    ).toBeVisible();
  });
});
