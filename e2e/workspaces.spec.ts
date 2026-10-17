import { expect, test, type Locator } from "@playwright/test";
import { signIn, useEmailLogin } from "./auth.ts";
import { choose, openSearch } from "./controls.ts";

async function expectCenteredWatermark(state: Locator) {
  const title = state.locator('[data-slot="empty-title"]');
  const watermark = state.locator('svg[aria-hidden="true"]:not(.lucide)');
  await expect(title).toBeVisible();
  await expect(watermark).toBeVisible();
  const titleBox = await title.boundingBox();
  const markBox = await watermark.boundingBox();
  expect(titleBox).not.toBeNull();
  expect(markBox).not.toBeNull();
  if (!titleBox || !markBox) throw new Error("Empty state geometry is unavailable");
  expect(
    Math.abs(markBox.x + markBox.width / 2 - titleBox.x - titleBox.width / 2),
  ).toBeLessThanOrEqual(1);
  expect(
    Math.abs(markBox.y + markBox.height / 2 - titleBox.y - titleBox.height / 2),
  ).toBeLessThanOrEqual(1);
  expect(await watermark.evaluate((node) => getComputedStyle(node).pointerEvents)).toBe("none");
}

for (const width of [1280, 390]) {
  for (const colorScheme of ["light", "dark"] as const) {
    test(`empty-state watermark follows the title at ${width}px in ${colorScheme}`, async ({
      page,
    }, testInfo) => {
      await page.setViewportSize({ width: 1280, height: 800 });
      await page.emulateMedia({ colorScheme });
      await signIn(page);
      const workspace = await (
        await page.request.post("/api/v1/workspaces", {
          data: { name: `Empty ${width} ${colorScheme}`, slug: `empty-${width}-${colorScheme}` },
        })
      ).json();
      await page.reload();
      await page.getByRole("button", { name: "Switch workspace", exact: true }).click();
      await page
        .getByRole("menuitemradio", { name: `Empty ${width} ${colorScheme}`, exact: true })
        .click();
      await page.keyboard.press("Escape");
      await expect(page.getByRole("menu")).toHaveCount(0);
      await page.setViewportSize({ width, height: 800 });
      const state = page.locator('[data-slot="empty"]').filter({ hasText: "No projects yet" });
      await expect(state).toBeVisible();
      await page.screenshot({ path: testInfo.outputPath("projects.png") });
      await expectCenteredWatermark(state);
      const title = state.locator('[data-slot="empty-title"]');
      const originalHeight = (await title.boundingBox())?.height ?? 0;
      await title.evaluate((node) => {
        node.style.maxWidth = "80px";
      });
      expect((await title.boundingBox())?.height).toBeGreaterThan(originalHeight);
      await expectCenteredWatermark(state);
      const project = await (
        await page.request.post("/api/v1/projects", {
          data: {
            workspaceId: workspace.id,
            key: `E${width}${colorScheme === "light" ? "L" : "D"}`,
            name: "Empty tickets",
          },
        })
      ).json();
      await page.goto(`/projects/${project.id}`);
      const tickets = page.locator('[data-slot="empty"]').filter({ hasText: "No tickets yet" });
      await expectCenteredWatermark(tickets);
      await page.screenshot({ path: testInfo.outputPath("tickets.png") });
      await tickets.getByRole("button", { name: "Create the first ticket", exact: true }).click();
      await expect(page.getByRole("dialog")).toBeVisible();
      await page.getByRole("button", { name: "Cancel", exact: true }).click();
      await page.goto(`/projects/${project.id}?status=done`);
      const filtered = page
        .locator('[data-slot="empty"]')
        .filter({ hasText: "No matching tickets" });
      await expectCenteredWatermark(filtered);
      await filtered.getByRole("button", { name: "Clear filters", exact: true }).click();
      await expect(tickets).toBeVisible();
    });
  }
}

test("workspace switching, deep links, and offline project icons remain consistent", async ({
  page,
}) => {
  await signIn(page);
  const external: string[] = [];
  page.on("request", (request) => {
    if (!request.url().startsWith(new URL(page.url()).origin) && /^https?:/.test(request.url()))
      external.push(request.url());
  });
  const first = await (
    await page.request.post("/api/v1/projects", {
      data: { key: "OLDSPACE", name: "Existing workspace project" },
    })
  ).json();
  await page.goto(`/projects/${first.id}`);
  await page.getByRole("button", { name: "Switch workspace", exact: true }).click();
  await page.getByRole("menuitem", { name: "New workspace", exact: true }).click();
  await page.getByLabel("Workspace name", { exact: true }).fill("Design workspace");
  await expect(page.getByLabel("Workspace key", { exact: true })).toHaveValue("design-workspace");
  await page.getByRole("button", { name: "Create workspace", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Switch workspace", exact: true })).toContainText(
    "Design workspace",
  );
  await expect(
    page.getByRole("link", { name: "Existing workspace project", exact: true }),
  ).toHaveCount(0);
  await page.locator("#main").getByRole("button", { name: "New project", exact: true }).click();
  await page.getByLabel("Project name", { exact: true }).fill("Readable project identity");
  await page.getByLabel("Permanent ticket prefix", { exact: true }).fill("DESIGN");
  await page.getByRole("button", { name: "Create project", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Readable project identity", exact: true }),
  ).toBeVisible();
  const projectId = new URL(page.url()).pathname.split("/")[2]!;
  await page.getByRole("button", { name: "Switch workspace", exact: true }).click();
  await page.getByRole("menuitemradio", { name: "Kanvil", exact: true }).click();
  await expect(
    page.getByRole("link", { name: "Existing workspace project", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: "Readable project identity", exact: true }),
  ).toHaveCount(0);
  await page.goto(`/projects/${projectId}`);
  await expect(page.getByRole("button", { name: "Switch workspace", exact: true })).toContainText(
    "Design workspace",
  );
  await page.goto("/");
  await expect(
    page.getByRole("link", { name: "Readable project identity", exact: true }),
  ).toBeVisible();
  await page.reload();
  await expect(page.getByRole("button", { name: "Switch workspace", exact: true })).toContainText(
    "Design workspace",
  );
  await page.goto(`/projects/${projectId}/settings`);
  await expect(page.getByRole("heading", { name: "Project settings", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Change icon", exact: true }).click();
  await (await openSearch(page, "Search icons")).fill("rocket");
  await page.getByRole("button", { name: "purple icon color", exact: true }).click();
  await page.getByRole("button", { name: "Choose rocket", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect
    .poll(
      async () => (await (await page.request.get(`/api/v1/projects/${projectId}`)).json()).iconName,
    )
    .toBe("rocket");
  await page.getByRole("button", { name: "Change icon", exact: true }).click();
  await page.getByRole("tab", { name: "Upload image", exact: true }).click();
  await page
    .getByLabel("Project icon file", { exact: true })
    .setInputFiles("apps/web/public/brand/icon-192.png");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  const image = page.locator(`#main img[src^="/api/v1/projects/${projectId}/icon"]`).first();
  await expect(image).toBeVisible();
  expect(
    await image.evaluate((node) => (node instanceof HTMLImageElement ? node.naturalWidth : 0)),
  ).toBe(256);
  await page.reload();
  await expect(image).toBeVisible();
  await page.getByRole("button", { name: "Change icon", exact: true }).click();
  await page.getByRole("button", { name: "Reset icon", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(image).toHaveCount(0);
  expect(external).toEqual([]);
});

test("workspace member roles control project actions and removal revokes access", async ({
  page,
  browser,
}) => {
  await signIn(page);
  const workspace = await (
    await page.request.post("/api/v1/workspaces", {
      data: { name: "Access workspace", slug: "access-workspace" },
    })
  ).json();
  const shared = await (
    await page.request.post("/api/v1/projects", {
      data: {
        workspaceId: workspace.id,
        visibility: "workspace",
        key: "ACCESSUX",
        name: "Workspace-visible project",
      },
    })
  ).json();
  await page.request.post("/api/v1/projects", {
    data: {
      workspaceId: workspace.id,
      visibility: "private",
      key: "PRIVATEUX",
      name: "Private project",
    },
  });
  const email = "workspace-reader@example.test",
    password = "Workspace reader password 234!";
  expect(
    (
      await page.request.post("/api/auth/admin/create-user", {
        headers: { Origin: new URL(page.url()).origin },
        data: { email, password, name: "Workspace reviewer", role: "user" },
      })
    ).ok(),
  ).toBe(true);
  await page.goto(`/workspaces/${workspace.id}/settings?section=members`);
  await page.getByRole("button", { name: "Add member", exact: true }).click();
  await page.getByRole("combobox", { name: "Account", exact: true }).click();
  await page.getByRole("combobox", { name: "Search accounts", exact: true }).fill(email);
  await page.getByRole("option", { name: `Use ${email}`, exact: true }).click();
  await choose(page, "Workspace role", "Read only");
  await page.getByRole("dialog").getByRole("button", { name: "Add member", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  const row = page.locator(".member-row").filter({ hasText: email });
  await expect(row).toBeVisible();
  const context = await browser.newContext({ baseURL: new URL(page.url()).origin });
  try {
    const reader = await context.newPage();
    await reader.goto("/login");
    await expect(reader.getByRole("heading", { name: "Sign in", exact: true })).toBeVisible();
    await useEmailLogin(reader);
    await reader.getByLabel("Email", { exact: true }).fill(email);
    await reader.getByLabel("Password", { exact: true }).fill(password);
    await reader.getByRole("button", { name: "Sign in", exact: true }).click();
    await expect(
      reader.getByRole("link", { name: "Workspace-visible project", exact: true }),
    ).toBeVisible();
    await expect(reader.getByRole("link", { name: "Private project", exact: true })).toHaveCount(0);
    await expect(
      reader.locator("#main").getByRole("button", { name: "New project", exact: true }),
    ).toBeDisabled();
    await reader.goto(`/projects/${shared.id}`);
    await expect(reader.getByRole("button", { name: "New ticket", exact: true })).toBeDisabled();
    await choose(page, "Role for Workspace reviewer", "Can edit");
    await reader.reload();
    await expect(reader.getByRole("button", { name: "New ticket", exact: true })).toBeEnabled();
    await page.goto(`/projects/${shared.id}/settings?section=members`);
    await choose(page, "Role for Workspace reviewer", "Read only");
    await row.getByRole("button", { name: "Use workspace access", exact: true }).click();
    await page
      .getByRole("alertdialog")
      .getByRole("button", { name: "Use workspace access", exact: true })
      .click();
    await expect(row.getByText("Workspace access", { exact: true })).toBeVisible();
    await page.goto(`/workspaces/${workspace.id}/settings?section=members`);
    await row.getByRole("button", { name: "Remove member", exact: true }).click();
    await page
      .getByRole("alertdialog")
      .getByRole("button", { name: "Remove member", exact: true })
      .click();
    await expect(row).toHaveCount(0);
    expect((await reader.request.get(`/api/v1/projects/${shared.id}`)).status()).toBe(404);
  } finally {
    await context.close();
  }
});
