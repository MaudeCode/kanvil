import { z } from "zod";
import { projectSchema } from "../packages/contracts/src/index.ts";
import { signIn } from "./auth.ts";
import { choose } from "./controls.ts";
import { expect, test } from "./test.ts";

test("the composer and detail page set a ticket's Epic and leave archived Epics out of the choices", async ({
  page,
}) => {
  await signIn(page);
  const project = projectSchema
    .pick({ id: true, workspaceId: true })
    .parse(
      await (
        await page.request.post("/api/v1/projects", { data: { key: "EPICS", name: "Epic work" } })
      ).json(),
    );
  const newEpic = async (title: string) =>
    z.object({ id: z.uuid(), version: z.number() }).parse(
      await (
        await page.request.post(`/api/v1/workspaces/${project.workspaceId}/epics`, {
          data: { title },
        })
      ).json(),
    );
  await newEpic("Launch");
  await newEpic("Migration");
  const archived = await newEpic("Finished");
  await page.request.patch(`/api/v1/workspaces/${project.workspaceId}/epics/${archived.id}`, {
    data: { expectedVersion: archived.version, archived: true },
  });

  await page.goto(`/projects/${project.id}`);
  await page.getByRole("button", { name: "New ticket", exact: true }).click();
  const composer = page.getByRole("dialog");
  await composer.getByLabel("Title", { exact: true }).fill("Plan the launch");
  const pill = composer.getByRole("combobox", { name: "Epic", exact: true });
  await expect(pill).toContainText("No epic");
  await pill.click();
  await expect(page.getByRole("option", { name: "Finished", exact: true })).toHaveCount(0);
  await page.getByRole("option", { name: "Launch", exact: true }).click();
  await expect(pill).toContainText("Launch");
  await composer.getByRole("button", { name: "Create ticket", exact: true }).click();
  await expect(composer).toHaveCount(0);

  await page
    .locator(".ticket-row", { hasText: "Plan the launch" })
    .getByRole("link", { name: "Plan the launch", exact: true })
    .click();
  const properties = page.getByRole("region", { name: "Properties", exact: true });
  const row = properties.getByRole("combobox", { name: "Epic", exact: true });
  await expect(row).toContainText("Launch");
  await choose(page, "Epic", "Migration");
  await expect(row).toContainText("Migration");
  await page.reload();
  await expect(row).toContainText("Migration");
  await choose(page, "Epic", "No epic");
  await expect(row).toContainText("No epic");
});

test("opens and edits a workspace Epic with discussion while member tickets use the ticket preview", async ({
  page,
}) => {
  await signIn(page);
  const project = projectSchema.pick({ id: true, workspaceId: true }).parse(
    await (
      await page.request.post("/api/v1/projects", {
        data: { key: "EPICDETAIL", name: "Epic details" },
      })
    ).json(),
  );
  await page.goto(`/projects/${project.id}`);
  await page.getByRole("link", { name: "Epics", exact: true }).click();
  await page.getByRole("button", { name: "New epic", exact: true }).click();
  const editor = page.getByRole("dialog");
  await editor.getByLabel("Title", { exact: true }).fill("Ship the outcome");
  await editor
    .getByRole("textbox", { name: "Description", exact: true })
    .fill("A description for the whole outcome.");
  await editor
    .getByRole("textbox", { name: "Acceptance criteria", exact: true })
    .fill("The result works across projects.");
  await editor.getByRole("button", { name: "New epic", exact: true }).click();
  await expect(editor).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Ship the outcome", exact: true })).toBeVisible();
  const epicId = z.uuid().parse(new URL(page.url()).pathname.split("/").at(-1));
  const ticket = z.object({ id: z.uuid(), key: z.string() }).parse(
    await (
      await page.request.post(`/api/v1/projects/${project.id}/tickets`, {
        data: { title: "Deliver the member", epicId },
      })
    ).json(),
  );
  await choose(page, "Status", "In progress");
  await choose(page, "Priority", "High");
  await page.getByRole("button", { name: "Edit epic", exact: true }).click();
  await editor
    .getByRole("textbox", { name: "Acceptance criteria", exact: true })
    .fill("Updated acceptance for the Epic.");
  await editor.getByRole("button", { name: "Save", exact: true }).click();
  await expect(editor).toHaveCount(0);
  await page
    .getByRole("textbox", { name: "Comment", exact: true })
    .fill("An Epic discussion note.");
  await page.getByRole("button", { name: "Comment", exact: true }).click();
  await expect(page.getByText("An Epic discussion note.", { exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByRole("combobox", { name: "Status", exact: true })).toContainText(
    "In progress",
  );
  await expect(page.getByRole("combobox", { name: "Priority", exact: true })).toContainText("High");
  await expect(page.getByText("Updated acceptance for the Epic.", { exact: true })).toBeVisible();
  await expect(page.getByText("An Epic discussion note.", { exact: true })).toBeVisible();
  // A refreshed parent must not let an older form overwrite another writer's changes.
  await page.getByRole("button", { name: "Edit epic", exact: true }).click();
  await editor.getByRole("textbox", { name: "Title", exact: true }).fill("My unsaved Epic title");
  const epicPath = `/api/v1/workspaces/${project.workspaceId}/epics/${epicId}`;
  const current = z
    .object({ version: z.number() })
    .parse(await (await page.request.get(epicPath)).json());
  const remote = await page.request.patch(epicPath, {
    data: {
      expectedVersion: current.version,
      description: "Another writer's Epic description.",
    },
  });
  expect(remote.ok()).toBe(true);
  await expect(page.locator("#main")).toContainText("Another writer's Epic description.");
  const saved = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === epicPath && response.request().method() === "PATCH",
  );
  await editor.getByRole("button", { name: "Save", exact: true }).click();
  expect((await saved).status()).toBe(409);
  await expect(editor.getByRole("alert")).toBeVisible();
  await expect(editor.getByRole("textbox", { name: "Title", exact: true })).toHaveValue(
    "My unsaved Epic title",
  );
  const retained = z
    .object({ title: z.string(), description: z.string() })
    .parse(await (await page.request.get(epicPath)).json());
  expect(retained).toMatchObject({
    title: "Ship the outcome",
    description: "Another writer's Epic description.",
  });
  await editor.getByRole("button", { name: "Cancel", exact: true }).click();
  await page.getByRole("link", { name: `${ticket.key} Deliver the member`, exact: true }).click();
  await expect(page.getByRole("dialog")).toContainText("Deliver the member");
  await page.keyboard.press("Escape");
  await expect(page.getByRole("heading", { name: "Ship the outcome", exact: true })).toBeVisible();
  await page.goto(`/projects/${project.id}`);
  await expect(page.locator(".ticket-row")).toHaveCount(1);
  await expect(page.locator(".ticket-row")).toContainText("Deliver the member");
  await page.goto(`/projects/${project.id}/tickets/${ticket.id}`);
  await page.getByRole("link", { name: "Open epic", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Ship the outcome", exact: true })).toBeVisible();
});
