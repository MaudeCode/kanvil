import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vite-plus/test";
import { createFixture } from "./test-fixture.ts";
import { createApplication } from "./app.ts";
import { createPollingJob } from "./adapters/polling-jobs.ts";
import { notificationPreferences } from "./schema.ts";
import type { Actor } from "./domain.ts";
import { notificationsSchema, type Project, type Ticket } from "@kanvil/contracts";

describe("notification categories", () => {
  let fixture: Awaited<ReturnType<typeof createFixture>>,
    app: Awaited<ReturnType<typeof createApplication>>;
  let owner: Actor, machine: Actor, project: Project, ticket: Ticket, cookie: string;
  const jobs = new Map<string, () => Promise<unknown>>();
  const request = (path: string, method = "GET", body?: unknown) =>
    app.app.fetch(
      new Request(`${fixture.config.KANVIL_URL}/api/v1${path}`, {
        method,
        headers: {
          Cookie: cookie,
          Origin: fixture.config.KANVIL_URL,
          "Content-Type": "application/json",
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    );
  const inbox = async () =>
    notificationsSchema
      .parse(await (await request("/notifications")).json())
      .filter((item) => item.event.ticketId === ticket.id);
  beforeAll(async () => {
    fixture = await createFixture();
    app = await createApplication(fixture.database, fixture.config, {
      // Test-owned scheduling: jobs run only when a test triggers them.
      jobs: (name, _interval, run) => {
        jobs.set(name, run);
        return createPollingJob(name, 86_400_000, run);
      },
    });
    const created = await fixture.auth.api.createUser({
      body: {
        name: "Category owner",
        email: "categories@example.test",
        password: "Isolated category password 42!",
        role: "user",
      },
    });
    owner = await app.domain.actor(created.user.id);
    machine = await app.domain.actor(created.user.id, {
      ownerId: "category-worker",
      scopes: ["read", "write", "admin"],
    });
    const login = await fixture.auth.handler(
      new Request(`${fixture.config.KANVIL_URL}/api/auth/sign-in/email`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: fixture.config.KANVIL_URL },
        body: JSON.stringify({
          email: "categories@example.test",
          password: "Isolated category password 42!",
        }),
      }),
    );
    cookie = login.headers
      .getSetCookie()
      .map((value) => value.split(";")[0])
      .join("; ");
    project = await app.domain.execute(
      "create_project",
      { key: "CAT", name: "Category project" },
      owner,
    );
  });
  afterAll(async () => {
    await app?.close();
    await fixture?.close();
  });
  beforeEach(async () => {
    await fixture.database.db.delete(notificationPreferences);
    ticket = await app.domain.execute(
      "create_ticket",
      { projectId: project.id, title: "Category ticket" },
      owner,
    );
  });
  it("skips a disabled category and keeps the others", async () => {
    expect(
      (
        await request("/notifications/preferences", "PUT", {
          inApp: true,
          categories: { comment: false },
        })
      ).status,
    ).toBe(200);
    await app.domain.execute(
      "add_comment",
      { projectId: project.id, ticketId: ticket.id, body: "Agent progress" },
      machine,
    );
    await app.domain.execute(
      "update_ticket",
      {
        projectId: project.id,
        ticketId: ticket.id,
        expectedVersion: ticket.version,
        changes: { status: "in_progress" },
      },
      machine,
    );
    expect((await inbox()).map((item) => [item.event.type, item.category])).toEqual([
      ["ticket.updated", "status"],
    ]);
  });
  it("sends one overdue notice from the scheduled reminder job", async () => {
    await app.domain.execute(
      "update_ticket",
      {
        projectId: project.id,
        ticketId: ticket.id,
        expectedVersion: ticket.version,
        changes: { dueAt: new Date(Date.now() - 60_000).toISOString() },
      },
      owner,
    );
    await jobs.get("due-reminders")?.();
    await jobs.get("due-reminders")?.();
    expect((await inbox()).map((item) => [item.event.type, item.category])).toEqual([
      ["ticket.overdue", "overdue"],
    ]);
  });
  it("returns backward-compatible defaults and merges partial category updates", async () => {
    expect(await (await request("/notifications/preferences")).json()).toEqual({
      inApp: true,
      push: false,
      categories: {
        assignment: true,
        status: true,
        comment: true,
        update: true,
        due_soon: true,
        overdue: true,
      },
      reminderLead: { amount: 1, unit: "days" },
    });
    await request("/notifications/preferences", "PUT", {
      inApp: true,
      categories: { status: false },
    });
    const saved = await request("/notifications/preferences", "PUT", {
      inApp: true,
      categories: { overdue: false },
      reminderLead: { amount: 2, unit: "hours" },
    });
    expect(await saved.json()).toMatchObject({
      categories: { status: false, overdue: false, comment: true },
      reminderLead: { amount: 2, unit: "hours" },
    });
    expect(
      (
        await request("/notifications/preferences", "PUT", {
          inApp: true,
          categories: { mentions: false },
        })
      ).status,
    ).toBe(400);
  });
  it("files an edit that changes several properties under the first enabled category", async () => {
    await request("/notifications/preferences", "PUT", {
      inApp: true,
      categories: { assignment: false },
    });
    await app.domain.execute(
      "update_ticket",
      {
        projectId: project.id,
        ticketId: ticket.id,
        expectedVersion: ticket.version,
        changes: { assigneeId: owner.id, status: "in_progress", title: "Renamed" },
      },
      machine,
    );
    await request("/notifications/preferences", "PUT", {
      inApp: true,
      categories: { assignment: true, status: false, update: false },
    });
    await app.domain.execute(
      "update_ticket",
      {
        projectId: project.id,
        ticketId: ticket.id,
        expectedVersion: ticket.version + 1,
        changes: { title: "Renamed again" },
      },
      machine,
    );
    expect((await inbox()).map((item) => [item.event.type, item.category])).toEqual([
      ["ticket.updated", "status"],
    ]);
  });
});
