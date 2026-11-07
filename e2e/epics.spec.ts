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
