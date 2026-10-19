import { expect, test, type Page } from "@playwright/test";
import { signIn } from "./auth.ts";

const create = async (page: Page, path: string, data: Record<string, unknown>) =>
  (await page.request.post(path, { data })).json();

test("moves a ticket between projects and changes a prefix without breaking old links", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await signIn(page);
  const suffix = crypto.randomUUID().slice(0, 4).toUpperCase();
  const source = await create(page, "/api/v1/projects", {
    key: `FROM${suffix}`,
    name: `Move source ${suffix}`,
  });
  const destination = await create(page, "/api/v1/projects", {
    key: `TO${suffix}`,
    name: `Move destination ${suffix}`,
    workspaceId: source.workspaceId,
    visibility: "workspace",
  });
  const ticket = await create(page, `/api/v1/projects/${source.id}/tickets`, {
    title: "Relocated work",
    status: "in_progress",
  });
  const parent = await create(page, `/api/v1/projects/${source.id}/tickets`, {
    title: "Parent work",
  });
  await create(page, `/api/v1/projects/${source.id}/tickets`, {
    title: "Child work",
    parentId: parent.id,
  });

  await page.goto(`/projects/${source.id}`);
  const row = (title: string) => page.getByRole("link", { name: title, exact: true });
  // A ticket with sub-tickets names what keeps it in place and cannot move.
  await row("Parent work").click({ button: "right" });
  await page.getByRole("menuitem", { name: "Move to project…", exact: true }).click();
  let dialog = page.getByRole("dialog", { name: `Move ${parent.key}`, exact: true });
  await dialog.getByRole("combobox", { name: "Project", exact: true }).click();
  await expect(page.getByRole("option", { name: source.name })).toHaveCount(0);
  await page.getByRole("option", { name: destination.name }).click();
  await expect(dialog.getByText("Resolve before moving", { exact: true })).toBeVisible();
  await expect(dialog.getByText(/Move or detach its sub-tickets/)).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Move ticket", exact: true })).toBeDisabled();
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();

  await row("Relocated work").click({ button: "right" });
  await page.getByRole("menuitem", { name: "Move to project…", exact: true }).click();
  dialog = page.getByRole("dialog", { name: `Move ${ticket.key}`, exact: true });
  await dialog.getByRole("combobox", { name: "Project", exact: true }).click();
  await page.getByRole("option", { name: destination.name }).click();
  // The ticket keeps its status category in the destination's workflow.
  await expect(dialog.getByRole("combobox", { name: "Status", exact: true })).toHaveText(
    /In progress/,
  );
  await dialog.getByRole("button", { name: "Move ticket", exact: true }).click();
  await expect(page.getByText(`Moved to ${destination.key}-1`, { exact: true })).toBeVisible();
  await expect(row("Relocated work")).toHaveCount(0);

  // A link from before the move lands on the ticket in its new project.
  await page.goto(`/projects/${source.id}/tickets/${ticket.id}`);
  await expect(page).toHaveURL(`/projects/${destination.id}/tickets/${ticket.id}`);
  await expect(page.getByRole("heading", { name: "Relocated work", exact: true })).toBeVisible();
  await expect(page.getByText(`${destination.key}-1`).first()).toBeVisible();

  // A new prefix re-keys the tickets; the old key still resolves.
  await page.goto(`/projects/${destination.id}/settings`);
  await page.getByRole("button", { name: "Change prefix", exact: true }).click();
  const change = page.getByRole("dialog", { name: "Change ticket prefix", exact: true });
  await change.getByLabel("Ticket prefix", { exact: true }).fill(`NEW${suffix}`);
  await change.getByRole("button", { name: "Change prefix", exact: true }).click();
  await expect(page.getByText(`Tickets now use NEW${suffix}`, { exact: true })).toBeVisible();
  // Another project cannot take a retired prefix.
  await page.goto(`/projects/${source.id}/settings`);
  await page.getByRole("button", { name: "Change prefix", exact: true }).click();
  await change.getByLabel("Ticket prefix", { exact: true }).fill(destination.key);
  await change.getByRole("button", { name: "Change prefix", exact: true }).click();
  await expect(
    change.getByText("This prefix is in use or reserved by another project"),
  ).toBeVisible();
  const resolved = await (
    await page.request.get(`/api/v1/tickets/resolve?ticketId=${ticket.key}`)
  ).json();
  expect(resolved.ticket).toMatchObject({ id: ticket.id, key: `NEW${suffix}-1` });
  expect(errors).toEqual([]);
});
