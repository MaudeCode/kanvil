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
