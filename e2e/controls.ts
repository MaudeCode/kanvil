import { t } from "../packages/contracts/src/i18n/index.ts";
import { expect, type Locator, type Page, type Request } from "@playwright/test";

// Prefers the combobox inside the open popover or dialog, since list rows carry inline editors too.
// One playing its exit is already closed.
export async function choose(page: Page, label: string, option: string) {
  const overlay = page
    .locator(
      '[data-slot="popover-content"]:not([data-ending-style]), [role="dialog"]:not([data-ending-style])',
    )
    .last();
  const scope = (await overlay.count()) ? overlay : page;
  await scope.getByRole("combobox", { name: label, exact: true }).click();
  await page.getByRole("option", { name: option, exact: true }).click();
}
export async function chooseTicketView(page: Page, name: string) {
  await page.getByRole("button", { name: "Ticket views", exact: true }).click();
  await page.getByRole("menuitemradio", { name, exact: true }).click();
  await expect(page.getByRole("menu")).toHaveCount(0);
}
export async function openSaveView(page: Page) {
  await page.getByRole("button", { name: "Ticket views", exact: true }).click();
  await page.getByRole("menuitem", { name: "Save current view", exact: true }).click();
}
export async function searchTickets(page: Page, text: string) {
  await page.getByRole("button", { name: "Search tickets", exact: true }).click();
  await page.getByRole("searchbox", { name: "Search tickets", exact: true }).fill(text);
  await page.keyboard.press("Escape");
}
export async function appearance(page: Page, option: string) {
  const previousUrl = page.url();
  await page.goto("/settings?section=appearance");
  await page.getByRole("radio", { name: option, exact: true }).check();
  await page.goto(previousUrl);
}
// A section link in the settings navigation; `group` disambiguates names such as General.
export function settingsLink(page: Page, name: string, group?: string) {
  const nav = page.getByRole("navigation", { name: "Settings", exact: true });
  return (group ? nav.getByRole("group", { name: group, exact: true }) : nav).getByRole("link", {
    name,
    exact: true,
  });
}
export async function accountMenu(page: Page) {
  const trigger = page.locator("[data-account-menu]");
  if (!(await trigger.isVisible()))
    await page.getByRole("button", { name: "Toggle Sidebar", exact: true }).click();
  await trigger.click();
}
export async function signOut(page: Page) {
  await accountMenu(page);
  await page.getByRole("menuitem", { name: "Sign out", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Sign in", exact: true })).toBeVisible();
}
export async function expand(page: Page, label: string) {
  const trigger = page.getByRole("button", { name: label, exact: true });
  if ((await trigger.getAttribute("aria-expanded")) !== "true") await trigger.click();
}

export function ticketRows(page: Page) {
  return page.getByRole("table", { name: "Tickets", exact: true }).locator("tbody tr.ticket-row");
}

// Mounted rows are a window; completeness is the list's translated logical count.
export async function expectTicketCount(page: Page, count: number) {
  await expect(page.locator("footer")).toHaveText(t("ticket.list.count", { count, lng: "en-US" }));
}
export async function setProperty(scope: Page | Locator, label: string, option: string) {
  await scope.getByRole("combobox", { name: label, exact: true }).click();
  const page = "page" in scope ? scope.page() : scope;
  await page.getByRole("option", { name: option, exact: true }).click();
}
export async function addAcceptanceCriteria(page: Page, text: string) {
  const reveal = page.getByRole("button", { name: "Add acceptance criteria", exact: true });
  if (await reveal.isVisible()) await reveal.click();
  await page.getByLabel("Acceptance criteria", { exact: true }).fill(text);
}
// Search fields start folded as a magnifying glass; open one and return its input.
export async function openSearch(page: Page, label: string) {
  await page.getByRole("button", { name: label, exact: true }).click();
  return page.getByRole("searchbox", { name: label, exact: true });
}
export async function toggleDisplay(page: Page, option: string) {
  await page.getByRole("button", { name: option, exact: true }).click();
}
// The project list layout lives in the Display popover.
export async function setLayout(page: Page, layout: "List" | "Board" | "Calendar" | "Timeline") {
  await page.getByRole("button", { name: "Display", exact: true }).click();
  await toggleDisplay(page, layout);
  await page.keyboard.press("Escape");
}
// Holds matching requests until the returned function releases them, so a spec can check a
// pending state without waiting out a fixed delay.
export async function holdRequests(
  page: Page,
  url: Parameters<Page["route"]>[0],
  when: (request: Request) => boolean = () => true,
) {
  let release: (() => void) | undefined;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route(url, async (route) => {
    if (when(route.request())) await held;
    await route.fallback();
  });
  return () => release?.();
}
declare global {
  interface Window {
    motion?: string[];
  }
}
// The mobile sidebar is a sheet whose popup carries the sidebar slot.
const animated = ["sheet-content", "sheet-overlay", "sidebar", "sidebar-gap", "sidebar-container"];
// Records every transition the sheet and sidebar primitives run, as "slot property phase", where
// phase is exit while a sheet carries its ending style. Content that mounts or unmounts in its
// final state records nothing. Call it again after a navigation that reloads the page.
export async function recordMotion(page: Page) {
  await page.evaluate((slots) => {
    window.motion = [];
    document.addEventListener(
      "transitionrun",
      ({ target, propertyName }) => {
        if (!(target instanceof Element)) return;
        const slot = target.getAttribute("data-slot");
        if (!slot || !slots.includes(slot)) return;
        const phase = target.hasAttribute("data-ending-style") ? "exit" : "enter";
        window.motion?.push(`${slot} ${propertyName} ${phase}`);
      },
      true,
    );
  }, animated);
}
// Waits until the recorded motion includes each run and those transitions have finished, then
// starts a fresh record. A sheet closed within moments of opening skips its exit.
export async function expectMotion(page: Page, runs: string[]) {
  await expect
    .poll(() => page.evaluate(() => window.motion ?? []))
    .toEqual(expect.arrayContaining(runs));
  await expect
    .poll(() =>
      page.evaluate(
        (slots) =>
          document
            .getAnimations()
            .some(
              ({ effect }) =>
                effect instanceof KeyframeEffect &&
                slots.includes(effect.target?.getAttribute("data-slot") ?? ""),
            ),
        animated,
      ),
    )
    .toBe(false);
  await page.evaluate(() => window.motion?.splice(0));
}
// The shared sheet's slide and fade, in or out, with its backdrop.
export function sheetMotion(phase: "enter" | "exit", slot = "sheet-content") {
  return [
    `${slot} opacity ${phase}`,
    `${slot} translate ${phase}`,
    `sheet-overlay opacity ${phase}`,
  ];
}

// Account query snapshots use IndexedDB; preferences and drafts still use localStorage.
export function privateCache(page: Page, key?: string) {
  return page.evaluate(
    (name) =>
      new Promise<string>((resolve, reject) => {
        const request = indexedDB.open("kanvil-private-cache", 1);
        request.addEventListener("success", () => {
          const db = request.result;
          if (!db.objectStoreNames.contains("clients")) {
            db.close();
            resolve("");
            return;
          }
          const store = db.transaction("clients").objectStore("clients");
          const read = name === undefined ? store.getAll() : store.get(name);
          read.addEventListener("success", () => {
            db.close();
            resolve(JSON.stringify(read.result) ?? "");
          });
          read.addEventListener("error", () => {
            db.close();
            reject(read.error);
          });
        });
        request.addEventListener("error", () => reject(request.error));
      }),
    key,
  );
}
