import { expect, test } from "@playwright/test";
import { signIn } from "./auth.ts";
import { choose } from "./controls.ts";

test("administrators define custom fields that the composer, list, filters, and detail share", async ({
  page,
}) => {
  await signIn(page);
  const project = await (
    await page.request.post("/api/v1/projects", { data: { key: "FIELDS", name: "Field work" } })
  ).json();
  await page.request.post(`/api/v1/projects/${project.id}/custom-fields`, {
    data: { name: "Blocked", type: "checkbox" },
  });

  await page.goto(`/projects/${project.id}/settings?section=fields`);
  await page.getByRole("button", { name: "New field", exact: true }).click();
  const editor = page.getByRole("dialog", { name: "New field", exact: true });
  await editor.getByLabel("Field name", { exact: true }).fill("Severity");
  for (const [index, name] of ["High", "Low"].entries()) {
    await editor.getByRole("button", { name: "Add option", exact: true }).click();
    await editor.getByLabel(`Option ${index + 1}`, { exact: true }).fill(name);
  }
  await editor.getByRole("checkbox", { name: "Required", exact: true }).check();
  await choose(page, "Default", "Low");
  await editor.getByRole("button", { name: "Save field", exact: true }).click();
  await expect(editor).toHaveCount(0);
  await expect(page.getByText("Select · Required · Default Low", { exact: true })).toBeVisible();
  // Severity was added last; moving it up puts it before Blocked everywhere.
  await page.getByRole("button", { name: "Move Severity up", exact: true }).click();
  await expect(page.getByRole("button", { name: "Move Severity up", exact: true })).toBeDisabled();

  await page.goto(`/projects/${project.id}`);
  await page.getByRole("button", { name: "New ticket", exact: true }).click();
  const composer = page.getByRole("dialog");
  await composer.getByLabel("Title", { exact: true }).fill("Checkout fails for guests");
  // A new ticket shows the default until the author picks another value.
  const severity = composer.getByRole("combobox", { name: "Severity", exact: true });
  await expect(severity).toContainText("Low");
  await choose(page, "Severity", "High");
  await expect(severity).toContainText("High");
  await composer.getByRole("button", { name: "Create ticket", exact: true }).click();
  await expect(composer).toHaveCount(0);

  // Field columns start hidden; the Display menu shows them.
  await page.getByRole("button", { name: "Display", exact: true }).click();
  await page.getByRole("checkbox", { name: "Severity", exact: true }).check();
  await page.keyboard.press("Escape");
  const row = page.locator(".ticket-row", { hasText: "Checkout fails for guests" });
  await expect(row.getByRole("combobox", { name: "Severity", exact: true })).toContainText("High");
  await page.request.post(`/api/v1/projects/${project.id}/tickets`, {
    data: { title: "Typo on the landing page" },
  });
  await expect(page.locator(".ticket-row")).toHaveCount(2);
  await page.getByRole("button", { name: "Filters", exact: true }).click();
  await choose(page, "Field", "Severity: High");
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
  await expect(page).toHaveURL(/customField=/);
  await expect(page.locator(".ticket-row")).toHaveCount(1);
  await expect(page.getByRole("button", { name: /Field: Severity: High/ })).toBeVisible();

  await row.getByRole("link", { name: "Checkout fails for guests", exact: true }).click();
  const properties = page.getByRole("region", { name: "Properties", exact: true });
  await expect(properties.getByRole("combobox", { name: "Severity", exact: true })).toContainText(
    "High",
  );
  const blocked = properties.getByRole("checkbox", { name: "Blocked", exact: true });
  await expect(blocked).toHaveAttribute("aria-checked", "false");
  await blocked.click();
  await expect(blocked).toHaveAttribute("aria-checked", "true");
  await page.reload();
  await expect(
    page
      .getByRole("region", { name: "Properties", exact: true })
      .getByRole("checkbox", { name: "Blocked", exact: true }),
  ).toHaveAttribute("aria-checked", "true");
});
