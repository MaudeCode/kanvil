import { expect, test } from "./test.ts";
import { signIn } from "./auth.ts";
import { choose } from "./controls.ts";

test("archives, restores, moves, and deletes a project from its settings", async ({ page }) => {
  await signIn(page);
  const project = await (
    await page.request.post("/api/v1/projects", {
      data: { key: "LIFECYCLE", name: "Lifecycle project" },
    })
  ).json();
  await page.request.post(`/api/v1/projects/${project.id}/tickets`, {
    data: { title: "Work that outlives a move" },
  });
  await page.request.post(`/api/v1/projects/${project.id}/calendar-feeds`, {
    data: { name: "Lifecycle feed", timeZone: "UTC" },
  });
  await page.request.post("/api/v1/workspaces", {
    data: { name: "Lifecycle destination", slug: "lifecycle-destination" },
  });

  await page.goto(`/projects/${project.id}/settings`);
  await page.getByRole("button", { name: "Archive project", exact: true }).click();
  await page
    .getByRole("alertdialog")
    .getByRole("button", { name: "Archive project", exact: true })
    .click();
  await expect(page.getByText("Project archived", { exact: true })).toBeVisible();
  await page.goto(`/projects/${project.id}`);
  const notice = page.getByRole("status").filter({ hasText: "read only" });
  await expect(notice).toBeVisible();
  const newTicket = page.getByRole("button", { name: "New ticket", exact: true });
  await expect(newTicket).toBeDisabled();
  // Feeds can still be revoked while archived; new ones cannot be shared.
  await page.goto(`/projects/${project.id}/settings?section=calendar`);
  await expect(
    page.getByRole("button", { name: "Revoke Lifecycle feed", exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "New calendar feed", exact: true })).toHaveCount(0);
  await page.goto("/");
  const archived = page.getByRole("region", { name: "Archived projects", exact: true });
  await expect(archived.getByRole("link", { name: /^Lifecycle project LIFECYCLE/ })).toBeVisible();
  await expect(
    page
      .getByRole("region", { name: "Projects", exact: true })
      .getByRole("list")
      .first()
      .getByRole("link", { name: /^Lifecycle project LIFECYCLE/ }),
  ).toHaveCount(0);
  await archived.getByRole("link", { name: /^Lifecycle project LIFECYCLE/ }).click();
  await notice.getByRole("button", { name: "Restore", exact: true }).click();
  await expect(page.getByText("Project restored", { exact: true })).toBeVisible();
  await expect(notice).toHaveCount(0);
  await expect(newTicket).toBeEnabled();

  await page.goto(`/projects/${project.id}/settings`);
  await page.getByRole("button", { name: "Move", exact: true }).click();
  const move = page.getByRole("dialog", { name: "Move Lifecycle project", exact: true });
  await choose(page, "Destination workspace", "Lifecycle destination");
  await expect(move.getByText("1, keeping their keys and links", { exact: true })).toBeVisible();
  await move.getByRole("button", { name: "Move project", exact: true }).click();
  await expect(page.getByText("Moved to Lifecycle destination", { exact: true })).toBeVisible();
  await expect(page.getByText("Lifecycle destination", { exact: true }).first()).toBeVisible();

  await page.getByRole("button", { name: "Delete project", exact: true }).click();
  const remove = page.getByRole("dialog", { name: "Delete Lifecycle project", exact: true });
  await expect(remove.getByText("Tickets", { exact: true })).toBeVisible();
  const submit = remove.getByRole("button", { name: "Delete project", exact: true });
  await expect(submit).toBeDisabled();
  await remove.getByLabel("Type LIFECYCLE to confirm", { exact: true }).fill("lifecycle");
  await submit.click();
  await expect(page.getByText("Lifecycle project deleted", { exact: true })).toBeVisible();
  await expect(page).toHaveURL(/\/$/);
  expect((await page.request.get(`/api/v1/projects/${project.id}`)).status()).toBe(404);
});
