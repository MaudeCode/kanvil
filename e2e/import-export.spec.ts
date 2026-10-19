import { readFile } from "node:fs/promises";
import { expect, test } from "@playwright/test";
import { signIn } from "./auth.ts";

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
  await dialog.getByLabel("Export file", { exact: true }).setInputFiles(path);
  await expect(dialog.getByLabel("Project name", { exact: true })).toHaveValue("Export source");
  // The source still holds its prefix, so the preview blocks the import until it changes.
  await submit.click();
  const preview = dialog.getByRole("region", { name: "Import preview", exact: true });
  await expect(preview.getByText("EXPORTS is in use or reserved by another project")).toBeVisible();
  await expect(submit).toBeDisabled();
  await dialog.getByLabel("Ticket prefix", { exact: true }).fill("IMPORTED");
  await submit.click();
  await expect(preview.getByText("Tickets", { exact: true })).toBeVisible();
  await expect(preview.getByText("Not in the file: activity", { exact: false })).toBeVisible();
  await dialog.getByRole("button", { name: "Import", exact: true }).click();
  await expect(dialog.getByRole("status")).toHaveText(/^Imported · \d+ of \d+ records$/, {
    timeout: 20_000,
  });
  await dialog.getByRole("link", { name: "Open project", exact: true }).click();
  await expect(page.getByRole("link", { name: /Carry this ticket over/ }).first()).toBeVisible();

  await page.goto(`/workspaces/${project.workspaceId}/settings`);
  await expect(page.getByText(/^Imported · \d+ of \d+ records/)).toBeVisible();
});
