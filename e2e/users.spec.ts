import { expect, test } from "./test.ts";
import { ownerEmail, signIn, useEmailLogin } from "./auth.ts";
import {
  accountMenu,
  privateCache,
  choose,
  expectMotion,
  openSearch,
  recordMotion,
  sheetMotion,
} from "./controls.ts";

test("account management supports workspace access, profile edits, password reset, and suspension", async ({
  page,
  browser,
}) => {
  await signIn(page);
  await page.request.post("/api/v1/workspaces", {
    data: { name: "People workspace", slug: "people-workspace" },
  });
  await page.goto("/admin?section=users");
  await page.getByRole("button", { name: "New user", exact: true }).click();
  const email = "morgan@people.test",
    initial = "Initial account password 234!";
  await page.getByLabel("Name", { exact: true }).fill("Morgan Engineer");
  await page.getByLabel("Email", { exact: true }).fill(email);
  await page.getByLabel("Initial password", { exact: true }).fill(initial);
  await page.getByRole("button", { name: "Create account", exact: true }).click();
  let panel = page.getByRole("dialog", { name: "Morgan Engineer", exact: true });
  await expect(panel).toBeVisible();
  await panel.getByRole("button", { name: "Add to workspace", exact: true }).click();
  await choose(page, "Workspace", "People workspace");
  await choose(page, "Workspace role", "Can edit");
  await page
    .getByRole("dialog", { name: "Add to workspace", exact: true })
    .getByRole("button", { name: "Save changes", exact: true })
    .click();
  await expect(panel.getByRole("link", { name: "People workspace", exact: true })).toBeVisible();
  await panel.getByRole("button", { name: "Edit account", exact: true }).click();
  const edit = page.getByRole("dialog", { name: "Edit account", exact: true });
  await edit.getByLabel("Name", { exact: true }).fill("Morgan Maintainer");
  await edit.getByRole("button", { name: "Save changes", exact: true }).click();
  panel = page.getByRole("dialog", { name: "Morgan Maintainer", exact: true });
  await expect(panel).toBeVisible();
  const managed = (await (await page.request.get("/api/v1/admin/users?q=morgan")).json()).users[0];
  const context = await browser.newContext({ baseURL: new URL(page.url()).origin });
  try {
    const old = await context.request.post("/api/auth/sign-in/email", {
      headers: { Origin: new URL(page.url()).origin },
      data: { email, password: initial },
    });
    expect(old.ok()).toBe(true);
    await panel.getByRole("button", { name: "Set local password", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Set local password", exact: true }),
      next = "Replaced account password 234!";
    await dialog.getByLabel("New password", { exact: true }).fill(next);
    await dialog
      .getByLabel("Confirm new password", { exact: true })
      .fill("Different account password 234!");
    await dialog.getByRole("button", { name: "Save changes", exact: true }).click();
    await expect(dialog.getByRole("alert")).toContainText("do not match");
    await expect(dialog.getByLabel("New password", { exact: true })).toHaveValue(next);
    await dialog.getByLabel("Confirm new password", { exact: true }).fill(next);
    await dialog.getByRole("button", { name: "Save changes", exact: true }).click();
    await expect(dialog).toHaveCount(0);
    expect(await (await context.request.get("/api/auth/get-session")).json()).toBeNull();
    expect(
      (
        await context.request.post("/api/auth/sign-in/email", {
          headers: { Origin: new URL(page.url()).origin },
          data: { email, password: next },
        })
      ).ok(),
    ).toBe(true);
    await panel.getByRole("button", { name: "Change role", exact: true }).click();
    await choose(page, "Instance role", "Administrator");
    await page
      .getByRole("dialog", { name: "Change instance role", exact: true })
      .getByRole("button", { name: "Save changes", exact: true })
      .click();
    await expect(
      panel.getByText("Can administer every workspace, account, and deployment setting.", {
        exact: true,
      }),
    ).toBeVisible();
    await panel.getByRole("button", { name: "Disable account", exact: true }).click();
    await page
      .getByRole("alertdialog")
      .getByRole("button", { name: "Disable account", exact: true })
      .click();
    await expect(panel.getByText("Disabled", { exact: true })).toBeVisible();
    expect((await context.request.get("/api/v1/projects")).status()).toBeGreaterThanOrEqual(401);
    await panel.getByRole("button", { name: "Close", exact: true }).click();
    await (await openSearch(page, "Search users")).fill("morgan");
    await choose(page, "Account status filter", "Disabled");
    const row = page.getByRole("row", { name: new RegExp(email) });
    await expect(row).toBeVisible();
    await row.click({ button: "right" });
    await page.getByRole("menuitem", { name: "Manage account", exact: true }).click();
    await panel.getByRole("button", { name: "Enable account", exact: true }).click();
    await page
      .getByRole("alertdialog")
      .getByRole("button", { name: "Enable account", exact: true })
      .click();
    await expect(panel.getByText("Active", { exact: true })).toBeVisible();
    await panel.getByRole("button", { name: "Close", exact: true }).click();
    await expect(page.getByText("No matching users", { exact: true })).toBeVisible();
    await choose(page, "Account status filter", "All accounts");
    await choose(page, "Instance role filter", "Administrators");
    await expect(row).toBeVisible();
    expect(
      (await (await page.request.get(`/api/v1/admin/users/${managed.id}`)).json()).workspaces,
    ).toEqual([expect.objectContaining({ name: "People workspace", role: "writer" })]);
  } finally {
    await context.close();
  }
});

test("role changes discard cached administrator-only project data", async ({ page, browser }) => {
  await signIn(page);
  const origin = new URL(page.url()).origin,
    email = "temporary-admin@people.test",
    password = "Temporary administrator password 234!";
  const account = await (
    await page.request.post("/api/auth/admin/create-user", {
      headers: { Origin: origin },
      data: { name: "Temporary administrator", email, password, role: ["admin", "user"] },
    })
  ).json();
  const userId = account.user.id;
  await page.request.post("/api/v1/projects", {
    data: { key: "ROLECACHE", name: "Private administrator-only project", visibility: "private" },
  });
  const context = await browser.newContext({ baseURL: origin });
  try {
    const admin = await context.newPage();
    await admin.goto("/login");
    await expect(admin.getByRole("heading", { name: "Sign in", exact: true })).toBeVisible();
    await useEmailLogin(admin);
    await admin.getByLabel("Email", { exact: true }).fill(email);
    await admin.getByLabel("Password", { exact: true }).fill(password);
    await admin.getByRole("button", { name: "Sign in", exact: true }).click();
    await expect(
      admin.getByRole("link", { name: "Private administrator-only project", exact: true }),
    ).toBeVisible();
    await accountMenu(admin);
    await expect(
      admin.getByRole("menuitem", { name: "Administration", exact: true }),
    ).toBeVisible();
    await admin.keyboard.press("Escape");
    await expect
      .poll(() =>
        privateCache(admin, `kanvil:${userId}:cache`).then((value) =>
          value.includes("Private administrator-only project"),
        ),
      )
      .toBe(true);
    expect(
      (
        await page.request.post("/api/auth/admin/set-role", {
          headers: { Origin: origin },
          data: { userId, role: "user" },
        })
      ).ok(),
    ).toBe(true);
    await admin.reload();
    await expect(admin.getByRole("heading", { name: "Projects", exact: true })).toBeVisible();
    await accountMenu(admin);
    await expect(admin.getByRole("menuitem", { name: "Administration", exact: true })).toHaveCount(
      0,
    );
    await expect(admin.getByRole("menuitem", { name: "User settings", exact: true })).toBeVisible();
    await admin.keyboard.press("Escape");
    await expect(
      admin.getByRole("link", { name: "Private administrator-only project", exact: true }),
    ).toHaveCount(0);
    await expect
      .poll(() =>
        privateCache(admin, `kanvil:${userId}:cache`).then((value) =>
          value.includes("Private administrator-only project"),
        ),
      )
      .toBe(false);
    expect((await admin.request.get("/api/v1/admin/users")).status()).toBe(403);
  } finally {
    await context.close();
  }
});

test("the workspace directory lists every workspace and manages members the administrator does not share", async ({
  page,
  browser,
}) => {
  await signIn(page);
  const origin = new URL(page.url()).origin,
    email = "riley@outside.test",
    password = "Outside workspace password 234!";
  expect(
    (
      await page.request.post("/api/auth/admin/create-user", {
        headers: { Origin: origin },
        data: { name: "Riley Outsider", email, password, role: "user" },
      })
    ).ok(),
  ).toBe(true);
  const context = await browser.newContext({ baseURL: origin });
  try {
    expect(
      (
        await context.request.post("/api/auth/sign-in/email", {
          headers: { Origin: origin },
          data: { email, password },
        })
      ).ok(),
    ).toBe(true);
    expect(
      (
        await context.request.post("/api/v1/workspaces", {
          headers: { Origin: origin },
          data: { name: "Outside workspace", slug: "outside-workspace" },
        })
      ).ok(),
    ).toBe(true);
    expect((await context.request.get("/api/v1/admin/workspaces")).status()).toBe(403);
  } finally {
    await context.close();
  }
  await page.goto("/admin?section=workspaces");
  await (await openSearch(page, "Search workspaces")).fill("outside");
  const row = page.getByRole("row", { name: /Outside workspace/ });
  await expect(row).toContainText("outside-workspace");
  await expect(row).toContainText("Riley Outsider");
  await expect(row.getByRole("cell", { name: "1", exact: true })).toBeVisible();
  await row.getByRole("button", { name: "Manage Outside workspace", exact: true }).click();
  const sheet = page.getByRole("dialog", { name: "Outside workspace", exact: true });
  await expect(sheet.locator(".member-row").filter({ hasText: email })).toBeVisible();
  await expect(sheet.getByText("No projects", { exact: true })).toBeVisible();
  await sheet.getByRole("button", { name: "Add member", exact: true }).click();
  const adding = page.getByRole("dialog", { name: "Add member", exact: true });
  await adding.getByRole("combobox", { name: "Account", exact: true }).click();
  await page.getByRole("combobox", { name: "Search accounts", exact: true }).fill(ownerEmail);
  await page.getByRole("option", { name: `Use ${ownerEmail}`, exact: true }).click();
  await choose(page, "Workspace role", "Read only");
  await adding.getByRole("button", { name: "Add member", exact: true }).click();
  await expect(adding).toHaveCount(0);
  await expect(sheet.locator(".member-row").filter({ hasText: ownerEmail })).toBeVisible();
  // Riley created the workspace and owns it, so the role stays Admin until ownership moves.
  const riley = sheet.locator(".member-row").filter({ hasText: email });
  await expect(riley.getByText("Owner", { exact: true })).toBeVisible();
  await expect(riley.getByRole("combobox", { name: "Role for Riley Outsider" })).toBeDisabled();
  await page.keyboard.press("Escape");
  await expect(sheet).toHaveCount(0);
  await expect(row.getByRole("cell", { name: "2", exact: true })).toBeVisible();
  await page
    .getByRole("searchbox", { name: "Search workspaces", exact: true })
    .fill("no-such-space");
  await expect(page.getByText("No matching workspaces", { exact: true })).toBeVisible();
});

test("administration detail sheets slide in and out and start fresh for each record", async ({
  page,
}) => {
  await signIn(page);
  const origin = new URL(page.url()).origin;
  for (const name of ["Motion north", "Motion south"])
    expect(
      (
        await page.request.post("/api/v1/workspaces", {
          data: { name, slug: name.toLowerCase().replace(" ", "-") },
        })
      ).ok(),
    ).toBe(true);
  for (const name of ["Avery Motion", "Blair Motion"])
    expect(
      (
        await page.request.post("/api/auth/admin/create-user", {
          headers: { Origin: origin },
          data: {
            name,
            email: `${name.split(" ")[0]!.toLowerCase()}@motion.test`,
            password: "Motion account password 234!",
            role: "user",
          },
        })
      ).ok(),
    ).toBe(true);
  await page.goto("/admin?section=workspaces");
  await (await openSearch(page, "Search workspaces")).fill("motion");
  await recordMotion(page);
  // Every way to close runs the exit before the sheet leaves, and reopening runs the entry again.
  const closes = [
    () => page.keyboard.press("Escape"),
    (sheet: ReturnType<typeof page.getByRole>) =>
      sheet.getByRole("button", { name: "Close", exact: true }).click(),
    () => page.mouse.click(8, 400),
  ];
  for (const [index, name] of ["Motion north", "Motion south", "Motion north"].entries()) {
    const manage = page.getByRole("button", { name: `Manage ${name}`, exact: true });
    await manage.click();
    const sheet = page.getByRole("dialog", { name, exact: true });
    await expect(sheet.getByText(name.toLowerCase().replace(" ", "-"))).toBeVisible();
    await expectMotion(page, sheetMotion("enter"));
    await closes[index]!(sheet);
    await expectMotion(page, sheetMotion("exit"));
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(manage).toBeFocused();
  }
  // Choosing another record while the sheet still closes shows that record, once. The closing
  // backdrop still takes the pointer, so the click goes to the button directly.
  await page.getByRole("button", { name: "Manage Motion north", exact: true }).click();
  await expectMotion(page, sheetMotion("enter"));
  await page.keyboard.press("Escape");
  await page
    .getByRole("button", { name: "Manage Motion south", exact: true })
    .dispatchEvent("click");
  const south = page.getByRole("dialog", { name: "Motion south", exact: true });
  await expect(south).toBeVisible();
  await expect(page.locator('[data-slot="sheet-overlay"]')).toHaveCount(1);
  await expect(page.getByRole("dialog", { name: "Motion north", exact: true })).toHaveCount(0);
  await expect(south.locator(":focus")).toHaveCount(1);
  await south.getByRole("button", { name: "Close", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);

  await page.goto("/admin?section=users");
  await (await openSearch(page, "Search users")).fill("motion");
  await recordMotion(page);
  const avery = page.getByRole("button", { name: "Manage Avery Motion", exact: true });
  await avery.click();
  let panel = page.getByRole("dialog", { name: "Avery Motion", exact: true });
  await expect(panel.getByText("avery@motion.test")).toBeVisible();
  await expectMotion(page, sheetMotion("enter"));
  // A failed edit leaves its error on the sheet; it belongs to Avery alone.
  await panel.getByRole("button", { name: "Set local password", exact: true }).click();
  const form = page.getByRole("dialog", { name: "Set local password", exact: true });
  await form.getByLabel("New password", { exact: true }).fill("Motion password one 234!");
  await form.getByLabel("Confirm new password", { exact: true }).fill("Motion password two 234!");
  await form.getByRole("button", { name: "Save changes", exact: true }).click();
  await expect(form.getByText("The new passwords do not match.")).toBeVisible();
  await form.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(panel.getByText("The new passwords do not match.")).toBeVisible();
  await page.keyboard.press("Escape");
  await expectMotion(page, sheetMotion("exit"));
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(avery).toBeFocused();
  await page.getByRole("button", { name: "Manage Blair Motion", exact: true }).click();
  panel = page.getByRole("dialog", { name: "Blair Motion", exact: true });
  await expect(panel.getByText("blair@motion.test")).toBeVisible();
  await expectMotion(page, sheetMotion("enter"));
  await expect(page.getByText("The new passwords do not match.")).toHaveCount(0);
  await expect(page.getByText("avery@motion.test")).toHaveCount(1);
  await panel.getByRole("button", { name: "Close", exact: true }).click();
  await expectMotion(page, sheetMotion("exit"));
  await expect(page.getByRole("dialog")).toHaveCount(0);
});

test("administration detail sheets open and close at once with reduced motion", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await signIn(page);
  await page.request.post("/api/v1/workspaces", {
    data: { name: "Still workspace", slug: "still-workspace" },
  });
  await page.goto("/admin?section=workspaces");
  await (await openSearch(page, "Search workspaces")).fill("still");
  const manage = page.getByRole("button", { name: "Manage Still workspace", exact: true });
  for (let round = 0; round < 2; round++) {
    await manage.click();
    const sheet = page.getByRole("dialog", { name: "Still workspace", exact: true });
    const close = sheet.getByRole("button", { name: "Close", exact: true });
    await expect(close).toBeVisible();
    // After Escape returns focus by keyboard, reopening focuses a control whose tooltip would take
    // the next Escape, so the second round closes with the button.
    if (round === 0) await page.keyboard.press("Escape");
    else await close.click();
    await expect(sheet).toHaveCount(0);
    await expect(manage).toBeFocused();
    // Nothing the sheet locked stays behind: the page scrolls and takes pointer input again.
    await expect(page.locator("[data-base-ui-inert]")).toHaveCount(0);
    await expect(page.locator("html")).not.toHaveCSS("overflow", "hidden");
    await expect(page.locator("body")).not.toHaveCSS("overflow", "hidden");
  }
});
