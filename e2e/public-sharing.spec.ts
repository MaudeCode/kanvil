import { expect, test } from "./test.ts";
import { z } from "zod";
import { signIn } from "./auth.ts";

test("an administrator shares a project read-only by link and revokes it", async ({
  page,
  browser,
}) => {
  await signIn(page);
  const origin = new URL(page.url()).origin;
  const project = z.object({ id: z.string() }).parse(
    await (
      await page.request.post("/api/v1/projects", {
        data: {
          key: "SHARED",
          name: "Shared roadmap",
          description: "Plans readers can follow.",
        },
      })
    ).json(),
  );
  const ticket = (data: Record<string, unknown>) =>
    page.request
      .post(`/api/v1/projects/${project.id}/tickets`, { data })
      .then(async (response) => z.object({ id: z.string() }).parse(await response.json()));
  const parent = await ticket({
    title: "Publish the roadmap",
    acceptanceCriteria: "Readers can open every planned item.",
    labels: ["roadmap"],
    priority: "high",
  });
  await ticket({ title: "Draft the first milestone", parentId: parent.id });

  await page.goto(`/projects/${project.id}/settings`);
  await expect(page.getByText("Public link", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Share publicly", exact: true }).click();
  const confirm = page.getByRole("alertdialog");
  await expect(confirm).toContainText("People, comments, activity, attachments");
  await confirm.getByRole("button", { name: "Share publicly", exact: true }).click();
  await expect(page.getByText("Public link on")).toBeVisible();
  const url = `${origin}/public/projects/${project.id}`;
  await expect(page.getByText(url, { exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "Open public view" })).toHaveAttribute("href", url);

  const context = await browser.newContext({ baseURL: origin });
  try {
    const reader = await context.newPage();
    await reader.goto(url);
    await expect(reader.getByRole("heading", { name: "Shared roadmap", level: 1 })).toBeVisible();
    await expect(reader.getByText("Plans readers can follow.")).toBeVisible();
    await expect(reader.getByRole("button", { name: "New ticket" })).toHaveCount(0);
    // A shared preview reads only the public API, never the member one.
    const requests: string[] = [];
    reader.on("request", (request) => {
      const { pathname } = new URL(request.url());
      if (pathname.startsWith("/api/v1/") || pathname.startsWith("/api/public/"))
        requests.push(pathname);
    });
    // A row opens the public preview sheet over the shared list.
    await reader.getByRole("link", { name: /Publish the roadmap/ }).click();
    const sheet = reader.getByRole("dialog", { name: "Publish the roadmap", exact: true });
    await expect(sheet).toBeVisible();
    await expect(reader).toHaveURL(
      new RegExp(`/public/projects/${project.id}\\?peek=${parent.id}$`),
    );
    await expect(reader.locator("#main h1", { hasText: "Shared roadmap" })).toHaveCount(1);
    await expect(sheet.getByText("Readers can open every planned item.")).toBeVisible();
    for (const name of ["Edit ticket", "Subscribe", "Archive ticket", "Ticket actions"])
      await expect(sheet.getByRole("button", { name })).toHaveCount(0);
    await expect(sheet.getByRole("combobox")).toHaveCount(0);
    // Its references stay public and replace the ticket in the same sheet.
    await sheet.getByRole("link", { name: /Draft the first milestone/ }).click();
    const childSheet = reader.getByRole("dialog", {
      name: "Draft the first milestone",
      exact: true,
    });
    await expect(childSheet).toBeVisible();
    await expect(reader.getByRole("dialog")).toHaveCount(1);
    await reader.keyboard.press("Escape");
    await expect(reader.getByRole("dialog")).toHaveCount(0);
    await expect(reader.getByRole("link", { name: /Publish the roadmap/ })).toBeFocused();
    await reader.reload();
    await expect(reader.getByRole("heading", { name: "Shared roadmap", level: 1 })).toBeVisible();
    expect(requests.length).toBeGreaterThan(0);
    expect(requests.filter((path) => path.startsWith("/api/v1/"))).toEqual([]);

    // The full public page stays one click away.
    await reader.getByRole("link", { name: /Publish the roadmap/ }).click();
    await sheet.getByRole("link", { name: "Open in full page", exact: true }).click();
    await expect(reader).toHaveURL(`${url}/tickets/${parent.id}`);
    await expect(reader.getByRole("dialog")).toHaveCount(0);
    await expect(
      reader.getByRole("heading", { name: "Publish the roadmap", level: 1 }),
    ).toBeVisible();
    await expect(reader.getByText("Readers can open every planned item.")).toBeVisible();
    await expect(reader.getByText("Draft the first milestone")).toBeVisible();
    for (const name of ["Edit ticket", "Subscribe", "Archive ticket", "Ticket actions"])
      await expect(reader.getByRole("button", { name })).toHaveCount(0);
    await expect(reader.getByRole("combobox")).toHaveCount(0);

    // Revoked sharing hides a preview's content as it does a page's.
    await reader.goto(`${url}?peek=${parent.id}`);
    await expect(sheet).toBeVisible();
    await page.getByRole("button", { name: "Stop sharing", exact: true }).click();
    await expect(page.getByText("Public link off")).toBeVisible();
    await reader.reload();
    await expect(reader.getByText("This project is not shared").first()).toBeVisible();
    await expect(reader.getByText("Publish the roadmap")).toHaveCount(0);
    await reader.goto(`${url}/tickets/${parent.id}`);
    await expect(reader.getByText("This project is not shared")).toBeVisible();
    await expect(reader.getByText("Publish the roadmap")).toHaveCount(0);
    await reader.goto(url);
    await expect(reader.getByText("This project is not shared")).toBeVisible();
  } finally {
    await context.close();
  }
});
