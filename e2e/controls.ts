import { expect, type Page } from "@playwright/test";

export async function choose(page: Page, label: string, option: string) {
  await page.getByRole("combobox", { name: label, exact: true }).click();
  await page.getByRole("option", { name: option, exact: true }).click();
}
export async function appearance(page: Page, option: string) {
  await page.getByRole("button", { name: "Appearance", exact: true }).click();
  await page.getByRole("menuitemradio", { name: option, exact: true }).click();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("menu")).toHaveCount(0);
}
export async function signOut(page: Page) {
  if ((page.viewportSize()?.width ?? 1440) < 768)
    await page.getByRole("button", { name: "Toggle Sidebar", exact: true }).click();
  await page.getByRole("button", { name: /Test Owner/ }).click();
  await page.getByRole("menuitem", { name: "Sign out", exact: true }).click();
}
export async function expand(page: Page, label: string) {
  const trigger = page.getByRole("button", { name: label, exact: true });
  if ((await trigger.getAttribute("aria-expanded")) !== "true") await trigger.click();
}
