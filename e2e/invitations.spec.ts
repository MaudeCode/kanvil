import { type Page } from "@playwright/test";
import { expect, test } from "./test.ts";
import { mailTo, signIn, useEmailLogin } from "./auth.ts";
import { choose } from "./controls.ts";

const password = "Invitation browser password 234!";
async function signInAs(page: Page, email: string) {
  await useEmailLogin(page);
  await page.getByLabel("Email", { exact: true }).fill(email);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
}

test("an invitation link grants its project access once to the invited account", async ({
  page,
  browser,
}) => {
  await signIn(page);
  const origin = new URL(page.url()).origin;
  const workspace = await (
    await page.request.post("/api/v1/workspaces", {
      data: { name: "Team invitations", slug: "team-invitations" },
    })
  ).json();
  await page.request.post("/api/v1/projects", {
    data: {
      workspaceId: workspace.id,
      visibility: "private",
      key: "INVITED",
      name: "Invited work",
    },
  });
  for (const [email, name] of [
    ["invitee@example.test", "Invited person"],
    ["bystander@example.test", "Bystander"],
  ])
    expect(
      (
        await page.request.post("/api/auth/admin/create-user", {
          headers: { Origin: origin },
          data: { email, password, name, role: "user" },
        })
      ).ok(),
    ).toBe(true);

  await page.goto(`/workspaces/${workspace.id}/settings?section=members`);
  await expect(page.getByText("No pending invitations", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Invite by email", exact: true }).click();
  const form = page.getByRole("dialog");
  await form.getByLabel("Email", { exact: true }).fill("Invitee@Example.test");
  await choose(page, "Access", "Selected projects");
  await form.getByRole("checkbox", { name: "Invited work", exact: true }).check();
  await form.getByRole("button", { name: "Invite", exact: true }).click();
  const sent = page.getByRole("dialog", { name: "Invitation link" });
  await expect(sent.getByText(/Emailed to invitee@example.test/)).toBeVisible();
  const link = await sent.getByRole("textbox", { name: "Invitation link" }).inputValue();
  expect(link).toMatch(/\/invite\/[\w-]{40,}$/);
  await expect.poll(() => mailTo("invitee@example.test").join()).toContain(link);
  await sent.getByRole("button", { name: "Done", exact: true }).click();
  const row = page.locator(".invitation-row").filter({ hasText: "invitee@example.test" });
  await expect(row).toContainText("Can edit · Invited work");

  const context = await browser.newContext({ baseURL: origin });
  try {
    const guest = await context.newPage();
    await guest.goto(link);
    await expect(
      guest.getByText("Sign in with the invited email address to accept the invitation."),
    ).toBeVisible();
    await signInAs(guest, "bystander@example.test");
    await expect(
      guest.getByRole("heading", { name: "Join Team invitations", exact: true }),
    ).toBeVisible();
    await expect(guest.getByText("Sign in as invitee@example.test to accept.")).toBeVisible();
    await expect(guest.getByRole("button", { name: "Accept invitation" })).toHaveCount(0);
    await guest.getByRole("button", { name: "Sign out", exact: true }).click();
    await signInAs(guest, "invitee@example.test");
    await guest.getByRole("button", { name: "Accept invitation", exact: true }).click();
    await expect(guest).toHaveURL(/\/projects\/[\w-]+(\?|$)/);
    await expect(guest.getByText("Joined Team invitations")).toBeVisible();
    await guest.goto(link);
    await expect(guest.getByText("This invitation was already accepted.")).toBeVisible();
  } finally {
    await context.close();
  }
  await page.reload();
  await expect(row).toHaveCount(0);
  await expect(page.locator(".member-row").filter({ hasText: "invitee@example.test" })).toHaveCount(
    0,
  );

  const revoked = await (
    await page.request.post(`/api/v1/workspaces/${workspace.id}/invitations`, {
      data: { email: "bystander@example.test", role: "reader" },
    })
  ).json();
  await page.reload();
  await page
    .locator(".invitation-row")
    .filter({ hasText: "bystander@example.test" })
    .getByRole("button", { name: "Revoke invitation", exact: true })
    .click();
  await page
    .getByRole("alertdialog")
    .getByRole("button", { name: "Revoke invitation", exact: true })
    .click();
  await expect(page.getByText("No pending invitations", { exact: true })).toBeVisible();
  const stale = await page.request.get(
    `/api/v1/invitations/${new URL(revoked.url).pathname.split("/").at(-1)}`,
  );
  expect((await stale.json()).status).toBe("revoked");
});
