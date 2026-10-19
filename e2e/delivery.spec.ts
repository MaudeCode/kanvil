import { createHmac } from "node:crypto";
import { test, expect } from "@playwright/test";
import { signIn } from "./auth.ts";

// Endpoints under .invalid never resolve, so the browser suite sends nothing off the machine.
test("account channels configure, test, pause, edit, and disconnect", async ({ page }) => {
  await signIn(page);
  await page.goto("/settings?section=notifications");
  await page.getByRole("button", { name: "Add channel", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Add channel" });
  await dialog.getByLabel("Name", { exact: true }).fill("Automation hook");
  await dialog.getByRole("combobox", { name: "Type" }).click();
  await page.getByRole("option", { name: "Webhook", exact: true }).click();
  await dialog.getByLabel("Endpoint URL", { exact: true }).fill("https://hooks.kanvil.invalid/in");
  await dialog.getByLabel("Signing secret (optional)", { exact: true }).fill("browser-secret");
  await dialog.getByRole("button", { name: "Save channel" }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByText("hooks.kanvil.invalid · Nothing sent yet")).toBeVisible();

  await page.getByRole("button", { name: "Send test to Automation hook" }).click();
  await expect(page.getByText("Test queued")).toBeVisible();
  await expect(page.getByText("Host not found")).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText("Failing", { exact: true })).toBeVisible();

  await page.getByRole("button", { name: "Pause Automation hook" }).click();
  await expect(page.getByText("Paused", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Edit Automation hook" }).click();
  const edit = page.getByRole("dialog", { name: "Edit channel" });
  await expect(edit.getByLabel("Signing secret (optional)", { exact: true })).toHaveAttribute(
    "placeholder",
    "Saved · leave blank to keep",
  );
  await expect(edit.getByLabel("Signing secret (optional)", { exact: true })).toHaveValue("");
  await edit.getByLabel("Name", { exact: true }).fill("Release hook");
  await edit.getByRole("button", { name: "Save channel" }).click();
  await expect(page.getByText("Release hook", { exact: true })).toBeVisible();
  await expect(page.getByText("Paused", { exact: true })).toBeVisible();

  await page.getByRole("button", { name: "Disconnect Release hook" }).click();
  await page
    .getByRole("alertdialog")
    .getByRole("button", { name: "Disconnect Release hook" })
    .click();
  await expect(page.getByText("No channels")).toBeVisible();
});

test("project destinations choose events and keep their endpoint secret", async ({ page }) => {
  await signIn(page);
  const project = await (
    await page.request.post("/api/v1/projects", { data: { key: "HOOK", name: "Destinations" } })
  ).json();
  await page.goto(`/projects/${project.id}/settings?section=integrations`);
  await page.getByRole("button", { name: "Add destination", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Add destination" });
  await dialog.getByLabel("Name", { exact: true }).fill("Team chat");
  await dialog
    .getByLabel("Incoming webhook URL", { exact: true })
    .fill("https://hooks.slack.invalid/services/T0/B0/secretpath");
  await dialog.getByRole("checkbox", { name: "Comments" }).click();
  await dialog.getByRole("button", { name: "Save destination" }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByText("hooks.slack.invalid · Nothing sent yet")).toBeVisible();
  await expect(page.getByText("secretpath")).toHaveCount(0);
  const [saved] = await (
    await page.request.get(`/api/v1/projects/${project.id}/destinations`)
  ).json();
  expect(saved).toMatchObject({ kind: "slack", secrets: ["url"], settings: {} });
  expect(saved.events).toEqual(["created", "assignment", "status"]);
});

test("repository connections keep secrets write-only and link verified pull requests", async ({
  page,
}) => {
  await signIn(page);
  const project = await (
    await page.request.post("/api/v1/projects", { data: { key: "REPO", name: "Repositories" } })
  ).json();
  const ticket = await (
    await page.request.post(`/api/v1/projects/${project.id}/tickets`, {
      data: { title: "Ship the widget" },
    })
  ).json();
  await page.goto(`/projects/${project.id}/settings?section=integrations`);
  await page.getByRole("button", { name: "Connect repository", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Connect repository" });
  await dialog.getByLabel("GitHub repository", { exact: true }).fill("acme/widgets");
  await dialog.getByLabel("Access token", { exact: true }).fill("ghp_browserTestToken");
  await dialog.getByLabel("Webhook secret", { exact: true }).fill("browser-hook-secret");
  await dialog.getByRole("combobox", { name: "Pull request merged" }).click();
  await page.getByRole("option", { name: "Done", exact: true }).click();
  await dialog.getByRole("button", { name: "Save repository" }).click();
  await expect(dialog).toBeHidden();
  // The test server's GitHub API host never resolves, so the access check reports it.
  await expect(page.getByText("Host not found")).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText("No webhook received")).toBeVisible();
  const [saved] = await (
    await page.request.get(`/api/v1/projects/${project.id}/repositories`)
  ).json();
  expect(saved).toMatchObject({ secrets: ["token", "webhookSecret"], provider: "github" });
  expect(JSON.stringify(saved)).not.toContain("ghp_browserTestToken");

  const body = JSON.stringify({
    action: "closed",
    number: 4,
    pull_request: {
      number: 4,
      html_url: "https://github.com/acme/widgets/pull/4",
      title: "Ship the widget",
      state: "closed",
      draft: false,
      merged: true,
      updated_at: "2030-01-01T10:00:00Z",
      head: { ref: `${ticket.key.toLowerCase()}-ship` },
    },
    repository: { full_name: "acme/widgets", html_url: "https://github.com/acme/widgets" },
  });
  const delivery = await page.request.post(saved.webhookUrl, {
    headers: {
      "Content-Type": "application/json",
      "X-GitHub-Event": "pull_request",
      "X-GitHub-Delivery": crypto.randomUUID(),
      "X-Hub-Signature-256": `sha256=${createHmac("sha256", "browser-hook-secret").update(body).digest("hex")}`,
    },
    data: body,
  });
  expect(delivery.status()).toBe(202);
  await page.goto(`/projects/${project.id}/tickets/${ticket.id}`);
  const links = page.getByRole("region", { name: "Links" });
  await expect(links.getByRole("link", { name: "Ship the widget #4" })).toBeVisible();
  await expect(links.getByText("Pull request · Merged", { exact: true })).toBeVisible();
  const current = await (
    await page.request.get(`/api/v1/projects/${project.id}/tickets/${ticket.id}`)
  ).json();
  expect(current.ticket.status).toBe("done");
  await page.goto(`/projects/${project.id}/settings?section=integrations`);
  await expect(page.getByText("Webhook received")).toBeVisible();
});
