import { expect, test } from "@playwright/test";
import { signIn } from "./auth.ts";

test("workspace search finds tickets and comments and opens their context", async ({ page }) => {
  await signIn(page);
  const token = `find${crypto.randomUUID().slice(0, 8)}`;
  const project = await (
    await page.request.post("/api/v1/projects", {
      data: { key: "SEARCHUI", name: "Search interface" },
    })
  ).json();
  await page.request.post(`/api/v1/projects/${project.id}/tickets`, {
    data: { title: `Rotate ${token} keys`, description: `Read the ${token} runbook first.` },
  });
  const closed = await (
    await page.request.post(`/api/v1/projects/${project.id}/tickets`, {
      data: { title: "Closed work", status: "done" },
    })
  ).json();
  const comment = await (
    await page.request.post(`/api/v1/projects/${project.id}/tickets/${closed.id}/comments`, {
      data: { body: `The ${token} fix shipped.` },
    })
  ).json();
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Projects", exact: true })).toBeVisible();
  await page.keyboard.press("ControlOrMeta+k");
  await page.getByRole("combobox").fill(token);
  await expect(
    page.getByRole("option", { name: new RegExp(`Rotate ${token} keys`) }),
  ).toBeVisible();
  await expect(
    page.getByRole("option", { name: new RegExp(`fix shipped.*Comment · ${closed.key}`) }),
  ).toBeVisible();
  await page.getByRole("option", { name: "See all 2 results", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Search", exact: true })).toBeVisible();
  await expect(page.getByRole("searchbox", { name: "Search workspace" })).toHaveValue(token);
  const results = page.getByRole("list", { name: "Search results", exact: true });
  await expect(results.getByRole("listitem")).toHaveCount(2);
  await expect(results.getByRole("listitem").first()).toContainText(`Read the ${token} runbook`);
  await page.getByRole("tab", { name: /Comments/ }).click();
  await expect(results.getByRole("listitem")).toHaveCount(1);
  await page.keyboard.press("j");
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(new RegExp(`/tickets/${closed.id}#comment-${comment.id}$`));
  await expect(page.locator(`#comment-${comment.id}`)).toHaveAttribute("data-linked", "true");
  await page.goto(`/search?q=missing${token}`);
  await expect(page.getByText(`No results for “missing${token}”`, { exact: true })).toBeVisible();
});
