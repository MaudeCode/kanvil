import { expect, test } from "./test.ts";
import { signIn } from "./auth.ts";
import { choose } from "./controls.ts";

test("defines a custom role, assigns it to a member, and deletes it with a reassignment", async ({
  page,
}) => {
  await signIn(page);
  const origin = new URL(page.url()).origin;
  expect(
    (
      await page.request.post("/api/auth/admin/create-user", {
        headers: { Origin: origin },
        data: {
          email: "triager@example.test",
          password: "Workspace roles password 234!",
          name: "Triager",
          role: "user",
        },
      })
    ).ok(),
  ).toBe(true);
  const workspace = await (
    await page.request.post("/api/v1/workspaces", {
      data: { name: "Roles workspace", slug: "roles-workspace" },
    })
  ).json();
  await page.request.post(`/api/v1/workspaces/${workspace.id}/members`, {
    data: { email: "triager@example.test", role: "writer" },
  });

  await page.goto(`/workspaces/${workspace.id}/settings?section=roles`);
  for (const name of ["Read only", "Can edit", "Admin"])
    await expect(page.getByText(name, { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "New role", exact: true }).click();
  const editor = page.getByRole("dialog", { name: "New role" });
  await editor.getByLabel("Role name", { exact: true }).fill("Triage");
  await editor.getByRole("checkbox", { name: "Edit tickets" }).check();
  await editor.getByRole("checkbox", { name: "Delete tickets" }).check();
  await editor.getByRole("button", { name: "Save role", exact: true }).click();
  await expect(editor).toHaveCount(0);
  await expect(page.getByText("Edit tickets · Delete tickets", { exact: true })).toBeVisible();

  await page.goto(`/workspaces/${workspace.id}/settings?section=members`);
  await choose(page, "Role for Triager", "Triage");
  await expect(page.getByRole("combobox", { name: "Role for Triager" })).toContainText("Triage");

  await page.goto(`/workspaces/${workspace.id}/settings?section=roles`);
  await expect(page.locator(".setting-row").filter({ hasText: "Triage" })).toContainText(
    "1 membership",
  );
  await page.getByRole("button", { name: "Delete role Triage", exact: true }).click();
  const removal = page.getByRole("dialog", { name: "Delete role" });
  await choose(page, "Move members to", "Can edit");
  await removal.getByRole("button", { name: "Delete role", exact: true }).click();
  await expect(removal).toHaveCount(0);
  await expect(page.getByText("Triage", { exact: true })).toHaveCount(0);

  const people = await (
    await page.request.get(`/api/v1/workspaces/${workspace.id}/members`)
  ).json();
  expect(people).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ email: "triager@example.test", role: "writer", roleId: "writer" }),
    ]),
  );
});
