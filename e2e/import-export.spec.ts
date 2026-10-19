import { readFile } from "node:fs/promises";
import { expect, test } from "./test.ts";
import { signIn } from "./auth.ts";
import { choose } from "./controls.ts";

// The request that stages an import preview.
const staged = (request: { method: () => string; url: () => string }) =>
  request.method() === "POST" && request.url().endsWith("/imports");

test("exports a project as JSON and imports it into a new project", async ({ page }) => {
  await signIn(page);
  const project = await (
    await page.request.post("/api/v1/projects", {
      data: { key: "EXPORTS", name: "Export source", visibility: "workspace" },
    })
  ).json();
  const parent = await (
    await page.request.post(`/api/v1/projects/${project.id}/tickets`, {
      data: { title: "Carry this ticket over", labels: ["migrated"] },
    })
  ).json();
  await page.request.post(`/api/v1/projects/${project.id}/tickets`, {
    data: { title: "And its sub-ticket", parentId: parent.id },
  });
  await page.request.post(`/api/v1/projects/${project.id}/tickets/${parent.id}/comments`, {
    data: { body: "Context worth keeping" },
  });

  await page.goto(`/projects/${project.id}/settings`);
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export JSON", exact: true }).click();
  const file = await download;
  expect(file.suggestedFilename()).toBe("EXPORTS.kanvil-tickets.json");
  const path = await file.path();
  const bundle = JSON.parse(await readFile(path, "utf8"));
  expect(bundle).toMatchObject({ format: "kanvil.tickets", version: 1 });

  await page.goto(`/workspaces/${project.workspaceId}/settings`);
  await page.getByRole("button", { name: "Import project", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Import project", exact: true });
  const submit = dialog.getByRole("button", { name: "Preview", exact: true });
  await expect(submit).toBeDisabled();
  // A file chosen while an earlier one is still being read wins, even if that read ends last.
  await page.evaluate(`File.prototype.text = function () {
    const delay = this.name === "slow.json" ? 1000 : 0;
    return new Promise((resolve) => setTimeout(resolve, delay)).then(() => new Response(this).text());
  }`);
  await dialog.getByLabel("Export file", { exact: true }).setInputFiles({
    name: "slow.json",
    mimeType: "application/json",
    buffer: Buffer.from(
      JSON.stringify({ ...bundle, project: { ...bundle.project, name: "Slow" } }),
    ),
  });
  await dialog.getByLabel("Export file", { exact: true }).setInputFiles(path);
  await page.waitForTimeout(1500);
  await expect(dialog.getByLabel("Project name", { exact: true })).toHaveValue("Export source");
  // The source still holds its prefix, so the preview blocks the import until it changes.
  await submit.click();
  const preview = dialog.getByRole("region", { name: "Import preview", exact: true });
  await expect(preview.getByText("EXPORTS is in use or reserved by another project")).toBeVisible();
  await expect(submit).toBeDisabled();
  // An edit made while a preview is pending discards that preview's answer.
  let release: (() => void) | undefined;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/imports", async (route) => {
    if (!staged(route.request())) return route.fallback();
    await held;
    return route.continue();
  });
  await dialog.getByLabel("Ticket prefix", { exact: true }).fill("STALE");
  const sent = page.waitForRequest(staged);
  await submit.click();
  await sent;
  await dialog.getByLabel("Ticket prefix", { exact: true }).fill("IMPORTED");
  const answered = page.waitForResponse((response) => staged(response.request()));
  release?.();
  await answered;
  await page.waitForTimeout(300);
  await expect(preview).toHaveCount(0);
  await expect(submit).toBeVisible();
  await page.unroute("**/imports");
  await submit.click();
  await expect(preview.getByText("Tickets", { exact: true })).toBeVisible();
  await expect(preview.getByText("Not imported: activity", { exact: false })).toBeVisible();
  await dialog.getByRole("button", { name: "Import", exact: true }).click();
  await expect(dialog.getByRole("status")).toHaveText(/^Imported · \d+ of \d+ records$/, {
    timeout: 20_000,
  });
  await dialog.getByRole("link", { name: "Open project", exact: true }).click();
  await expect(page.getByRole("link", { name: /Carry this ticket over/ }).first()).toBeVisible();

  await page.goto(`/workspaces/${project.workspaceId}/settings`);
  await expect(page.getByText(/^Imported · \d+ of \d+ records/)).toBeVisible();
});

test("connects to Linear, picks a team, and imports it with its comments", async ({ page }) => {
  await signIn(page);
  const { workspaceId } = await (
    await page.request.post("/api/v1/projects", {
      data: { key: "LINHOME", name: "Linear home", visibility: "workspace" },
    })
  ).json();
  await page.goto(`/workspaces/${workspaceId}/settings`);
  await page.getByRole("button", { name: "Import project", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Import project", exact: true });
  await choose(page, "Source", "Jira");
  // Jira Cloud asks for the account email; Data Center signs in with a token alone.
  await expect(dialog.getByLabel("Account email", { exact: true })).toBeVisible();
  await choose(page, "Jira edition", "Data Center or Server");
  await expect(dialog.getByLabel("Account email", { exact: true })).toHaveCount(0);
  await expect(dialog.getByLabel("Personal access token", { exact: true })).toBeVisible();

  await choose(page, "Source", "Linear");
  await dialog.getByLabel("API key", { exact: true }).fill("lin_api_browser_fixture");
  await dialog.getByRole("button", { name: "Connect", exact: true }).click();
  // The first team is chosen and names the project.
  await expect(dialog.getByRole("combobox", { name: "Team", exact: true })).toContainText(
    "Engineering",
  );
  await expect(dialog.getByLabel("Project name", { exact: true })).toHaveValue("Engineering");
  await expect(
    dialog.getByRole("checkbox", { name: "Include comments", exact: true }),
  ).toBeChecked();
  await dialog.getByLabel("Ticket prefix", { exact: true }).fill("LINEARENG");
  await dialog.getByRole("button", { name: "Preview", exact: true }).click();
  const preview = dialog.getByRole("region", { name: "Import preview", exact: true });
  await expect(preview.getByText("Comments", { exact: true })).toBeVisible();
  await expect(preview.getByText(/Not imported: cycles \(1\)/)).toBeVisible();
  await expect(preview.getByText(/Not imported: estimates \(1\)/)).toBeVisible();
  // Leaving comments out discards the preview; the next one says they were left out.
  await dialog.getByRole("checkbox", { name: "Include comments", exact: true }).uncheck();
  await expect(preview).toHaveCount(0);
  await dialog.getByRole("button", { name: "Preview", exact: true }).click();
  await expect(preview.getByText(/Not imported: comments\./)).toBeVisible();
  await dialog.getByRole("checkbox", { name: "Include comments", exact: true }).check();
  await dialog.getByRole("button", { name: "Preview", exact: true }).click();
  await expect(preview.getByText("Comments", { exact: true })).toBeVisible();
  await dialog.getByRole("button", { name: "Import", exact: true }).click();
  await expect(dialog.getByRole("status")).toHaveText(/^Imported · \d+ of \d+ records$/, {
    timeout: 20_000,
  });
  await dialog.getByRole("link", { name: "Open project", exact: true }).click();
  await expect(page.getByRole("link", { name: /Ship the importer/ }).first()).toBeVisible();
});

test("asks each tracker for its own connection and imports a Trello board", async ({ page }) => {
  await signIn(page);
  const { workspaceId } = await (
    await page.request.post("/api/v1/projects", {
      data: { key: "TRLHOME", name: "Trello home", visibility: "workspace" },
    })
  ).json();
  await page.goto(`/workspaces/${workspaceId}/settings`);
  await page.getByRole("button", { name: "Import project", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Import project", exact: true });
  const field = (label: string) => dialog.getByLabel(label, { exact: true });
  await choose(page, "Source", "Plane");
  for (const label of ["API URL", "Workspace slug", "API token"])
    await expect(field(label)).toBeVisible();
  await choose(page, "Source", "Kaneo");
  await expect(field("Site URL")).toBeVisible();
  await expect(field("API key")).toBeVisible();
  // PLANKA signs in with a password, or with an API key instead.
  await choose(page, "Source", "PLANKA");
  await expect(field("Username or email")).toBeVisible();
  await expect(field("Password")).toBeVisible();
  await choose(page, "Sign in with", "API key");
  await expect(field("Password")).toHaveCount(0);
  await expect(field("API key")).toBeVisible();

  await choose(page, "Source", "Trello");
  await field("API key").fill("trello-fixture-key-0123456789");
  await field("Token").fill("trello-fixture-secret-0123456789");
  await dialog.getByRole("button", { name: "Connect", exact: true }).click();
  await expect(dialog.getByRole("combobox", { name: "Board", exact: true })).toContainText(
    "Roadmap",
  );
  await expect(field("Project name")).toHaveValue("Roadmap");
  await field("Ticket prefix").fill("TRELLOMAP");
  await dialog.getByRole("button", { name: "Preview", exact: true }).click();
  const preview = dialog.getByRole("region", { name: "Import preview", exact: true });
  await expect(preview.getByText(/Not imported: attachments \(2\)/)).toBeVisible();
  await expect(preview.getByText(/Not imported: additional assignees \(1\)/)).toBeVisible();
  await dialog.getByRole("button", { name: "Import", exact: true }).click();
  await expect(dialog.getByRole("status")).toHaveText(/^Imported · \d+ of \d+ records$/, {
    timeout: 20_000,
  });
  await dialog.getByRole("link", { name: "Open project", exact: true }).click();
  await expect(page.getByRole("link", { name: /Plan the launch/ }).first()).toBeVisible();
});
