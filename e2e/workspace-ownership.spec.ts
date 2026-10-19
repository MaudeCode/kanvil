import { expect, test } from "./test.ts";
import { signIn, useEmailLogin } from "./auth.ts";

test("transfers workspace ownership and deletes the workspace from its settings", async ({
  page,
  browser,
}) => {
  await signIn(page);
  const origin = new URL(page.url()).origin,
    password = "Workspace ownership password 234!";
  for (const [email, name] of [
    ["successor@example.test", "Successor"],
    ["deputy@example.test", "Deputy"],
  ])
    expect(
      (
        await page.request.post("/api/auth/admin/create-user", {
          headers: { Origin: origin },
          data: { email, password, name, role: "user" },
        })
      ).ok(),
    ).toBe(true);
  const workspace = await (
    await page.request.post("/api/v1/workspaces", {
      data: { name: "Owned workspace", slug: "owned-workspace" },
    })
  ).json();
  const project = await (
    await page.request.post("/api/v1/projects", {
      data: {
        workspaceId: workspace.id,
        visibility: "workspace",
        key: "OWNED",
        name: "Owned project",
      },
    })
  ).json();
  await page.request.post(`/api/v1/projects/${project.id}/tickets`, {
    data: { title: "Work inside the owned workspace" },
  });
  for (const email of ["successor@example.test", "deputy@example.test"])
    await page.request.post(`/api/v1/workspaces/${workspace.id}/members`, {
      data: { email, role: "admin" },
    });

  // Another administrator sees the owner but no transfer or deletion.
  const context = await browser.newContext({ baseURL: origin });
  try {
    const deputy = await context.newPage();
    await deputy.goto("/login");
    await useEmailLogin(deputy);
    await deputy.getByLabel("Email", { exact: true }).fill("deputy@example.test");
    await deputy.getByLabel("Password", { exact: true }).fill(password);
    await deputy.getByRole("button", { name: "Sign in", exact: true }).click();
    await expect(deputy.getByRole("heading", { name: "Projects", exact: true })).toBeVisible();
    await deputy.goto(`/workspaces/${workspace.id}/settings`);
    await expect(
      deputy.getByText("Test Owner · owner@example.test", { exact: true }),
    ).toBeVisible();
    await expect(deputy.getByRole("button", { name: "Transfer ownership" })).toHaveCount(0);
    await expect(deputy.getByRole("button", { name: "Delete workspace" })).toHaveCount(0);
  } finally {
    await context.close();
  }

  await page.goto(`/workspaces/${workspace.id}/settings`);
  await page.getByRole("button", { name: "Transfer ownership", exact: true }).click();
  const transfer = page.getByRole("dialog", { name: "Transfer ownership", exact: true });
  const submitTransfer = transfer.getByRole("button", { name: "Transfer ownership", exact: true });
  await expect(submitTransfer).toBeDisabled();
  await transfer.getByRole("combobox", { name: "New owner", exact: true }).click();
  await page.getByRole("option", { name: /^Successor/ }).click();
  await expect(transfer.getByText("Test Owner stays an administrator.")).toBeVisible();
  await submitTransfer.click();
  await expect(page.getByText("Successor now owns Owned workspace", { exact: true })).toBeVisible();
  await expect(page.getByText("Successor · successor@example.test", { exact: true })).toBeVisible();

  await page.goto(`/workspaces/${workspace.id}/settings?section=members`);
  const successor = page.locator(".member-row").filter({ hasText: "successor@example.test" });
  await expect(successor.getByText("Owner", { exact: true })).toBeVisible();
  await expect(successor.getByRole("combobox", { name: "Role for Successor" })).toBeDisabled();
  await expect(successor.getByRole("button", { name: "Remove member" })).toHaveCount(0);

  // Instance administrators can still delete any workspace.
  await page.goto(`/workspaces/${workspace.id}/settings`);
  await page.getByRole("button", { name: "Delete workspace", exact: true }).click();
  const remove = page.getByRole("dialog", { name: "Delete Owned workspace", exact: true });
  await expect(remove.getByRole("listitem").filter({ hasText: "Owned project" })).toHaveText(
    "Owned project OWNED · 1 ticket",
  );
  await expect(
    remove.getByText("3 lose access; their accounts stay", { exact: true }),
  ).toBeVisible();
  const submit = remove.getByRole("button", { name: "Delete workspace", exact: true });
  await expect(submit).toBeDisabled();
  await remove
    .getByLabel("Type owned-workspace to confirm", { exact: true })
    .fill("owned-workspace");
  await submit.click();
  await expect(page.getByText("Owned workspace deleted", { exact: true })).toBeVisible();
  await expect(page).toHaveURL(/\/$/);
  expect((await page.request.get(`/api/v1/projects/${project.id}`)).status()).toBe(404);
  expect((await page.request.get(`/api/v1/workspaces/${workspace.id}/members`)).status()).toBe(404);
});
