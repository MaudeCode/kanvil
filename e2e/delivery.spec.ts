import { createHmac } from "node:crypto";
import { expect, test } from "./test.ts";
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

test("self-managed GitLab connections validate their server and link merge requests", async ({
  page,
}) => {
  await signIn(page);
  const project = await (
    await page.request.post("/api/v1/projects", { data: { key: "GLAB", name: "GitLab" } })
  ).json();
  const ticket = await (
    await page.request.post(`/api/v1/projects/${project.id}/tickets`, {
      data: { title: "Ship the platform" },
    })
  ).json();
  await page.goto(`/projects/${project.id}/settings?section=integrations`);
  await page.getByRole("button", { name: "Connect repository", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Connect repository" });
  await dialog.getByRole("combobox", { name: "Host" }).click();
  await page.getByRole("option", { name: "GitLab", exact: true }).click();
  await dialog.getByLabel("GitLab repository", { exact: true }).fill("acme/platform/widgets");
  await dialog.getByLabel("Access token", { exact: true }).fill("glpat-browserTestToken");
  await dialog.getByLabel("Webhook secret", { exact: true }).fill("browser-gitlab-secret");
  await dialog.getByRole("combobox", { name: "Merge request merged" }).click();
  await page.getByRole("option", { name: "Done", exact: true }).click();
  // Credentials belong in the token field, never in the server URL.
  const server = dialog.getByLabel("Server URL (optional)", { exact: true });
  await server.fill("https://user:secret@gitlab.kanvil.invalid");
  await dialog.getByRole("button", { name: "Save repository" }).click();
  await expect(
    dialog.getByText("Put credentials in their own field, not in the URL"),
  ).toBeVisible();
  await server.fill("https://gitlab.kanvil.invalid/");
  await dialog.getByRole("button", { name: "Save repository" }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByText("GitLab · gitlab.kanvil.invalid")).toBeVisible();
  await expect(page.getByText("Host not found")).toBeVisible({ timeout: 20_000 });
  const [saved] = await (
    await page.request.get(`/api/v1/projects/${project.id}/repositories`)
  ).json();
  expect(saved).toMatchObject({
    provider: "gitlab",
    baseUrl: "https://gitlab.kanvil.invalid",
    repository: "acme/platform/widgets",
    secrets: ["token", "webhookSecret"],
  });
  expect(JSON.stringify(saved)).not.toContain("glpat-browserTestToken");

  const merged = (token: string) =>
    page.request.post(saved.webhookUrl, {
      headers: {
        "Content-Type": "application/json",
        "X-Gitlab-Event": "Merge Request Hook",
        "X-Gitlab-Event-UUID": crypto.randomUUID(),
        "X-Gitlab-Token": token,
      },
      data: JSON.stringify({
        object_kind: "merge_request",
        project: {
          path_with_namespace: "acme/platform/widgets",
          web_url: "https://gitlab.kanvil.invalid/acme/platform/widgets",
        },
        object_attributes: {
          iid: 9,
          url: "https://gitlab.kanvil.invalid/acme/platform/widgets/-/merge_requests/9",
          title: "Ship the platform",
          state: "merged",
          action: "merge",
          draft: false,
          source_branch: `${ticket.key.toLowerCase()}-ship`,
          updated_at: "2030-01-01 10:00:00 UTC",
        },
      }),
    });
  expect((await merged("wrong-secret")).status()).toBe(401);
  expect((await merged("browser-gitlab-secret")).status()).toBe(202);
  await page.goto(`/projects/${project.id}/tickets/${ticket.id}`);
  const links = page.getByRole("region", { name: "Links" });
  await expect(links.getByRole("link", { name: "Ship the platform #9" })).toBeVisible();
  await expect(links.getByText("Merge request · Merged", { exact: true })).toBeVisible();

  // Editing keeps the host and shows the saved server.
  await page.goto(`/projects/${project.id}/settings?section=integrations`);
  await page.getByRole("button", { name: "Edit acme/platform/widgets" }).click();
  const edit = page.getByRole("dialog", { name: "Edit repository" });
  await expect(edit.getByRole("combobox", { name: "Host" })).toHaveCount(0);
  await expect(edit.getByLabel("Server URL (optional)", { exact: true })).toHaveValue(
    "https://gitlab.kanvil.invalid",
  );
});

test("issue sync previews rules and resumes a conflicting link from the chosen side", async ({
  page,
}) => {
  await signIn(page);
  const project = await (
    await page.request.post("/api/v1/projects", { data: { key: "SYNC", name: "Issue sync" } })
  ).json();
  const label = await (
    await page.request.post(`/api/v1/workspaces/${project.workspaceId}/labels`, {
      data: { name: "synced" },
    })
  ).json();
  const connection = await (
    await page.request.post(`/api/v1/projects/${project.id}/repositories`, {
      data: {
        repository: "acme/sync",
        token: "ghp_browserSyncToken",
        webhookSecret: "sync-secret",
      },
    })
  ).json();
  await page.goto(`/projects/${project.id}/settings?section=integrations`);
  await page.getByRole("button", { name: "Issue sync for acme/sync" }).click();
  const dialog = page.getByRole("dialog", { name: "Issue sync · acme/sync" });
  await dialog.getByRole("checkbox", { name: "Import issues as tickets" }).click();
  await dialog.getByRole("button", { name: "Choose only issues with these labels" }).click();
  await page.getByRole("option", { name: "synced" }).click();
  await dialog.getByRole("button", { name: "Preview", exact: true }).click();
  const preview = dialog.getByRole("definition");
  await expect(preview).toHaveText(["0", "0", "0", "0"]);
  await dialog.getByRole("button", { name: "Apply", exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByText("Issue sync applied")).toBeVisible();

  const issue = (title: string, at: string) => ({
    number: 7,
    html_url: "https://github.com/acme/sync/issues/7",
    title,
    body: "Reported on GitHub",
    state: "open",
    labels: [{ name: label.name }],
    updated_at: at,
  });
  const deliver = async (payload: Record<string, unknown>) => {
    const body = JSON.stringify({
      ...payload,
      repository: { full_name: "acme/sync", html_url: "https://github.com/acme/sync" },
    });
    const response = await page.request.post(connection.webhookUrl, {
      headers: {
        "Content-Type": "application/json",
        "X-GitHub-Event": "issues",
        "X-GitHub-Delivery": crypto.randomUUID(),
        "X-Hub-Signature-256": `sha256=${createHmac("sha256", "sync-secret").update(body).digest("hex")}`,
      },
      data: body,
    });
    expect(response.status()).toBe(202);
  };
  await deliver({ action: "opened", issue: issue("Imported from GitHub", "2030-01-01T10:00:00Z") });
  const { items } = await (await page.request.get(`/api/v1/projects/${project.id}/tickets`)).json();
  expect(items).toMatchObject([{ title: "Imported from GitHub", labels: ["synced"] }]);
  const [ticket] = items;
  await page.request.patch(`/api/v1/projects/${project.id}/tickets/${ticket.id}`, {
    data: { expectedVersion: ticket.version, changes: { title: "Renamed in Kanvil" } },
  });
  await deliver({ action: "edited", issue: issue("Renamed on GitHub", "2030-01-01T11:00:00Z") });

  await expect(page.getByText("Changed on both sides")).toBeVisible();
  await expect(page.getByText("Needs review", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Review", exact: true }).click();
  const review = page.getByRole("dialog", { name: `Review ${ticket.key}` });
  const comparison = review.getByRole("table", { name: "Comparison" });
  await expect(comparison.getByRole("cell", { name: "Renamed in Kanvil" })).toBeVisible();
  await expect(comparison.getByRole("cell", { name: "Renamed on GitHub" })).toBeVisible();
  await review.getByRole("button", { name: "Keep GitHub" }).click();
  await expect(review).toBeHidden();
  await expect(page.getByText("Sync resumed")).toBeVisible();
  await expect(page.getByText("Changed on both sides")).toBeHidden();
  await expect(page.getByText("1 issue syncing")).toBeVisible();
  const current = await (
    await page.request.get(`/api/v1/projects/${project.id}/tickets/${ticket.id}`)
  ).json();
  expect(current.ticket.title).toBe("Renamed on GitHub");
});
