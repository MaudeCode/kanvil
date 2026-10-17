import { expect, type Locator, type Page } from "@playwright/test";

// Prefers the combobox inside the open popover or dialog, since list rows carry inline editors too.
export async function choose(page: Page, label: string, option: string) {
  const overlay = page.locator('[data-slot="popover-content"], [role="dialog"]').last();
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
