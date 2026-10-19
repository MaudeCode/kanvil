import { expect, test } from "./test.ts";
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
  // The linked comment lands on the second page of the discussion.
  for (let index = 0; index < 50; index += 1)
    await page.request.post(`/api/v1/projects/${project.id}/tickets/${closed.id}/comments`, {
      data: { body: `Earlier note ${index + 1}` },
    });
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
  // Ticket-backed results are ticket links with the shared hover preview.
  await results.getByRole("link").first().hover();
  await expect(page.locator('[data-slot="hover-card-content"]')).toContainText(
    `Rotate ${token} keys`,
  );
  await page.getByRole("tab", { name: /Comments/ }).click();
  await expect(results.getByRole("listitem")).toHaveCount(1);
  await page.keyboard.press("j");
  await page.keyboard.press("Enter");
  // A comment result opens its ticket in the preview sheet over the results, at the comment.
  const sheet = page.getByRole("dialog", { name: "Closed work", exact: true });
  await expect(sheet).toBeVisible();
  await expect(page).toHaveURL(
    new RegExp(`/search\\?q=${token}.*type=comment.*peek=${closed.id}.*#comment-${comment.id}$`),
  );
  await expect(sheet.locator(`#comment-${comment.id}`)).toHaveAttribute("data-linked", "true");
  await page.reload();
  await expect(sheet.locator(`#comment-${comment.id}`)).toHaveAttribute("data-linked", "true");
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page).toHaveURL(new RegExp(`/search\\?q=${token}.*type=comment$`));
  await expect(results.getByRole("listitem")).toHaveCount(1);
  // The full page stays one modified click away.
  await results
    .getByRole("link")
    .first()
    .click({ modifiers: ["Shift"] });
  await expect(page.getByRole("dialog")).toHaveCount(0);
  // The palette closes before its ticket and comment results open the sheet.
  await page.keyboard.press("ControlOrMeta+k");
  await page.getByRole("combobox").fill(token);
  await page
    .getByRole("option", { name: new RegExp(`fix shipped.*Comment · ${closed.key}`) })
    .click();
  await expect(page.getByRole("dialog")).toHaveCount(1);
  await expect(sheet.locator(`#comment-${comment.id}`)).toHaveAttribute("data-linked", "true");
  await sheet.getByRole("link", { name: "Open in full page", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/projects/${project.id}/tickets/${closed.id}$`));
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Closed work", exact: true })).toBeVisible();
  await page.goto(`/search?q=missing${token}`);
  await expect(page.getByText(`No results for “missing${token}”`, { exact: true })).toBeVisible();
});
