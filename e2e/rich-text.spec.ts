import { test, expect, type Locator, type Page } from "@playwright/test";
import { z } from "zod";
import { signIn } from "./auth.ts";

const pixel = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aXpUAAAAASUVORK5CYII=",
  "base64",
);
const document = [
  "## Plan",
  "",
  "Read [the guide](https://example.test/guide) with **care**.",
  "",
  "```ts",
  "const answer: number = 42;",
  "```",
  "",
  "- [ ] open item",
  "- [x] done item",
  "",
  "| Step | Owner |",
  "| --- | --- |",
  "| Draft | Ada |",
].join("\n");
async function newProject(page: Page, key: string) {
  const response = await page.request.post("/api/v1/projects", {
    data: { key, name: `${key} project` },
  });
  return z.object({ id: z.string() }).parse(await response.json());
}
const editorFor = (page: Page, label: string) =>
  page.getByRole("group", { name: `${label} editor`, exact: true });
const visual = (page: Page, label: string) =>
  page.getByRole("textbox", { name: label, exact: true }).and(page.locator("[contenteditable]"));
// Puts the caret after a block's last character: a click past the end of its only line. The editor
// reads a clicked selection a moment after the click, so the next key waits for it.
async function caretAtEnd(block: Locator) {
  const box = await block.boundingBox();
  if (!box) throw new Error("The block is not visible");
  await block.click({ position: { x: box.width - 2, y: box.height / 2 } });
  await block.page().waitForTimeout(150);
}
const raw = (page: Page, label: string) => page.locator("textarea").and(page.getByLabel(label));

test("the visual editor keeps canonical Markdown across modes, menus, and submission", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await signIn(page);
  const project = await newProject(page, "RICHEDIT");
  const ticket = await (
    await page.request.post(`/api/v1/projects/${project.id}/tickets`, {
      data: { title: "Edit Markdown visually", description: document },
    })
  ).json();
  const read = async () =>
    (await (await page.request.get(`/api/v1/projects/${project.id}/tickets/${ticket.id}`)).json())
      .ticket;
  await page.goto(`/projects/${project.id}/tickets/${ticket.id}`);
  await page.getByRole("button", { name: "Edit ticket", exact: true }).click();
  const tabs = editorFor(page, "Description");
  await tabs.getByRole("tab", { name: "Visual", exact: true }).click();
  const editor = visual(page, "Description");
  await expect(editor.getByRole("heading", { name: "Plan", exact: true })).toBeVisible();
  await expect(editor.getByRole("table")).toBeVisible();
  // Switching modes without editing leaves the text exactly as stored.
  await tabs.getByRole("tab", { name: "Write", exact: true }).click();
  await expect(raw(page, "Description")).toHaveValue(document);
  await tabs.getByRole("tab", { name: "Visual", exact: true }).click();

  // Typing, undo, shortcuts, and the link editor change only what was edited.
  const intro = editor.getByText(/^Read/);
  await caretAtEnd(intro);
  await page.keyboard.press("Enter");
  await page.keyboard.type("oops");
  await page.keyboard.press("ControlOrMeta+z");
  await expect(editor).not.toContainText("oops");
  await caretAtEnd(intro);
  await page.keyboard.press("Enter");
  await page.keyboard.type("Ship ");
  await page.keyboard.press("ControlOrMeta+b");
  await page.keyboard.type("today");
  await page.keyboard.press("ControlOrMeta+b");
  await expect(
    page
      .getByRole("toolbar", { name: "Description formatting", exact: true })
      .getByRole("button", { name: "Bold", exact: true }),
  ).toHaveAttribute("aria-pressed", "false");
  const ship = editor.getByText("Ship today", { exact: true });
  await ship.selectText();
  await page.waitForTimeout(150);
  await page.keyboard.press("ControlOrMeta+k");
  const address = page.getByRole("textbox", { name: "Link address", exact: true });
  await address.fill("https://example.test/ship");
  await address.press("Enter");
  await expect(editor.getByRole("link", { name: "Ship today" })).toBeVisible();
  await caretAtEnd(ship);

  // The slash menu inserts blocks and closes with Escape without closing the dialog.
  await page.keyboard.press("Enter");
  await page.keyboard.type("/check");
  const blocks = page.getByRole("listbox", { name: "Insert block", exact: true });
  await expect(blocks.getByRole("option", { name: "Checklist", exact: true })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(editor).toHaveAttribute("aria-controls", /suggestions/);
  await page.keyboard.press("Enter");
  await expect(blocks).toHaveCount(0);
  await page.keyboard.type("Review the plan");
  await page.keyboard.press("Enter");
  await page.keyboard.press("Enter");
  await page.keyboard.type("/tab");
  await page.keyboard.press("Escape");
  await expect(blocks).toHaveCount(0);
  await expect(page.getByRole("dialog")).toBeVisible();
  for (let index = 0; index < 4; index++) await page.keyboard.press("Backspace");

  await page.keyboard.press("ControlOrMeta+Enter");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  const saved = z.string().parse((await read()).description);
  for (const kept of [
    "## Plan",
    "[the guide](https://example.test/guide)",
    "**care**",
    "```ts\nconst answer: number = 42;\n```",
    "- [ ] open item",
    "- [x] done item",
    "| Step",
    "[Ship **today**](https://example.test/ship)",
    "- [ ] Review the plan",
  ])
    expect(saved).toContain(kept);
  expect(saved).not.toContain("oops");
  expect(saved).not.toContain("/tab");

  // The comment editor opens in the same mode, mentions members, and clears after posting.
  const comment = visual(page, "Comment");
  await comment.click();
  // Like the textarea's maxLength, Visual mode refuses text past the field's limit.
  const paste = (text: string) =>
    comment.evaluate((element, value) => {
      const data = new DataTransfer();
      data.setData("text/plain", value);
      element.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true }));
    }, text);
  await paste("x".repeat(50_001));
  await expect(comment).toHaveText("");

  await page.keyboard.type("Thanks @Test");
  const people = page.getByRole("listbox", { name: "Mention a member", exact: true });
  await expect(people.getByRole("option", { name: /Test Owner/ })).toBeVisible();
  await page.keyboard.press("Enter");
  await expect(comment.getByRole("link", { name: "@Test Owner" })).toBeVisible();
  await page.keyboard.press("ControlOrMeta+Enter");
  await expect(comment).toHaveText("");
  const comments = await (
    await page.request.get(`/api/v1/projects/${project.id}/tickets/${ticket.id}/comments`)
  ).json();
  expect(comments.items[0].body).toMatch(/^Thanks \[@Test Owner\]\(mention:[^)]+\)$/);

  // The chosen mode is a personal preference, and text the visual editor cannot keep stays raw.
  const html =
    "<details><summary>Logs</summary>Kept as written</details>\n\nA claim[^1]\n\n[^1]: Source";
  const legacy = await (
    await page.request.post(`/api/v1/projects/${project.id}/tickets`, {
      data: { title: "Raw HTML stays", description: html },
    })
  ).json();
  await page.goto(`/projects/${project.id}/tickets/${legacy.id}`);
  await page.getByRole("button", { name: "Edit ticket", exact: true }).click();
  await expect(
    page.getByRole("status").filter({ hasText: "visual editor can't keep" }),
  ).toBeVisible();
  await expect(raw(page, "Description")).toHaveValue(html);
  await page.keyboard.press("ControlOrMeta+Enter");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(
    (await (await page.request.get(`/api/v1/projects/${project.id}/tickets/${legacy.id}`)).json())
      .ticket.description,
  ).toBe(html);
  expect(errors).toEqual([]);
});

test("rendered Markdown highlights code and draws diagrams safely", async ({ page }) => {
  // Reduced motion shortens every transition, which must not skew how Mermaid measures labels.
  await page.emulateMedia({ reducedMotion: "reduce" });
  await signIn(page);
  const project = await newProject(page, "RICHVIEW");
  const ticket = await (
    await page.request.post(`/api/v1/projects/${project.id}/tickets`, {
      data: {
        title: "Rendered blocks",
        description:
          "```ts\nconst answer = 42;\n```\n\n```mermaid\nflowchart LR\n  Draft --> Done\n```\n\n```mermaid\nnot a diagram {\n```",
      },
    })
  ).json();
  await page.goto(`/projects/${project.id}/tickets/${ticket.id}`);
  await expect(page.locator(".markdown .hljs-keyword").first()).toHaveText("const");
  await expect(page.getByRole("img", { name: "Diagram", exact: true })).toBeVisible();
  const diagram = await page
    .getByRole("img", { name: "Diagram", exact: true })
    .locator("svg")
    .boundingBox();
  expect(diagram?.height).toBeLessThan(150);
  await expect(
    page.getByRole("img", { name: "Diagram", exact: true }).locator("script"),
  ).toHaveCount(0);
  await expect(page.getByRole("alert").filter({ hasText: "could not be drawn" })).toBeVisible();
});

test("inline uploads stage before the ticket exists and attach exactly once", async ({ page }) => {
  await signIn(page);
  const project = await newProject(page, "RICHFILE");
  await page.goto(`/projects/${project.id}`);
  await page.getByRole("button", { name: "New ticket", exact: true }).click();
  await editorFor(page, "Description").getByRole("tab", { name: "Write", exact: true }).click();
  const description = raw(page, "Description");
  await page.getByLabel("Title", { exact: true }).fill("Screenshot of the failure");
  await description.fill("Before ");
  await page
    .getByLabel("Insert file into Description", { exact: true })
    .setInputFiles({ name: "pixel.png", mimeType: "image/png", buffer: pixel });
  await expect(description).toHaveValue(
    /^Before !\[pixel\.png\]\(\/api\/v1\/projects\/[^/]+\/attachments\/[^/]+\/content\)$/,
  );
  const url = /\((.+)\)/.exec(await description.inputValue())?.[1] ?? "";
  expect((await page.request.get(url)).status()).toBe(200);
  // Staged files belong to the project the draft opened in.
  await expect(page.getByRole("combobox", { name: "Project", exact: true })).toBeDisabled();
  await page.getByRole("button", { name: "Expand composer", exact: true }).click();
  await expect(page.getByRole("combobox", { name: "Project", exact: true })).toBeDisabled();
  await page.getByRole("button", { name: "Restore composer size", exact: true }).click();

  // A file the text no longer embeds is discarded when the ticket is created.
  await page
    .getByLabel("Insert file into Description", { exact: true })
    .setInputFiles({ name: "notes.txt", mimeType: "text/plain", buffer: Buffer.from("notes") });
  await expect(description).toHaveValue(/\[notes\.txt\]\(/);
  const notes = /\[notes\.txt\]\((.+)\)/.exec(await description.inputValue())?.[1] ?? "";
  await description.fill(`Before ![pixel.png](${url})`);

  // A failed upload reports itself and leaves the text alone.
  await page.route("**/uploads", (route) =>
    route.fulfill({
      status: 503,
      json: { error: { code: "storage_unavailable", message: "Storage is offline" } },
    }),
  );
  await page
    .getByLabel("Insert file into Description", { exact: true })
    .setInputFiles({ name: "late.png", mimeType: "image/png", buffer: pixel });
  await expect(page.getByText("Storage is offline", { exact: true })).toBeVisible();
  await page.unrouteAll();
  await expect(description).toHaveValue(`Before ![pixel.png](${url})`);

  await description.press("ControlOrMeta+Enter");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  const tickets = await (await page.request.get(`/api/v1/projects/${project.id}/tickets`)).json(),
    created = tickets.items[0];
  const attachments = await (
    await page.request.get(`/api/v1/projects/${project.id}/tickets/${created.id}/attachments`)
  ).json();
  expect(attachments.map((item: { name: string }) => item.name)).toEqual(["pixel.png"]);
  await expect.poll(async () => (await page.request.get(notes)).status()).toBe(404);
  await page.goto(`/projects/${project.id}/tickets/${created.id}`);
  const image = page.getByRole("img", { name: "pixel.png", exact: true });
  await expect(image).toBeVisible();
  expect(await image.evaluate((element: HTMLImageElement) => element.naturalWidth)).toBe(1);

  // Discarding a draft discards its staged files.
  await page.goto(`/projects/${project.id}`);
  await page.getByRole("button", { name: "New ticket", exact: true }).click();
  await page
    .getByLabel("Insert file into Description", { exact: true })
    .setInputFiles({ name: "draft.png", mimeType: "image/png", buffer: pixel });
  await expect(raw(page, "Description")).toHaveValue(/draft\.png/);
  const draft = /\((.+)\)/.exec(await raw(page, "Description").inputValue())?.[1] ?? "";
  await page.getByRole("button", { name: "Discard draft", exact: true }).click();
  await expect(raw(page, "Description")).toHaveValue("");
  await expect.poll(async () => (await page.request.get(draft)).status()).toBe(404);

  // On an existing ticket, an inline file in a comment is attached at once.
  await page.goto(`/projects/${project.id}/tickets/${created.id}`);
  await page
    .getByLabel("Insert file into Comment", { exact: true })
    .setInputFiles({ name: "comment.png", mimeType: "image/png", buffer: pixel });
  await expect(page.getByRole("textbox", { name: "Comment", exact: true })).toHaveValue(
    /comment\.png/,
  );
  await expect(page.getByRole("link", { name: "comment.png", exact: true })).toBeVisible();
});
