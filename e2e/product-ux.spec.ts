import { test, expect } from "@playwright/test";
import { signIn, ownerPassword, useEmailLogin } from "./auth.ts";
import { choose, expand } from "./controls.ts";

test("ticket writing, parent selection, inline properties, and contextual actions work without raw IDs", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await signIn(page);
  const project = await (
    await page.request.post("/api/v1/projects", { data: { key: "TASK", name: "Workflow design" } })
  ).json();
  const parent = await (
    await page.request.post(`/api/v1/projects/${project.id}/tickets`, {
      data: { title: "Parent work with a complete, readable title" },
    })
  ).json();
  await page.goto(`/projects/${project.id}`);
  await page.getByRole("button", { name: "New ticket", exact: true }).click();
  await page
    .getByLabel("Title", { exact: true })
    .fill("Write a useful ticket before choosing optional properties");
  await page
    .getByLabel("Description", { exact: true })
    .fill("## Requirements\nThe writing area comes first.");
  await page
    .getByLabel("Acceptance criteria", { exact: true })
    .fill("- [ ] A title is enough to start.");
  const writing = await page.getByLabel("Description", { exact: true }).boundingBox(),
    status = await page.getByRole("combobox", { name: "Status", exact: true }).boundingBox();
  expect(writing && status).toBeTruthy();
  expect(writing?.x).toBeLessThan(status?.x ?? 0);
  await page.getByLabel("Labels", { exact: true }).fill("workflow, ux");
  await page.getByLabel("Labels", { exact: true }).press("Enter");
  await expect(page.getByRole("button", { name: "Remove labels ux", exact: true })).toBeVisible();
  await expand(page, "More properties");
  await page.getByRole("combobox", { name: "Parent ticket", exact: true }).click();
  await page.getByRole("combobox", { name: "Search parent ticket", exact: true }).fill(parent.key);
  await page.getByRole("option", { name: new RegExp(parent.title) }).click();
  await page.getByLabel("Description", { exact: true }).press("ControlOrMeta+Enter");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  const rows = await (
      await page.request.get(`/api/v1/projects/${project.id}/tickets`, {
        params: { q: "Write a useful ticket" },
      })
    ).json(),
    ticket = rows.items[0];
  expect(ticket.parentId).toBe(parent.id);
  expect(ticket.labels).toEqual(["workflow", "ux"]);
  await page.getByRole("link", { name: ticket.title, exact: true }).click();
  await expect(page.getByRole("heading", { name: ticket.title, exact: true })).toBeVisible();
  await choose(page, "Priority", "High");
  await expect
    .poll(
      async () =>
        (
          await (
            await page.request.get(`/api/v1/projects/${project.id}/tickets/${ticket.id}`)
          ).json()
        ).ticket.priority,
    )
    .toBe("high");
  await expect(page.getByRole("button", { name: "Delete ticket", exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Ticket actions", exact: true }).click();
  await expect(page.getByRole("menuitem", { name: "Delete ticket", exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  await page.getByRole("tab", { name: "Activity", exact: true }).click();
  await expect(page.getByText("Ticket created", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Previous activity", exact: true })).toHaveCount(0);
  await page.getByRole("tab", { name: "Discussion", exact: true }).click();
  await expect(page.getByRole("button", { name: "Previous comments", exact: true })).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("overview pages expose actions instead of permanent forms and preserve failed edits", async ({
  page,
}) => {
  await signIn(page);
  await page.goto("/settings?section=account");
  await expect(page.getByRole("heading", { name: "Profile", exact: true })).toBeVisible();
  await expect(page.locator("#main form")).toHaveCount(0);
  await page.getByRole("button", { name: "Edit profile", exact: true }).click();
  await page.getByLabel("Display name", { exact: true }).fill("Unsaved name");
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(page.getByText("Unsaved name", { exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Change password", exact: true }).click();
  await page.getByLabel("Current password", { exact: true }).fill(ownerPassword);
  await page.getByLabel("New password", { exact: true }).fill("New test password 234!");
  await page
    .getByLabel("Confirm new password", { exact: true })
    .fill("Different test password 234!");
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Change password", exact: true })
    .click();
  await expect(page.getByRole("alert")).toContainText("do not match");
  await expect(page.getByLabel("New password", { exact: true })).toHaveValue(
    "New test password 234!",
  );
  await page.getByRole("button", { name: "Show new password", exact: true }).click();
  await expect(page.getByLabel("New password", { exact: true })).toHaveAttribute("type", "text");
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await page.goto("/admin?section=storage");
  await expect(page.getByRole("heading", { name: "File storage", exact: true })).toBeVisible();
  await expect(page.locator("#main form")).toHaveCount(0);
  await page.getByRole("button", { name: "Configure storage", exact: true }).click();
  await choose(page, "Storage provider", "S3-compatible object storage");
  await page.getByLabel("Bucket", { exact: true }).fill("not-saved");
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await page.getByRole("tab", { name: "General", exact: true }).click();
  await page.getByRole("button", { name: "Edit instance", exact: true }).click();
  const current = await page.getByLabel("Instance name", { exact: true }).inputValue();
  await page.getByLabel("Instance name", { exact: true }).fill(current);
  await page.getByRole("button", { name: "Save instance settings", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.getByText("Instance settings saved", { exact: true })).toBeVisible();
});

test("readers see readable ticket content without mutation controls", async ({ page, browser }) => {
  await signIn(page);
  const project = await (
      await page.request.post("/api/v1/projects", {
        data: { key: "READUX", name: "Reader experience" },
      })
    ).json(),
    ticket = await (
      await page.request.post(`/api/v1/projects/${project.id}/tickets`, {
        data: { title: "Readable without editing permissions" },
      })
    ).json();
  const email = `reader-${crypto.randomUUID()}@example.test`,
    password = "Isolated reader password 234!";
  expect(
    (
      await page.request.post("/api/auth/admin/create-user", {
        headers: { Origin: new URL(page.url()).origin },
        data: { email, password, name: "Read only reviewer", role: "user" },
      })
    ).ok(),
  ).toBe(true);
  expect(
    (
      await page.request.post(`/api/v1/projects/${project.id}/members`, {
        data: { email, role: "reader" },
      })
    ).ok(),
  ).toBe(true);
  const context = await browser.newContext({ baseURL: new URL(page.url()).origin });
  try {
    const reader = await context.newPage();
    await reader.goto("/login");
    await expect(reader.getByRole("heading", { name: "Sign in", exact: true })).toBeVisible();
    await useEmailLogin(reader);
    await reader.getByLabel("Email", { exact: true }).fill(email);
    await reader.getByLabel("Password", { exact: true }).fill(password);
    await reader.getByRole("button", { name: "Sign in", exact: true }).click();
    await expect(reader.getByRole("heading", { name: "Projects", exact: true })).toBeVisible();
    await reader.goto(`/projects/${project.id}/tickets/${ticket.id}`);
    await expect(reader.getByRole("heading", { name: ticket.title, exact: true })).toBeVisible();
    await expect(reader.getByRole("button", { name: "Edit ticket", exact: true })).toBeDisabled();
    await expect(reader.getByRole("combobox", { name: "Status", exact: true })).toBeDisabled();
    await expect(reader.getByRole("button", { name: "Attach file", exact: true })).toHaveCount(0);
    await expect(reader.getByRole("button", { name: "Add relationship", exact: true })).toHaveCount(
      0,
    );
    await reader.getByRole("tab", { name: "Evidence", exact: true }).click();
    await expect(reader.getByRole("button", { name: "Add evidence", exact: true })).toHaveCount(0);
    await reader.getByRole("tab", { name: "Discussion", exact: true }).click();
    await expect(reader.getByRole("textbox", { name: "Comment", exact: true })).toHaveCount(0);
  } finally {
    await context.close();
  }
});

test("inbox shows ticket context and supports unread review", async ({ page }) => {
  await signIn(page);
  const project = await (
      await page.request.post("/api/v1/projects", {
        data: { key: "INBOXUX", name: "Inbox context" },
      })
    ).json(),
    ticket = await (
      await page.request.post(`/api/v1/projects/${project.id}/tickets`, {
        data: { title: "Reconnect an interrupted worker without losing its current ownership" },
      })
    ).json();
  await page.request.post(`/api/v1/projects/${project.id}/tickets/${ticket.id}/subscription`, {
    data: { enabled: true },
  });
  const key = await (
    await page.request.post("/api/v1/credentials", {
      data: { name: "Inbox fixture", projectIds: [project.id], scopes: ["read", "write"] },
    })
  ).json();
  expect(
    (
      await page.request.post(`/api/v1/projects/${project.id}/tickets/${ticket.id}/comments`, {
        headers: { Authorization: `Bearer ${key.key}` },
        data: { body: "The worker has resumed from its last durable cursor." },
      })
    ).ok(),
  ).toBe(true);
  await page.goto("/inbox");
  await expect(page.getByRole("link", { name: new RegExp(ticket.title) })).toBeVisible();
  await expect(
    page.getByText(new RegExp(`Inbox context.*${ticket.key}.*Comment added`)),
  ).toBeVisible();
  await page.getByRole("link", { name: new RegExp(ticket.title) }).click();
  await expect(page.getByRole("heading", { name: ticket.title, exact: true })).toBeVisible();
  await page.goto("/inbox");
  await expect(page.getByRole("link", { name: new RegExp(ticket.title) })).toHaveCount(0);
  await page.getByRole("tab", { name: "All notifications", exact: true }).click();
  await expect(page.getByRole("link", { name: new RegExp(ticket.title) })).toBeVisible();
  await page.request.delete(`/api/v1/credentials/${key.id}`);
});

test("an in-flight ticket save cannot be dismissed or submit twice", async ({ page }) => {
  await signIn(page);
  const project = await (
    await page.request.post("/api/v1/projects", { data: { key: "PENDING", name: "Pending save" } })
  ).json();
  let release: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route(`**/api/v1/projects/${project.id}/tickets`, async (route) => {
    if (route.request().method() === "POST") await gate;
    await route.continue();
  });
  try {
    await page.goto(`/projects/${project.id}`);
    await page.getByRole("button", { name: "New ticket", exact: true }).click();
    await page.getByLabel("Title", { exact: true }).fill("Keep the save result visible");
    await page.getByRole("button", { name: "Save ticket", exact: true }).click();
    await expect(page.getByRole("button", { name: "Saving…", exact: true })).toBeDisabled();
    await expect(page.getByRole("button", { name: "Close", exact: true })).toHaveCount(0);
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toBeVisible();
    release?.();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(
      page.getByRole("link", { name: "Keep the save result visible", exact: true }),
    ).toBeVisible();
    const list = await (await page.request.get(`/api/v1/projects/${project.id}/tickets`)).json();
    expect(list.total).toBe(1);
  } finally {
    release?.();
    await page.unrouteAll({ behavior: "wait" });
  }
});

test("phone settings keep navigation, key actions, and user administration in view", async ({
  page,
}) => {
  await signIn(page);
  const project = await (
    await page.request.post("/api/v1/projects", {
      data: { key: "MOBILEUX", name: "Mobile settings review" },
    })
  ).json();
  const credential = await (
    await page.request.post("/api/v1/credentials", {
      data: { name: "Phone review key", projectIds: [project.id], scopes: ["read", "write"] },
    })
  ).json();
  await page.setViewportSize({ width: 320, height: 844 });
  await page.goto("/settings?section=account");
  await choose(page, "Settings section", "API keys");
  const keyRow = page.getByRole("row", { name: /Phone review key/ });
  await expect(keyRow).toContainText("Mobile settings review");
  const revoke = keyRow.getByRole("button", { name: "Revoke API key", exact: true });
  await expect(revoke).toBeVisible();
  const bounds = await revoke.boundingBox();
  expect(bounds && bounds.x >= 0 && bounds.x + bounds.width <= 320).toBeTruthy();
  expect(await keyRow.evaluate((row) => row.scrollWidth > row.clientWidth)).toBe(false);
  await choose(page, "Settings section", "Profile & security");
  await expect(page.getByRole("button", { name: "Edit profile", exact: true })).toBeVisible();
  await page.goto("/admin?section=users");
  await page.getByRole("button", { name: "New user", exact: true }).click();
  const email = `phone-${crypto.randomUUID()}@example.test`;
  await page.getByLabel("Name", { exact: true }).fill("Phone review user");
  await page.getByLabel("Email", { exact: true }).fill(email);
  await page.getByLabel("Initial password", { exact: true }).fill("Phone review password 234!");
  await page.getByRole("button", { name: "Create account", exact: true }).click();
  const accountPanel = page.getByRole("dialog", { name: "Phone review user", exact: true });
  await expect(accountPanel).toBeVisible();
  await accountPanel.getByRole("button", { name: "Close", exact: true }).click();
  await expect(accountPanel).toHaveCount(0);
  const userRow = page.getByRole("row", { name: new RegExp(email) });
  await expect(userRow).toBeVisible();
  const disable = await userRow
    .getByRole("button", { name: "Manage Phone review user", exact: true })
    .boundingBox();
  expect(disable && disable.x >= 0 && disable.x + disable.width <= 320).toBeTruthy();
  await page.getByLabel("Search users", { exact: true }).fill("no-such-user@example.invalid");
  await expect(page.getByText("No matching users", { exact: true })).toBeVisible();
  await page.request.delete(`/api/v1/credentials/${credential.id}`);
});

test("long ticket drafts have growing document fields, an expanded view, and reachable save actions", async ({
  page,
}) => {
  await signIn(page);
  await page.setViewportSize({ width: 1440, height: 1000 });
  const project = await (
    await page.request.post("/api/v1/projects", {
      data: { key: "WRITING", name: "Long-form ticket writing" },
    })
  ).json();
  await page.goto(`/projects/${project.id}`);
  await page.getByRole("button", { name: "New ticket", exact: true }).click();
  const dialog = page.getByRole("dialog"),
    description = page.getByLabel("Description", { exact: true }),
    criteria = page.getByLabel("Acceptance criteria", { exact: true });
  const normal = await dialog.boundingBox();
  expect(normal?.width).toBeGreaterThanOrEqual(1200);
  expect((await description.boundingBox())?.height).toBeGreaterThanOrEqual(280);
  await page
    .getByLabel("Title", { exact: true })
    .fill("Keep a detailed implementation brief readable while writing");
  const paragraph =
    "Ownership must survive reconnects without creating a second claimant. Keep the previous acceptance receipt, explain any conflicting write, and let a reviewer follow the complete handoff history before approving a retry.";
  const body = Array.from(
    { length: 18 },
    (_, i) => `## Scenario ${i + 1}\n\n${paragraph} ${paragraph}`,
  ).join("\n\n");
  await description.fill(body);
  const bounds = await description.boundingBox();
  expect(bounds?.height).toBeGreaterThan(600);
  expect(await description.evaluate((field) => field.scrollHeight <= field.clientHeight + 2)).toBe(
    true,
  );
  const editor = page.getByRole("group", { name: "Description editor", exact: true });
  await editor.getByRole("tab", { name: "Preview", exact: true }).click();
  await expect(editor.getByRole("heading", { name: "Scenario 18", exact: true })).toBeAttached();
  await editor.getByRole("tab", { name: "Write", exact: true }).click();
  await page.getByRole("button", { name: "Expand composer", exact: true }).click();
  expect((await dialog.boundingBox())?.width).toBeGreaterThan(normal?.width ?? 0);
  await expect(description).toHaveValue(body);
  await page.getByRole("button", { name: "Restore composer size", exact: true }).click();
  await expect(description).toHaveValue(body);
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await page.getByRole("button", { name: "New ticket", exact: true }).click();
  await expect(description).toHaveValue(body);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect.poll(async () => Math.round((await dialog.boundingBox())?.width ?? 0)).toBe(390);
  expect(await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  await criteria.fill(
    "- [ ] Long descriptions remain readable.\n- [ ] Drafts survive closing and reopening.",
  );
  const save = page.getByRole("button", { name: "Save ticket", exact: true });
  await expect(save).toBeInViewport();
  await criteria.press("ControlOrMeta+Enter");
  await expect(dialog).toHaveCount(0);
  const tickets = await (await page.request.get(`/api/v1/projects/${project.id}/tickets`)).json();
  expect(tickets.items).toHaveLength(1);
  expect(tickets.items[0].description).toBe(body);
  expect(tickets.items[0].acceptanceCriteria).toContain("Drafts survive closing and reopening.");
});
