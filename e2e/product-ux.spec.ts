import { test, expect } from "@playwright/test";
import { signIn, ownerPassword, useEmailLogin } from "./auth.ts";
import {
  addAcceptanceCriteria,
  choose,
  openSearch,
  setProperty,
  settingsLink,
  toggleDisplay,
} from "./controls.ts";

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
  await addAcceptanceCriteria(page, "- [ ] A title is enough to start.");
  const title = await page.getByLabel("Title", { exact: true }).boundingBox(),
    writing = await page.getByLabel("Description", { exact: true }).boundingBox(),
    status = await page.getByRole("combobox", { name: "Status", exact: true }).boundingBox();
  expect(title && writing && status).toBeTruthy();
  expect(title?.y).toBeLessThan(status?.y ?? 0);
  expect(status?.y).toBeLessThan(writing?.y ?? 0);
  await page.getByRole("button", { name: "Edit labels", exact: true }).click();
  await page.getByLabel("Labels", { exact: true }).fill("workflow, ux");
  await page.getByLabel("Labels", { exact: true }).press("Enter");
  await expect(page.getByRole("button", { name: "Remove labels ux", exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
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
  await settingsLink(page, "General", "Administration").click();
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
        data: {
          title: "Readable without editing permissions",
          description: "- [ ] Reviewed by a writer",
        },
      })
    ).json(),
    child = await (
      await page.request.post(`/api/v1/projects/${project.id}/tickets`, {
        data: { title: "Readable child", parentId: ticket.id },
      })
    ).json();
  expect(
    (
      await page.request.post(`/api/v1/projects/${project.id}/tickets/${ticket.id}/resources`, {
        data: { url: "https://example.test/runbook", title: "Reader runbook" },
      })
    ).ok(),
  ).toBe(true);
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
    await reader.getByRole("button", { name: "Ticket actions", exact: true }).click();
    await expect(
      reader.getByRole("menuitem", { name: "Duplicate ticket", exact: true }),
    ).toBeDisabled();
    await reader.keyboard.press("Escape");
    await expect(reader.getByRole("combobox", { name: "Status", exact: true })).toBeDisabled();
    await expect(
      reader.getByRole("checkbox", { name: "Reviewed by a writer", exact: true }),
    ).toBeDisabled();
    await expect(reader.getByRole("button", { name: "Attach file", exact: true })).toHaveCount(0);
    await expect(reader.getByRole("link", { name: "Reader runbook", exact: true })).toBeVisible();
    for (const name of ["Add link", "Edit link", "Remove link"])
      await expect(reader.getByRole("button", { name, exact: true })).toHaveCount(0);
    await expect(reader.getByRole("button", { name: "Add relationship", exact: true })).toHaveCount(
      0,
    );
    await expect(
      reader.getByRole("link", { name: `${child.key} · ${child.title}`, exact: true }),
    ).toBeVisible();
    await expect(
      reader.getByRole("combobox", { name: `Status of ${child.key}`, exact: true }),
    ).toHaveCount(0);
    await reader.getByRole("tab", { name: "Evidence", exact: true }).click();
    await expect(reader.getByRole("button", { name: "Add evidence", exact: true })).toHaveCount(0);
    await reader.getByRole("tab", { name: "Discussion", exact: true }).click();
    await expect(reader.getByRole("textbox", { name: "Comment", exact: true })).toHaveCount(0);
  } finally {
    await context.close();
  }
});

test("inbox previews updates, takes replies in place, and manages its entries", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await signIn(page);
  const project = await (
    await page.request.post("/api/v1/projects", {
      data: { key: "INBOXUX", name: "Inbox context" },
    })
  ).json();
  const create = async (title: string) =>
    (await page.request.post(`/api/v1/projects/${project.id}/tickets`, { data: { title } })).json();
  const ticket = await create(
      "Reconnect an interrupted worker without losing its current ownership",
    ),
    other = await create("Rotate the worker signing key before it expires");
  const key = await (
    await page.request.post("/api/v1/credentials", {
      data: { name: "Inbox fixture", projectIds: [project.id], scopes: ["read", "write"] },
    })
  ).json();
  const agentComment = async (target: { id: string }, body: string) => {
    await page.request.post(`/api/v1/projects/${project.id}/tickets/${target.id}/subscription`, {
      data: { enabled: true },
    });
    expect(
      (
        await page.request.post(`/api/v1/projects/${project.id}/tickets/${target.id}/comments`, {
          headers: { Authorization: `Bearer ${key.key}` },
          data: { body },
        })
      ).ok(),
    ).toBe(true);
  };
  await agentComment(ticket, "The worker has resumed from its last durable cursor.");
  await agentComment(other, "The new key is staged.");
  await page.goto("/inbox");
  const entry = (title: string) => page.getByRole("button", { name: new RegExp(title) }),
    row = (title: string) => page.locator("[data-entry]").filter({ has: entry(title) });
  await expect(
    page.getByText(new RegExp(`Inbox context.*${ticket.key}.*Comment added`)),
  ).toBeVisible();
  await expect(row(ticket.title)).toHaveAttribute("data-unread", "true");

  // Selecting an entry reads its ticket beside the Inbox and marks the entry read.
  await entry(ticket.title).click();
  const sheet = page.getByRole("dialog", { name: ticket.title, exact: true });
  await expect(sheet).toBeVisible();
  await expect(
    sheet.getByText("The worker has resumed from its last durable cursor."),
  ).toBeVisible();
  await expect(page).toHaveURL(/\/inbox\?.*peek=/);

  // A failed reply keeps its draft; the retry posts it and clears the composer.
  const comments = `**/api/v1/projects/${project.id}/tickets/${ticket.id}/comments`;
  await page.route(comments, (route) =>
    route.request().method() === "POST" ? route.abort("failed") : route.continue(),
  );
  const reply = "Thanks, I will watch the next lease renewal.",
    composer = sheet.getByRole("textbox", { name: "Comment", exact: true });
  await composer.fill(reply);
  await sheet.getByRole("button", { name: "Comment", exact: true }).click();
  await expect(sheet.getByRole("alert")).toBeVisible();
  await expect(composer).toHaveValue(reply);
  await page.unroute(comments);
  await sheet.getByRole("button", { name: "Comment", exact: true }).click();
  await expect(sheet.locator("article").filter({ hasText: reply })).toBeVisible();
  await expect(composer).toHaveValue("");

  // Closing returns focus to the entry, which stays in Unread until the tab changes.
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page).not.toHaveURL(/peek=/);
  await expect(entry(ticket.title)).toBeFocused();
  await expect(row(ticket.title)).toHaveAttribute("data-unread", "false");
  await page.keyboard.press("u");
  await expect(row(ticket.title)).toHaveAttribute("data-unread", "true");
  await page.keyboard.press("u");
  await expect(row(ticket.title)).toHaveAttribute("data-unread", "false");

  // The newer entry sits above; dismissing it moves selection and focus to its neighbor.
  await page.keyboard.press("k");
  await expect(row(other.title)).toHaveAttribute("data-active", "true");
  await page.keyboard.press("Backspace");
  await expect(entry(other.title)).toHaveCount(0);
  await expect(row(ticket.title)).toHaveAttribute("data-active", "true");
  await expect(entry(ticket.title)).toBeFocused();

  // Clear read dismisses read entries; they stay gone after a reload.
  await page.getByRole("button", { name: "Clear read", exact: true }).click();
  await expect(entry(ticket.title)).toHaveCount(0);
  await page.goto("/inbox?view=all");
  await expect(page.getByRole("tab", { name: "All notifications", exact: true })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(entry(ticket.title)).toHaveCount(0);
  await expect(entry(other.title)).toHaveCount(0);

  // New updates arrive live; Mark all read empties Unread.
  await agentComment(other, "The old key is retired.");
  await expect(row(other.title)).toHaveAttribute("data-unread", "true");
  await page.getByRole("tab", { name: /^Unread/ }).click();
  await page.getByRole("button", { name: "Mark all read", exact: true }).click();
  await expect(page.getByText("No unread notifications", { exact: true })).toBeVisible();
  await page.request.delete(`/api/v1/credentials/${key.id}`);
  expect(errors).toEqual([]);
});

test("comments mention project members and mentions get their own Inbox view", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await signIn(page);
  const project = await (
    await page.request.post("/api/v1/projects", { data: { key: "MENTION", name: "Mentions" } })
  ).json();
  const ticket = await (
    await page.request.post(`/api/v1/projects/${project.id}/tickets`, {
      data: { title: "Confirm the restore drill timing" },
    })
  ).json();
  // One account joins the project; the other exists on the instance but cannot read it.
  for (const name of ["Mention reviewer", "Mention outsider"]) {
    const email = `${name.replace(" ", "-").toLowerCase()}-${crypto.randomUUID()}@example.test`;
    expect(
      (
        await page.request.post("/api/auth/admin/create-user", {
          headers: { Origin: new URL(page.url()).origin },
          data: { email, password: "Isolated mention password 234!", name, role: "user" },
        })
      ).ok(),
    ).toBe(true);
    if (name === "Mention reviewer")
      await page.request.post(`/api/v1/projects/${project.id}/members`, {
        data: { email, role: "writer" },
      });
  }
  await page.goto(`/projects/${project.id}/tickets/${ticket.id}`);
  const composer = page.getByRole("textbox", { name: "Comment", exact: true });
  await composer.pressSequentially("Can you time it, @Menti");
  const options = page.getByRole("listbox", { name: "Mention a member", exact: true });
  await expect(options.getByRole("option")).toHaveCount(1);
  await expect(options.getByRole("option", { name: /Mention reviewer/ })).toBeVisible();
  await page.keyboard.press("Enter");
  await expect(options).toHaveCount(0);
  await expect(composer).toHaveValue(/^Can you time it, \[@Mention reviewer\]\(mention:[^)]+\) $/);
  // Escape closes the suggestions and leaves the typed text alone.
  await composer.pressSequentially("and @Test");
  await expect(options).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(options).toHaveCount(0);
  await expect(composer).toHaveValue(/and @Test$/);
  await page.getByRole("button", { name: "Comment", exact: true }).click();
  const posted = page.locator("article[id^=comment-]").filter({ hasText: "Can you time it" });
  await expect(posted).toContainText("Can you time it, @Mention reviewer and @Test");
  await expect(posted.getByRole("link")).toHaveCount(0);

  // An agent's comment that mentions the owner lands under Mentions; an ordinary one does not.
  const members = await (await page.request.get(`/api/v1/projects/${project.id}/members`)).json();
  const owner = members.find((member: { name: string }) => member.name === "Test Owner");
  const key = await (
    await page.request.post("/api/v1/credentials", {
      data: { name: "Mention fixture", projectIds: [project.id], scopes: ["read", "write"] },
    })
  ).json();
  for (const body of [`[@Test Owner](mention:${owner.userId}), please confirm.`, "Unrelated"])
    await page.request.post(`/api/v1/projects/${project.id}/tickets/${ticket.id}/comments`, {
      headers: { Authorization: `Bearer ${key.key}` },
      data: { body },
    });
  await page.goto("/inbox?view=mentions");
  await expect(page.getByRole("tab", { name: "Mentions", exact: true })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  const rows = page.locator("[data-entry]").filter({ hasText: ticket.key });
  await expect(rows).toHaveCount(1);
  await expect(rows.getByRole("img", { name: "Mentions", exact: true })).toBeVisible();
  // In the preview sheet, Escape first closes the suggestions, then the sheet.
  await rows.getByRole("button", { name: new RegExp(ticket.title) }).click();
  const sheet = page.getByRole("dialog", { name: ticket.title, exact: true });
  await sheet.getByRole("textbox", { name: "Comment", exact: true }).pressSequentially("@Test");
  await expect(options).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(options).toHaveCount(0);
  await expect(sheet).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(sheet).toHaveCount(0);
  await page.getByRole("tab", { name: "All notifications", exact: true }).click();
  await expect(page.locator("[data-entry]").filter({ hasText: ticket.key })).toHaveCount(2);
  await page.request.delete(`/api/v1/credentials/${key.id}`);
  expect(errors).toEqual([]);
});

test("a deleted ticket stops showing its cached content", async ({ page }) => {
  await signIn(page);
  const project = await (
    await page.request.post("/api/v1/projects", { data: { key: "GONE", name: "Deleted work" } })
  ).json();
  const ticket = await (
    await page.request.post(`/api/v1/projects/${project.id}/tickets`, {
      data: { title: "Retire the legacy importer", description: "Private migration notes" },
    })
  ).json();
  const path = `/api/v1/projects/${project.id}/tickets/${ticket.id}`;
  await page.goto(`/projects/${project.id}/tickets/${ticket.id}`);
  const heading = page.getByRole("heading", { name: ticket.title, exact: true });
  await expect(heading).toBeVisible();
  let missing = 0;
  page.on("response", (response) => {
    if (response.status() === 404 && new URL(response.url()).pathname === path) missing += 1;
  });
  expect(
    (await page.request.delete(path, { data: { expectedVersion: ticket.version } })).ok(),
  ).toBe(true);
  // The live deletion refetches the ticket; the query's retry receives the same 404.
  await expect.poll(() => missing).toBe(2);
  await expect(heading).toHaveCount(0);
  await expect(page.getByText("Private migration notes")).toHaveCount(0);
  await expect(page.getByText("Ticket unavailable", { exact: true })).toBeVisible();
});

test("notification categories filter the Inbox and keep the reminder lead", async ({ page }) => {
  await signIn(page);
  const project = await (
      await page.request.post("/api/v1/projects", {
        data: { key: "NOTECAT", name: "Notification categories" },
      })
    ).json(),
    ticket = await (
      await page.request.post(`/api/v1/projects/${project.id}/tickets`, {
        data: { title: "Report a stalled import to the person who owns it" },
      })
    ).json();
  const key = await (
    await page.request.post("/api/v1/credentials", {
      data: { name: "Category fixture", projectIds: [project.id], scopes: ["read", "write"] },
    })
  ).json();
  try {
    await page.goto("/settings?section=notifications");
    const comments = page.getByRole("switch", { name: "Comments notifications", exact: true });
    await expect(comments).toBeChecked();
    await comments.click();
    await expect(comments).not.toBeChecked();
    const amount = page.getByLabel("Reminder amount", { exact: true });
    await amount.fill("3");
    await amount.press("Enter");
    await page.getByRole("combobox", { name: "Reminder unit", exact: true }).click();
    await page.getByRole("option", { name: "Hours", exact: true }).click();
    await expect(page.getByRole("combobox", { name: "Reminder unit" })).toHaveText(/Hours/);
    await page.reload();
    await expect(comments).not.toBeChecked();
    await expect(amount).toHaveValue("3");
    await expect(page.getByRole("combobox", { name: "Reminder unit" })).toHaveText(/Hours/);
    const worker = { Authorization: `Bearer ${key.key}` };
    await page.request.post(`/api/v1/projects/${project.id}/tickets/${ticket.id}/comments`, {
      headers: worker,
      data: { body: "The import stopped at row 4,000." },
    });
    await page.request.patch(`/api/v1/projects/${project.id}/tickets/${ticket.id}`, {
      headers: worker,
      data: { expectedVersion: ticket.version, changes: { status: "in_progress" } },
    });
    await page.goto("/inbox");
    const row = page.locator("[data-entry]").filter({ hasText: ticket.key });
    await expect(row).toHaveCount(1);
    await expect(row.getByRole("img", { name: "Status changes", exact: true })).toBeVisible();
  } finally {
    await page.request.put("/api/v1/notifications/preferences", {
      data: {
        inApp: true,
        categories: { comment: true },
        reminderLead: { amount: 1, unit: "days" },
      },
    });
    await page.request.delete(`/api/v1/credentials/${key.id}`);
  }
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
    await page.getByRole("button", { name: "Create ticket", exact: true }).click();
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
  await (await openSearch(page, "Search users")).fill("no-such-user@example.invalid");
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
  expect(normal?.width).toBeGreaterThanOrEqual(700);
  expect((await description.boundingBox())?.height).toBeGreaterThanOrEqual(200);
  await page.getByRole("button", { name: "Add acceptance criteria", exact: true }).click();
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
  await addAcceptanceCriteria(
    page,
    "- [ ] Long descriptions remain readable.\n- [ ] Drafts survive closing and reopening.",
  );
  const save = page.getByRole("button", { name: "Create ticket", exact: true });
  await expect(save).toBeInViewport();
  await criteria.press("ControlOrMeta+Enter");
  await expect(dialog).toHaveCount(0);
  const tickets = await (await page.request.get(`/api/v1/projects/${project.id}/tickets`)).json();
  expect(tickets.items).toHaveLength(1);
  expect(tickets.items[0].description).toBe(body);
  expect(tickets.items[0].acceptanceCriteria).toContain("Drafts survive closing and reopening.");
});

test("writable checklists toggle in place and Markdown fields share formatting controls", async ({
  page,
}) => {
  await signIn(page);
  const project = await (
      await page.request.post("/api/v1/projects", {
        data: { key: "CHECK", name: "Checklist editing" },
      })
    ).json(),
    ticket = await (
      await page.request.post(`/api/v1/projects/${project.id}/tickets`, {
        data: {
          title: "Toggle checklist items without opening the editor",
          description: "- [ ] Ship it\n  - [ ] Ship it\n- [x] Done",
          acceptanceCriteria: "1. [ ] Accepted",
        },
      })
    ).json();
  const read = async () =>
    (await (await page.request.get(`/api/v1/projects/${project.id}/tickets/${ticket.id}`)).json())
      .ticket;
  await page.goto(`/projects/${project.id}/tickets/${ticket.id}`);
  const nested = page.getByRole("checkbox", { name: "Ship it", exact: true }).nth(1);
  await expect(nested).toBeEnabled();
  await nested.click();
  await expect(nested).toBeChecked();
  await expect
    .poll(async () => (await read()).description)
    .toBe("- [ ] Ship it\n  - [x] Ship it\n- [x] Done");
  await expect(
    page.getByRole("checkbox", { name: "Ship it", exact: true }).first(),
  ).not.toBeChecked();
  await page.getByRole("checkbox", { name: "Accepted", exact: true }).click();
  await expect.poll(async () => (await read()).acceptanceCriteria).toBe("1. [x] Accepted");

  // A rejected write settles back to the server's text.
  await page.route(`**/api/v1/projects/${project.id}/tickets/${ticket.id}`, (route) =>
    route.request().method() === "PATCH"
      ? route.fulfill({
          status: 409,
          json: { error: { code: "version_conflict", message: "Ticket changed" } },
        })
      : route.fallback(),
  );
  const done = page.getByRole("checkbox", { name: "Done", exact: true });
  await done.click();
  await expect(page.getByText("Ticket changed", { exact: true })).toBeVisible();
  await expect(done).toBeChecked();
  await page.unrouteAll();
  expect((await read()).description).toBe("- [ ] Ship it\n  - [x] Ship it\n- [x] Done");

  const comment = page.getByRole("textbox", { name: "Comment", exact: true });
  const toolbar = page.getByRole("toolbar", { name: "Comment formatting", exact: true });
  await comment.fill("word");
  await comment.selectText();
  await toolbar.getByRole("button", { name: "Bold", exact: true }).click();
  await expect(comment).toHaveValue("**word**");
  expect(
    await comment.evaluate((field: HTMLTextAreaElement) => [
      field.selectionStart,
      field.selectionEnd,
    ]),
  ).toEqual([2, 6]);
  await comment.press("ControlOrMeta+z");
  await expect(comment).toHaveValue("word");
  await comment.selectText();
  await comment.press("ControlOrMeta+i");
  await expect(comment).toHaveValue("_word_");
  await toolbar.getByRole("button", { name: "Checklist", exact: true }).click();
  await expect(comment).toHaveValue("- [ ] _word_");
  await comment.press("End");
  await toolbar.getByRole("button", { name: "Code block", exact: true }).click();
  await expect(comment).toHaveValue("```\n- [ ] _word_\n```");
  await page.getByRole("button", { name: "Edit ticket", exact: true }).click();
  await expect(
    page.getByRole("toolbar", { name: "Description formatting", exact: true }),
  ).toBeVisible();
});

test("create more keeps one composer open across projects without mixing their drafts", async ({
  page,
}) => {
  await signIn(page);
  const create = async (key: string, name: string) =>
    (await page.request.post("/api/v1/projects", { data: { key, name } })).json();
  const alpha = await create("BATCHA", "Alpha batch"),
    beta = await create("BATCHB", "Beta batch"),
    // Never opened, so its member list is not in the persisted query cache.
    gamma = await create("BATCHC", "Gamma batch");
  const parent = await (
    await page.request.post(`/api/v1/projects/${alpha.id}/tickets`, {
      data: { title: "Alpha parent" },
    })
  ).json();
  const betaTicket = await (
    await page.request.post(`/api/v1/projects/${beta.id}/tickets`, {
      data: { title: "Beta neighbour", labels: ["beta-only"] },
    })
  ).json();
  const dialog = page.getByRole("dialog", { name: "New ticket", exact: true }),
    title = page.getByLabel("Title", { exact: true }),
    description = page.getByLabel("Description", { exact: true });

  // A draft written in one project stays with that project.
  await page.goto(`/projects/${beta.id}`);
  await page.getByRole("button", { name: "New ticket", exact: true }).click();
  await title.fill("Private beta draft");
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await page.goto(`/projects/${alpha.id}`);
  await page.getByRole("button", { name: "New ticket", exact: true }).click();
  await expect(title).toHaveValue("");
  await expect(page.getByRole("combobox", { name: "Project", exact: true })).toHaveText(
    "Alpha batch",
  );

  // Create more keeps the composer and its reusable properties after a confirmed create.
  await page.getByRole("switch", { name: "Create more", exact: true }).click();
  await choose(page, "Priority", "High");
  await page.getByRole("combobox", { name: "Parent ticket", exact: true }).click();
  await page.getByRole("combobox", { name: "Search parent ticket", exact: true }).fill(parent.key);
  await page.getByRole("option", { name: /Alpha parent/ }).click();
  await title.fill("First batch ticket");
  await description.fill("Only for the first ticket");
  await description.press("ControlOrMeta+Enter");
  await expect(dialog.getByRole("status")).toContainText("BATCHA-2 created");
  await expect(dialog).toBeVisible();
  await expect(title).toHaveValue("");
  await expect(description).toHaveValue("");
  await expect(title).toBeFocused();
  await expect(page.getByRole("combobox", { name: "Priority", exact: true })).toHaveText("High");
  await expect(page.getByRole("combobox", { name: "Parent ticket", exact: true })).toHaveText(
    parent.key,
  );

  // Switching project applies at once and holds submission until its members are checked.
  let releaseMembers: (() => void) | undefined;
  const membersGate = new Promise<void>((resolve) => {
    releaseMembers = resolve;
  });
  await page.route(`**/api/v1/projects/${gamma.id}/members`, async (route) => {
    await membersGate;
    await route.continue();
  });
  await choose(page, "Project", "Gamma batch");
  await expect(page.getByRole("combobox", { name: "Project", exact: true })).toHaveText(
    "Gamma batch",
  );
  await expect(page.getByRole("button", { name: "Create ticket", exact: true })).toBeDisabled();
  releaseMembers?.();
  await expect(page.getByRole("button", { name: "Create ticket", exact: true })).toBeEnabled();
  await page.unroute(`**/api/v1/projects/${gamma.id}/members`);
  await choose(page, "Project", "Beta batch");
  // Switching project clears its parent and loads the other project's catalogs.
  await expect(page.getByRole("combobox", { name: "Parent ticket", exact: true })).toHaveText(
    "Parent",
  );
  await page.getByRole("button", { name: "Edit labels", exact: true }).click();
  await page.getByRole("button", { name: "Choose labels", exact: true }).click();
  await expect(page.getByRole("option", { name: "beta-only", exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
  await page.getByRole("combobox", { name: "Parent ticket", exact: true }).click();
  await page.getByRole("combobox", { name: "Search parent ticket", exact: true }).fill("Beta");
  await expect(page.getByRole("option", { name: /Beta neighbour/ })).toBeVisible();
  await page.keyboard.press("Escape");

  // A failed create keeps the draft, the project, and the composer.
  await title.fill("Second batch ticket");
  let failed = false;
  await page.route(`**/api/v1/projects/${beta.id}/tickets`, async (route) => {
    if (route.request().method() !== "POST" || failed) return route.continue();
    failed = true;
    await route.fulfill({
      status: 500,
      contentType: "application/json",
      body: JSON.stringify({ error: { code: "internal", message: "Simulated outage" } }),
    });
  });
  await page.getByRole("button", { name: "Create ticket", exact: true }).click();
  await expect(dialog.getByText("Simulated outage")).toBeVisible();
  await expect(title).toHaveValue("Second batch ticket");
  await expect(page.getByRole("combobox", { name: "Project", exact: true })).toHaveText(
    "Beta batch",
  );
  await page.getByRole("button", { name: "Create ticket", exact: true }).click();
  await expect(dialog.getByRole("status")).toContainText("BATCHB-2 created");
  await page.unrouteAll({ behavior: "wait" });

  // Text typed for the next ticket while a create is still saving survives its success.
  let releaseCreate: (() => void) | undefined;
  const createGate = new Promise<void>((resolve) => {
    releaseCreate = resolve;
  });
  await page.route(`**/api/v1/projects/${beta.id}/tickets`, async (route) => {
    if (route.request().method() === "POST") await createGate;
    await route.continue();
  });
  await title.fill("Third batch ticket");
  await page.getByRole("button", { name: "Create ticket", exact: true }).click();
  await expect(page.getByRole("button", { name: "Saving…", exact: true })).toBeDisabled();
  await title.fill("Typed while saving");
  releaseCreate?.();
  await expect(dialog.getByRole("status")).toContainText("BATCHB-3 created");
  await expect(title).toHaveValue("Typed while saving");
  await page.unrouteAll({ behavior: "wait" });

  // Ordinary create still closes the composer.
  await page.getByRole("switch", { name: "Create more", exact: true }).click();
  await title.fill("Last batch ticket");
  await page.getByRole("button", { name: "Create ticket", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  const betaRows = (
    await (await page.request.get(`/api/v1/projects/${beta.id}/tickets`)).json()
  ).items.filter((ticket: { id: string }) => ticket.id !== betaTicket.id);
  expect(betaRows.map((ticket: { title: string }) => ticket.title).toSorted()).toEqual([
    "Last batch ticket",
    "Second batch ticket",
    "Third batch ticket",
  ]);
  expect(betaRows.every((ticket: { priority: string }) => ticket.priority === "high")).toBe(true);
  expect(betaRows.every((ticket: { parentId: string | null }) => !ticket.parentId)).toBe(true);
  const alphaRows = (await (await page.request.get(`/api/v1/projects/${alpha.id}/tickets`)).json())
    .items;
  expect(
    alphaRows.find((ticket: { title: string }) => ticket.title === "First batch ticket").parentId,
  ).toBe(parent.id);

  // A draft retargeted to beta reopens where it was written, without replacing beta's own draft.
  await page.getByRole("button", { name: "New ticket", exact: true }).click();
  await expect(title).toHaveValue("");
  await choose(page, "Project", "Beta batch");
  await title.fill("Retargeted draft");
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await page.getByRole("button", { name: "New ticket", exact: true }).click();
  await expect(title).toHaveValue("Retargeted draft");
  await expect(page.getByRole("combobox", { name: "Project", exact: true })).toHaveText(
    "Beta batch",
  );
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await page.goto(`/projects/${beta.id}`);
  await page.getByRole("button", { name: "New ticket", exact: true }).click();
  await expect(title).toHaveValue("Private beta draft");
});

test("home summarizes assigned work and activity, and My work lists every assigned ticket", async ({
  page,
}) => {
  await signIn(page);
  const session = await (await page.request.get("/api/auth/get-session")).json();
  const create = async (key: string, name: string) =>
    (await page.request.post("/api/v1/projects", { data: { key, name } })).json();
  const ticket = async (projectId: string, data: Record<string, unknown>) =>
    (
      await page.request.post(`/api/v1/projects/${projectId}/tickets`, {
        data: { assigneeId: session.user.id, ...data },
      })
    ).json();
  const alpha = await create("WORKALPHA", "Assigned alpha"),
    beta = await create("WORKBETA", "Assigned beta");
  // More than one 100-ticket batch, so My work must fetch every page.
  for (let index = 1; index <= 101; index++)
    await ticket(alpha.id, { title: `Alpha assignment ${index}` });
  const overdue = await ticket(beta.id, {
    title: "Beta overdue assignment",
    dueAt: new Date(Date.now() - 86_400_000).toISOString(),
  });
  await ticket(beta.id, {
    title: "Beta upcoming assignment",
    dueAt: new Date(Date.now() + 3 * 86_400_000).toISOString(),
  });
  await ticket(beta.id, { title: "Beta finished assignment", status: "done" });

  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Home", exact: true })).toBeVisible();
  const assigned = page.getByRole("region", { name: "Assigned to you" });
  await expect(assigned.getByRole("link", { name: new RegExp(overdue.title) })).toBeVisible();
  await expect(page.getByRole("region", { name: "Recent activity" })).toContainText(
    "Ticket created",
  );
  const betaRow = page
    .locator(".project-list")
    .getByRole("listitem")
    .filter({ hasText: "Assigned beta" });
  await expect(betaRow).toContainText("2 open · 1 overdue · 33% done · next due");
  await expect(
    page.locator(".project-list").getByRole("listitem").filter({ hasText: "Assigned alpha" }),
  ).toContainText("101 open · 0% done");

  await assigned.getByRole("link", { name: /in My work$/ }).click();
  await expect(page).toHaveURL(/\/my-work(\?|$)/);
  await expect(page.getByRole("heading", { name: "My work", exact: true })).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Collapse Overdue tickets", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("rowgroup", { name: "Overdue tickets" }).getByText(overdue.title),
  ).toBeVisible();
  await expect(page.getByText("Beta finished assignment")).toHaveCount(0);

  await page.getByRole("button", { name: "Display", exact: true }).click();
  await toggleDisplay(page, "Project");
  await page.keyboard.press("Escape");
  await expect(
    page.getByRole("rowgroup", { name: "Assigned alpha tickets" }).locator("tr.ticket-row"),
  ).toHaveCount(101);
  await expect(
    page.getByRole("rowgroup", { name: "Assigned beta tickets" }).locator("tr.ticket-row"),
  ).toHaveCount(2);
});

test("My work moves a ticket into Overdue when its due time passes while the page is open", async ({
  page,
}) => {
  await page.clock.install({ time: new Date() });
  await signIn(page);
  const session = await (await page.request.get("/api/auth/get-session")).json();
  const project = await (
    await page.request.post("/api/v1/projects", { data: { key: "WORKCLOCK", name: "Clock" } })
  ).json();
  const soon = await (
    await page.request.post(`/api/v1/projects/${project.id}/tickets`, {
      data: {
        title: "Due within minutes",
        assigneeId: session.user.id,
        dueAt: new Date(Date.now() + 2 * 60_000).toISOString(),
      },
    })
  ).json();
  await page.goto("/my-work");
  await expect(
    page.getByRole("rowgroup", { name: "Due today tickets" }).getByText(soon.title),
  ).toBeVisible();
  await page.clock.fastForward("05:00");
  await expect(
    page.getByRole("rowgroup", { name: "Overdue tickets" }).getByText(soon.title),
  ).toBeVisible();
});

test("ticket links are added, edited, and removed beside attachments, with remote state unknown", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await signIn(page);
  const project = await (
    await page.request.post("/api/v1/projects", { data: { key: "LINKRES", name: "Links" } })
  ).json();
  const ticket = await (
    await page.request.post(`/api/v1/projects/${project.id}/tickets`, {
      data: { title: "Track the work that lives elsewhere" },
    })
  ).json();
  await page.goto(`/projects/${project.id}/tickets/${ticket.id}`);
  const links = page.getByRole("region", { name: "Links", exact: true });
  await expect(links.getByText("No links", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Add link", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Add link", exact: true });
  await expect(dialog.getByLabel("URL", { exact: true })).toBeFocused();
  await dialog.getByLabel("URL", { exact: true }).fill("javascript:alert(1)");
  await dialog.getByRole("button", { name: "Add link", exact: true }).click();
  await expect(dialog.getByText(/Use an HTTP or HTTPS URL/)).toBeVisible();
  await dialog
    .getByLabel("URL", { exact: true })
    .fill("https://github.com/MaudeCode/kanvil/pull/9");
  await dialog.getByLabel("Title", { exact: true }).fill("Implementation PR");
  await dialog.getByRole("button", { name: "Add link", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  const link = links.getByRole("link", { name: "Implementation PR", exact: true });
  await expect(link).toHaveAttribute("href", "https://github.com/MaudeCode/kanvil/pull/9");
  await expect(link).toHaveAttribute("target", "_blank");
  await expect(links.getByText("GitHub", { exact: true })).toBeVisible();
  await expect(links.getByText("State unknown", { exact: true })).toBeVisible();

  const [resource] = await (
    await page.request.get(`/api/v1/projects/${project.id}/tickets/${ticket.id}/resources`)
  ).json();
  // Another session edits the link first, so the open form holds a stale version.
  await links.getByRole("button", { name: "Edit link", exact: true }).click();
  const edit = page.getByRole("dialog", { name: "Edit link", exact: true });
  await expect(edit.getByLabel("Title", { exact: true })).toHaveValue("Implementation PR");
  expect(
    (
      await page.request.patch(`/api/v1/projects/${project.id}/resources/${resource.id}`, {
        data: { expectedVersion: 1, title: "Edited elsewhere" },
      })
    ).ok(),
  ).toBe(true);
  await edit.getByLabel("URL", { exact: true }).fill("https://docs.example.test/runbook");
  await edit.getByLabel("Title", { exact: true }).fill("Runbook");
  await edit.getByRole("button", { name: "Save link", exact: true }).click();
  await expect(edit.getByText(/The resource changed; reload before editing/)).toBeVisible();
  await edit.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(links.getByRole("link", { name: "Edited elsewhere", exact: true })).toBeVisible();
  await links.getByRole("button", { name: "Edit link", exact: true }).click();
  await edit.getByLabel("URL", { exact: true }).fill("https://docs.example.test/runbook");
  await edit.getByLabel("Title", { exact: true }).fill("Runbook");
  await edit.getByRole("button", { name: "Save link", exact: true }).click();
  await expect(edit).toHaveCount(0);
  await expect(links.getByRole("link", { name: "Runbook", exact: true })).toBeVisible();
  await expect(links.getByText("docs.example.test", { exact: true })).toBeVisible();
  await expect(links.getByText("State unknown", { exact: true })).toHaveCount(0);

  await links.getByRole("button", { name: "Remove link", exact: true }).click();
  await page
    .getByRole("alertdialog", { name: "Remove link", exact: true })
    .getByRole("button", { name: "Remove link", exact: true })
    .click();
  await expect(links.getByText("No links", { exact: true })).toBeVisible();
  expect(errors).toEqual([]);
});

test("ticket references anywhere open one preview sheet over the page they were found on", async ({
  page,
  context,
}) => {
  await signIn(page);
  const session = await (await page.request.get("/api/auth/get-session")).json();
  const create = async (key: string, name: string) =>
    (await page.request.post("/api/v1/projects", { data: { key, name } })).json();
  const ticket = async (projectId: string, data: Record<string, unknown>) =>
    (await page.request.post(`/api/v1/projects/${projectId}/tickets`, { data })).json();
  const source = await create("PEEKHOME", "Preview source"),
    other = await create("PEEKOTHER", "Preview other");
  const parent = await ticket(source.id, {
    title: "Previewed parent work",
    assigneeId: session.user.id,
  });
  const child = await ticket(source.id, { title: "Previewed child work", parentId: parent.id });
  const elsewhere = await ticket(other.id, { title: "Work in another project" });

  await page.goto("/");
  const home = page.getByRole("heading", { name: "Home", exact: true });
  const assigned = page.getByRole("region", { name: "Assigned to you" });
  const link = assigned.getByRole("link", { name: new RegExp(parent.title) });
  // The project directory's search is local state the preview must not reset.
  await page.getByRole("button", { name: "Search projects", exact: true }).click();
  await page.getByRole("searchbox", { name: "Search projects" }).fill("Preview");
  await link.click();
  const sheet = page.getByRole("dialog", { name: parent.title, exact: true });
  await expect(sheet).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`/\\?.*peek=${parent.id}.*peekProject=${source.id}`));
  // The page below stays mounted; the modal sheet hides it from assistive technology.
  await expect(page.locator("#main h1", { hasText: "Home" })).toHaveCount(1);
  await expect(page.locator("#main input[type=search]")).toHaveValue("Preview");

  // An edit in the sheet settles the page below it.
  await setProperty(sheet, "Status", "In progress");
  await expect(
    page.locator(`#main section[aria-label="Assigned to you"] li`, { hasText: parent.title }),
  ).toContainText("In progress");

  // A reference inside the sheet replaces its ticket; one sheet stays open.
  await sheet.getByRole("link", { name: new RegExp(child.title) }).click();
  const childSheet = page.getByRole("dialog", { name: child.title, exact: true });
  await expect(childSheet).toBeVisible();
  await expect(page.getByRole("dialog")).toHaveCount(1);
  // A ticket from another project brings that project's data and permissions along.
  await page.keyboard.press("ControlOrMeta+k");
  await page.getByRole("combobox").fill("another project");
  await page.getByRole("option", { name: new RegExp(elsewhere.title) }).click();
  const otherSheet = page.getByRole("dialog", { name: elsewhere.title, exact: true });
  await expect(otherSheet).toBeVisible();
  await expect(page.getByRole("dialog")).toHaveCount(1);
  await expect(page).toHaveURL(new RegExp(`peek=${elsewhere.id}.*peekProject=${other.id}`));
  await expect(otherSheet.getByText(elsewhere.key, { exact: true })).toBeVisible();
  await expect(otherSheet.getByRole("button", { name: "Edit ticket", exact: true })).toBeEnabled();

  // Escape closes it, returns focus to the reference that opened it, and keeps Home's state.
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page).not.toHaveURL(/peek=/);
  await expect(link).toBeFocused();
  await expect(home).toBeVisible();
  await expect(page.getByRole("searchbox", { name: "Search projects" })).toHaveValue("Preview");

  // Back and Forward close and reopen it; a refresh or a copied link resolves from the URL.
  await link.click();
  await expect(sheet).toBeVisible();
  await page.goBack();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.goForward();
  await expect(sheet).toBeVisible();
  await page.reload();
  await expect(sheet).toBeVisible();
  await expect(page.locator("#main h1", { hasText: "Home" })).toHaveCount(1);
  await sheet.getByRole("button", { name: "Close preview", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page).toHaveURL(/\/$/);

  // A modified click keeps the full-page link and opens it in a new tab.
  const opened = context.waitForEvent("page");
  await link.click({ modifiers: ["ControlOrMeta"] });
  const tab = await opened;
  await tab.waitForLoadState();
  expect(new URL(tab.url()).pathname).toBe(`/projects/${source.id}/tickets/${parent.id}`);
  await tab.close();
  await expect(page.getByRole("dialog")).toHaveCount(0);

  // A ticket moved to another project is followed; one deleted settles as unavailable.
  const relocated = await page.request.post(
    `/api/v1/projects/${other.id}/tickets/${elsewhere.id}/relocate`,
    { data: { expectedVersion: elsewhere.version, destinationProjectId: source.id } },
  );
  expect(relocated.ok()).toBe(true);
  await page.goto(`/?peek=${elsewhere.id}&peekProject=${other.id}`);
  await expect(page.getByRole("dialog", { name: elsewhere.title, exact: true })).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`peek=${elsewhere.id}.*peekProject=${source.id}`));
  const deleted = await page.request.delete(
    `/api/v1/projects/${source.id}/tickets/${elsewhere.id}`,
    { data: { expectedVersion: (await relocated.json()).version } },
  );
  expect(deleted.ok()).toBe(true);
  const gone = page.getByRole("dialog", { name: "Ticket preview", exact: true });
  await expect(
    gone.getByText("This ticket was deleted or you no longer have access."),
  ).toBeVisible();
  await expect(gone.getByText(elsewhere.title)).toHaveCount(0);
  await gone.getByRole("button", { name: "Close preview", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(home).toBeVisible();
});
