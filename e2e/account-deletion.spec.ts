import { expect, test } from "./test.ts";
import { signIn, useEmailLogin } from "./auth.ts";

test("deletes accounts from settings and the admin panel while ticket history stays", async ({
  page,
  browser,
}) => {
  await signIn(page);
  const origin = new URL(page.url()).origin,
    password = "Account deletion password 234!";
  for (const [email, name] of [
    ["riley@leaving.test", "Riley Leaving"],
    ["sam@leaving.test", "Sam Departed"],
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
      data: { name: "Leaving workspace", slug: "leaving-workspace" },
    })
  ).json();
  await page.request.post(`/api/v1/workspaces/${workspace.id}/members`, {
    data: { email: "riley@leaving.test", role: "writer" },
  });
  const project = await (
    await page.request.post("/api/v1/projects", {
      data: { workspaceId: workspace.id, visibility: "workspace", key: "LEAVE", name: "Leaving" },
    })
  ).json();

  const context = await browser.newContext({ baseURL: origin });
  let ticket: { id: string };
  try {
    const riley = await context.newPage();
    await riley.goto("/login");
    await useEmailLogin(riley);
    await riley.getByLabel("Email", { exact: true }).fill("riley@leaving.test");
    await riley.getByLabel("Password", { exact: true }).fill(password);
    await riley.getByRole("button", { name: "Sign in", exact: true }).click();
    await expect(riley.getByRole("heading", { name: "Projects", exact: true })).toBeVisible();
    ticket = await (
      await riley.request.post(`/api/v1/projects/${project.id}/tickets`, {
        data: { title: "Handover notes" },
      })
    ).json();
    await riley.request.post(`/api/v1/projects/${project.id}/tickets/${ticket.id}/comments`, {
      data: { body: "Everything is documented." },
    });

    await riley.goto("/settings?section=account");
    await riley.getByRole("button", { name: "Delete account", exact: true }).click();
    const dialog = riley.getByRole("dialog", { name: "Delete Riley Leaving", exact: true });
    await expect(dialog.getByText("Name, email, and photo erased", { exact: true })).toBeVisible();
    await expect(
      dialog.getByText(/^1 ticket, 1 comment, and \d+ activity entries shown as Deleted account$/),
    ).toBeVisible();
    const submit = dialog.getByRole("button", { name: "Delete account", exact: true });
    await dialog.getByLabel("Type riley@leaving.test to confirm", { exact: true }).fill("riley");
    await expect(submit).toBeDisabled();
    await dialog
      .getByLabel("Type riley@leaving.test to confirm", { exact: true })
      .fill("Riley@Leaving.test");
    await submit.click();
    await expect(riley).toHaveURL(/\/login$/);
    expect(await (await context.request.get("/api/auth/get-session")).json()).toBeNull();
  } finally {
    await context.close();
  }

  // The shared history keeps the work and names its author as a deleted account.
  await page.goto(`/projects/${project.id}/tickets/${ticket.id}`);
  await expect(page.getByText("Everything is documented.", { exact: true })).toBeVisible();
  await expect(page.getByText("Deleted account", { exact: true }).first()).toBeVisible();
  await expect(page.getByText("Riley Leaving")).toHaveCount(0);

  // An instance administrator deletes another account from its panel.
  await page.goto("/admin?section=users");
  await expect(page.getByRole("row", { name: /riley@leaving\.test/ })).toHaveCount(0);
  await page.getByRole("button", { name: "Manage Sam Departed", exact: true }).click();
  const panel = page.getByRole("dialog", { name: "Sam Departed", exact: true });
  await panel.getByRole("button", { name: "Delete account", exact: true }).click();
  const remove = page.getByRole("dialog", { name: "Delete Sam Departed", exact: true });
  await remove
    .getByLabel("Type sam@leaving.test to confirm", { exact: true })
    .fill("sam@leaving.test");
  await remove.getByRole("button", { name: "Delete account", exact: true }).click();
  await expect(page.getByText("Sam Departed deleted", { exact: true })).toBeVisible();
  await expect(panel).toHaveCount(0);
  await expect(page.getByRole("row", { name: /sam@leaving\.test/ })).toHaveCount(0);

  // The owner sees why their own deletion is blocked before anything changes.
  await page.goto("/settings?section=account");
  await page.getByRole("button", { name: "Delete account", exact: true }).click();
  const own = page.getByRole("dialog", { name: "Delete Test Owner", exact: true });
  await expect(own.getByText(/^Transfer ownership of .*Leaving workspace/)).toBeVisible();
  await own
    .getByLabel("Type owner@example.test to confirm", { exact: true })
    .fill("owner@example.test");
  await expect(own.getByRole("button", { name: "Delete account", exact: true })).toBeDisabled();
});
