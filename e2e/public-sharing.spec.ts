import { expect, test } from "@playwright/test";
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
    await reader.getByRole("link", { name: /Publish the roadmap/ }).click();
    await expect(
      reader.getByRole("heading", { name: "Publish the roadmap", level: 1 }),
    ).toBeVisible();
    await expect(reader.getByText("Readers can open every planned item.")).toBeVisible();
    await expect(reader.getByText("Draft the first milestone")).toBeVisible();
    for (const name of ["Edit ticket", "Subscribe", "Archive ticket", "Ticket actions"])
      await expect(reader.getByRole("button", { name })).toHaveCount(0);
    await expect(reader.getByRole("combobox")).toHaveCount(0);

    await page.getByRole("button", { name: "Stop sharing", exact: true }).click();
    await expect(page.getByText("Public link off")).toBeVisible();
    await reader.reload();
    await expect(reader.getByText("This project is not shared")).toBeVisible();
    await expect(reader.getByText("Publish the roadmap")).toHaveCount(0);
    await reader.goto(url);
    await expect(reader.getByText("This project is not shared")).toBeVisible();
  } finally {
    await context.close();
  }
});
