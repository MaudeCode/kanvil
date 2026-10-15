import {
  choose,
  signOut,
  expand,
  chooseTicketView,
  openSaveView,
  searchTickets,
} from "./controls.ts";
import { test, expect } from "@playwright/test";

import { signIn } from "./auth.ts";
const title =
  "Preserve complete ticket titles across the agent workspace, even when the title contains enough detail to wrap onto several readable lines";
test("parent, child, and relationship links show ticket titles", async ({ page }) => {
  await signIn(page);
  const project = await (
    await page.request.post("/api/v1/projects", { data: { key: "CTX", name: "Ticket context" } })
  ).json();
  const create = async (ticketTitle: string, parentId?: string) =>
    (
      await page.request.post(`/api/v1/projects/${project.id}/tickets`, {
        data: { title: ticketTitle, ...(parentId ? { parentId } : {}) },
      })
    ).json();
  const parent = await create("Parent requirements"),
    child = await create(
      "Child requirements remain fully readable when navigating through the entire project hierarchy",
      parent.id,
    ),
    peer = await create("Related implementation with its complete title");
  expect(
    (
      await page.request.post(`/api/v1/projects/${project.id}/tickets/${parent.id}/relations`, {
        data: { targetId: peer.id, type: "related" },
      })
    ).ok(),
  ).toBe(true);
  await page.goto(`/projects/${project.id}/tickets/${parent.id}`);
  await expect(page.getByRole("heading", { name: "Child tickets", exact: true })).toBeVisible();
  await expect(
    page.getByRole("link", { name: `${peer.key} · ${peer.title}`, exact: true }),
  ).toBeVisible();
  await page.getByRole("link", { name: `${child.key} · ${child.title}`, exact: true }).click();
  await expect(page.getByRole("heading", { name: child.title, exact: true })).toBeVisible();
  await page.getByRole("link", { name: `${parent.key} · ${parent.title}`, exact: true }).click();
  await expect(page.getByRole("heading", { name: parent.title, exact: true })).toBeVisible();
});
test("owner setup, tickets, discussion, attachments, credentials, and realtime conflicts", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await signIn(page);
  await page.getByRole("button", { name: "New project", exact: true }).last().click();
  await page.getByLabel("Project name").fill("Kanvil development");
  await page.getByLabel("Permanent ticket prefix").fill("KAN");
  await page.getByRole("button", { name: "Create project", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Kanvil development", exact: true }),
  ).toBeVisible();
  const projectId = new URL(page.url()).pathname.split("/")[2];
  expect(projectId).toBeTruthy();
  await page.getByRole("button", { name: "New ticket", exact: true }).click();
  await page.getByLabel("Title", { exact: true }).fill(title);
  await page
    .getByLabel("Description", { exact: true })
    .fill("## Context\nKeep the complete title readable.");
  await page
    .getByLabel("Acceptance criteria", { exact: true })
    .fill("- [ ] Titles wrap\n- [ ] Changes appear live");
  await page
    .getByRole("group", { name: "Description editor", exact: true })
    .getByRole("tab", { name: "Preview", exact: true })
    .click();
  await expect(page.getByRole("heading", { name: "Context", exact: true })).toBeVisible();
  await page
    .getByRole("group", { name: "Description editor", exact: true })
    .getByRole("tab", { name: "Write", exact: true })
    .click();
  await expect(page.getByLabel("Description", { exact: true })).toHaveValue(
    "## Context\nKeep the complete title readable.",
  );
  await expand(page, "More properties");
  await choose(page, "Difficulty", "med");
  await page.getByLabel("Labels", { exact: true }).fill("web, agents");
  await page.getByLabel("Labels", { exact: true }).press("Enter");
  await expand(page, "Automation");
  await page.getByRole("checkbox", { name: /Ready for agents/ }).check();
  await page.getByRole("button", { name: "Save ticket", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  const link = page.getByRole("link", { name: title, exact: true });
  await expect(link).toBeVisible();
  const layout = await link.evaluate((element) => ({
    lines:
      element.getBoundingClientRect().height /
      Number.parseFloat(getComputedStyle(element).lineHeight),
    overflow: getComputedStyle(element).textOverflow,
  }));
  expect(layout.lines).toBeGreaterThan(1);
  expect(layout.overflow).not.toBe("ellipsis");
  await page.screenshot({ path: "test-results/tickets-desktop.png", fullPage: true });
  await link.click();
  await expect(page.getByRole("heading", { name: title, exact: true })).toBeVisible();
  await expect(page.getByText("Ready to claim", { exact: true })).toBeVisible();
  const ticketId = new URL(page.url()).pathname.split("/")[4];
  await page.getByLabel("Comment", { exact: true }).fill("Verified through the browser.");
  await page.getByRole("button", { name: "Comment", exact: true }).click();
  await expect(page.getByText("Verified through the browser.", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Edit comment", exact: true }).click();
  await page
    .getByRole("textbox", { name: "Edit comment", exact: true })
    .fill("My unsaved comment draft");
  const comments = await (
    await page.request.get(`/api/v1/projects/${projectId}/tickets/${ticketId}/comments`)
  ).json();
  const comment = comments.items[0];
  const remoteComment = await page.request.patch(
    `/api/v1/projects/${projectId}/comments/${comment.id}`,
    { data: { expectedVersion: comment.version, body: "Changed in another session" } },
  );
  expect(remoteComment.status()).toBe(200);
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("comment changed");
  await expect(page.getByRole("textbox", { name: "Edit comment", exact: true })).toHaveValue(
    "My unsaved comment draft",
  );
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(page.getByText("Changed in another session", { exact: true })).toBeVisible();
  await page.getByLabel("File (up to 10 MB)").setInputFiles({
    name: "proof.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("attachment proof"),
  });
  await expect(page.getByRole("link", { name: "proof.txt", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Remove attachment", exact: true }).click();
  await expect(
    page.getByRole("alertdialog", { name: "Remove attachment", exact: true }),
  ).toBeVisible();
  await page.getByRole("alertdialog").getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(page.getByRole("alertdialog")).toHaveCount(0);
  await expect(page.getByRole("link", { name: "proof.txt", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Edit ticket", exact: true }).click();
  await page.getByLabel("Title", { exact: true }).fill("Local unsaved draft");
  const read = await page.request.get(`/api/v1/projects/${projectId}/tickets/${ticketId}`);
  const current = await read.json();
  expect(current.ticket.title).toBe(title);
  const update = await page.request.patch(`/api/v1/projects/${projectId}/tickets/${ticketId}`, {
    data: {
      expectedVersion: current.ticket.version,
      changes: { title: "Changed by another agent" },
    },
  });
  expect(update.status()).toBe(200);
  await expect(page.getByText("This ticket changed.", { exact: false })).toBeVisible();
  await expect(page.getByLabel("Title", { exact: true })).toHaveValue("Local unsaved draft");
  await expect(page.getByRole("button", { name: "Save ticket", exact: true })).toBeDisabled();
  await page.getByRole("button", { name: "Discard draft and reload", exact: true }).click();
  await expect(page.getByLabel("Title", { exact: true })).toHaveValue("Changed by another agent");
  await page.getByRole("button", { name: "Close", exact: true }).click();
  for (let index = 0; index < 54; index++) {
    const response = await page.request.post(`/api/v1/projects/${projectId}/tickets`, {
      data: {
        title: `Browser ticket ${index}: verify pagination and readable multi-line ticket rows`,
      },
    });
    expect(response.status()).toBe(200);
  }
  await page.goto(`/projects/${projectId}`);
  await expect(page.getByRole("row")).toHaveCount(51);
  await page.screenshot({ path: "test-results/tickets-desktop.png", fullPage: true });
  await page.getByRole("button", { name: "Next", exact: true }).click();
  await expect(page.getByRole("row")).toHaveCount(6);
  await searchTickets(page, "Changed by another agent");
  await expect(page.getByRole("row")).toHaveCount(2);
  await page.getByRole("checkbox", { name: "Select KAN-1", exact: true }).check();
  await choose(page, "New status", "In review");
  await page.getByRole("button", { name: "Apply status", exact: true }).click();
  await expect(page.getByRole("cell", { name: "In review", exact: false })).toBeVisible();
  await openSaveView(page);
  await page.getByLabel("View name", { exact: true }).fill("Agent edits");
  await page.getByRole("button", { name: "Save view", exact: true }).click();
  await expect(page.getByText("View saved", { exact: true })).toBeVisible();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Ticket views", exact: true })).toContainText(
    "Agent edits",
  );
  await chooseTicketView(page, "All tickets");
  await expect(page.getByRole("row")).toHaveCount(51);
  await chooseTicketView(page, "Agent edits");
  await expect(page.getByRole("row")).toHaveCount(2);
  await page.getByRole("link", { name: "Settings", exact: true }).click();
  await page.getByRole("tab", { name: "Notifications", exact: true }).click();
  const inboxPreference = page.getByRole("switch", {
    name: "Subscribed ticket updates in Inbox",
    exact: true,
  });
  await expect(inboxPreference).toBeChecked();
  await inboxPreference.click();
  await expect(inboxPreference).not.toBeChecked();
  await page.reload();
  await page.getByRole("tab", { name: "Notifications", exact: true }).click();
  await expect(inboxPreference).not.toBeChecked();
  await inboxPreference.click();
  await expect(inboxPreference).toBeChecked();
  await page.getByRole("tab", { name: "API keys", exact: true }).click();
  await page.getByRole("button", { name: "Create API key", exact: true }).click();
  await page.getByLabel("Key name").fill("Read-only agent");
  await page.getByRole("checkbox", { name: "Kanvil development", exact: true }).check();
  await page.getByRole("button", { name: "Create API key", exact: true }).click();
  const key = await page.getByLabel("New API key", { exact: true }).inputValue();
  expect(key).toMatch(/^kv_/);
  const apiRead = await page.request.get(`/api/v1/projects/${projectId}/tickets`, {
    headers: { Authorization: `Bearer ${key}` },
  });
  expect(apiRead.status()).toBe(200);
  await page.getByRole("button", { name: "Done", exact: true }).click();
  await page
    .getByRole("row")
    .filter({ hasText: "Read-only agent" })
    .getByRole("button", { name: "Revoke API key", exact: true })
    .click();
  await page
    .getByRole("alertdialog")
    .getByRole("button", { name: "Revoke API key", exact: true })
    .click();
  await expect(page.getByRole("alertdialog")).toHaveCount(0);
  const revoked = await page.request.get(`/api/v1/projects/${projectId}/tickets`, {
    headers: { Authorization: `Bearer ${key}` },
  });
  expect(revoked.status()).toBe(401);
  await page.goto(`/projects/${projectId}/tickets/${ticketId}`);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(
    page.getByRole("heading", { name: "Changed by another agent", exact: true }),
  ).toBeVisible();
  await page.screenshot({ path: "test-results/ticket-mobile-web.png", fullPage: true });
  await signOut(page);
  await expect(page.getByRole("heading", { name: "Sign in", exact: true })).toBeVisible();
  expect(
    await page.evaluate(() =>
      Object.keys(localStorage).some(
        (storageKey) => storageKey.includes(":cache") || storageKey.includes(":draft:"),
      ),
    ),
  ).toBe(false);
  expect(errors).toEqual([]);
});
