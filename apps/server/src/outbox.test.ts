import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vite-plus/test";
import { eq } from "drizzle-orm";
import { createFixture } from "./test-fixture.ts";
import { createApplication } from "./app.ts";
import { deliverBatch } from "./outbox.ts";
import { createPollingJob } from "./adapters/polling-jobs.ts";
import { deliverySecrets } from "./sealing.ts";
import { sendDueReminders } from "./reminders.ts";
import { members, deliveries, pushDevices } from "./schema.ts";
import { session } from "./auth-schema.ts";
import type { Actor } from "./domain.ts";
import type { Project, Ticket } from "@kanvil/contracts";
import type { ExpoPushMessage, ExpoPushReceipt, ExpoPushTicket } from "expo-server-sdk";
import { createClient } from "@kanvil/client";

describe("durable optional native push", () => {
  let fixture: Awaited<ReturnType<typeof createFixture>>,
    app: Awaited<ReturnType<typeof createApplication>>;
  let owner: Actor, machine: Actor, project: Project, ticket: Ticket, cookie: string;
  let revokeOnSend = false;
  let sent: ExpoPushMessage[], mode: "ok" | "offline" | "unregistered";
  const token = "ExponentPushToken[kanvil-isolated-test]";
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
  const transport = {
    async sendPushNotificationsAsync(messages: ExpoPushMessage[]): Promise<ExpoPushTicket[]> {
      sent.push(...messages);
      if (revokeOnSend)
        await fixture.database.db.delete(members).where(eq(members.projectId, project.id));
      if (mode === "offline") throw new Error("Isolated transport failure");
      return mode === "unregistered"
        ? [{ status: "error", message: "Gone", details: { error: "DeviceNotRegistered" } }]
        : [{ status: "ok", id: "test-receipt" }];
    },
    async getPushNotificationReceiptsAsync(): Promise<Record<string, ExpoPushReceipt>> {
      return { "test-receipt": { status: "ok" } };
    },
  };
  async function signIn(email: string) {
    const login = await fixture.auth.handler(
      new Request(`${fixture.config.KANVIL_URL}/api/auth/sign-in/email`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: fixture.config.KANVIL_URL },
        body: JSON.stringify({ email: email, password: "Isolated push password 42!" }),
      }),
    );
    return login.headers
      .getSetCookie()
      .map((value) => value.split(";")[0])
      .join("; ");
  }
  const tick = (pushEnabled = true) =>
    deliverBatch(
      fixture.database,
      { ...fixture.config, KANVIL_PUSH_ENABLED: pushEnabled },
      { push: transport, http: async () => ({ status: 500 }) },
      deliverySecrets(fixture.config),
    );
  beforeAll(async () => {
    fixture = await createFixture();
    app = await createApplication(
      fixture.database,
      { ...fixture.config, KANVIL_PUSH_ENABLED: true },
      // Test-owned scheduling and transports: only `tick` sends, and nothing leaves the machine.
      {
        jobs: (name, _interval, run) => createPollingJob(name, 86_400_000, run),
        senders: () => ({ push: transport, http: async () => ({ status: 500 }) }),
      },
    );
    const created = await fixture.auth.api.createUser({
      body: {
        name: "Push owner",
        email: "push@example.test",
        password: "Isolated push password 42!",
        role: "user",
      },
    });
    owner = await app.domain.actor(created.user.id);
    const administrator = await fixture.auth.api.createUser({
      body: {
        name: "Workspace administrator",
        email: "workspace-admin@example.test",
        password: "Isolated push password 42!",
        role: "user",
      },
    });
    const workspaceAdmin = await app.domain.actor(administrator.user.id);
    const workspace = await app.domain.execute(
      "create_workspace",
      { name: "Push workspace", slug: "push-workspace" },
      workspaceAdmin,
    );
    await app.domain.execute(
      "set_workspace_member",
      { workspaceId: workspace.id, email: created.user.email, role: "writer" },
      workspaceAdmin,
    );

    machine = await app.domain.actor(created.user.id, {
      ownerId: "test-worker",
      scopes: ["read", "write", "admin"],
    });
  });
  afterAll(async () => {
    await app?.close();
    await fixture?.close();
  });
  beforeEach(async () => {
    await fixture.database.db.delete(pushDevices);
    cookie = await signIn("push@example.test");
    revokeOnSend = false;
    mode = "ok";
    sent = [];
    project = await app.domain.execute(
      "create_project",
      { key: `P${crypto.randomUUID().slice(0, 8).toUpperCase()}`, name: "Push project" },
      owner,
    );
    ticket = await app.domain.execute(
      "create_ticket",
      { projectId: project.id, title: "Private ticket title" },
      owner,
    );
    await app.domain.execute(
      "set_subscription",
      { projectId: project.id, ticketId: ticket.id, enabled: true },
      owner,
    );
    expect(
      (await request("/notifications/preferences", "PUT", { inApp: false, push: true })).status,
    ).toBe(200);
    expect((await request("/notifications/device", "POST", { token })).status).toBe(200);
    await app.domain.execute(
      "add_comment",
      { projectId: project.id, ticketId: ticket.id, body: "Agent progress" },
      machine,
    );
  });
  it("commits the outbox with the event, retains receipts across workers, and excludes private ticket text", async () => {
    expect(await (await request("/notifications")).json()).toEqual([]);
    expect(await fixture.database.db.select().from(deliveries)).toHaveLength(1);
    await tick();
    expect(sent).toHaveLength(1);
    expect(JSON.stringify(sent)).not.toContain(ticket.title);
    expect(sent[0]?.data).toMatchObject({ projectId: project.id, ticketId: ticket.id });
    expect((await fixture.database.db.select().from(deliveries))[0]).toMatchObject({
      receiptId: "test-receipt",
      finishedAt: null,
    });
    await fixture.database.db.update(deliveries).set({ availableAt: new Date(0) });
    await tick();
    expect(sent).toHaveLength(1);
    expect((await fixture.database.db.select().from(deliveries))[0]?.finishedAt).toBeInstanceOf(
      Date,
    );
  });
  it("retries a transport failure after restart and removes unregistered devices", async () => {
    mode = "offline";
    await tick();
    expect((await fixture.database.db.select().from(deliveries))[0]).toMatchObject({
      attempts: 1,
      error: "transport_error",
      finishedAt: null,
    });
    mode = "unregistered";
    await fixture.database.db.update(deliveries).set({ availableAt: new Date(0) });
    await tick();
    expect(await fixture.database.db.select().from(pushDevices)).toHaveLength(0);
    expect(await fixture.database.db.select().from(deliveries)).toHaveLength(0);
  });
  it("rechecks project access before sending queued work", async () => {
    await fixture.database.db.delete(members).where(eq(members.projectId, project.id));
    await tick();
    expect(sent).toHaveLength(0);
    expect((await fixture.database.db.select().from(deliveries))[0]?.error).toBe("access_revoked");
  });
  it("removes device registrations and pending delivery when the login session is revoked", async () => {
    const device = (await fixture.database.db.select().from(pushDevices))[0];
    expect(device).toBeDefined();
    await fixture.database.db.delete(session).where(eq(session.id, device!.sessionId));
    expect(await fixture.database.db.select().from(pushDevices)).toHaveLength(0);
    expect(await fixture.database.db.select().from(deliveries)).toHaveLength(0);
    await tick();
    expect(sent).toHaveLength(0);
  });
  it("rechecks access for each send when membership changes during a batch", async () => {
    await app.domain.execute(
      "add_comment",
      { projectId: project.id, ticketId: ticket.id, body: "Another update" },
      machine,
    );
    revokeOnSend = true;
    await tick();
    expect(sent).toHaveLength(1);
    expect(
      (await fixture.database.db.select().from(deliveries)).filter(
        (row) => row.error === "access_revoked",
      ),
    ).toHaveLength(1);
  });
  it("clears another account's pending deliveries when a shared device changes account", async () => {
    const previous = (await fixture.database.db.select().from(pushDevices))[0];
    const email = `other-${crypto.randomUUID()}@example.test`;
    const other = await fixture.auth.api.createUser({
      body: { name: "Other owner", email, password: "Isolated push password 42!", role: "user" },
    });
    cookie = await signIn(email);
    expect((await request("/notifications/device", "POST", { token })).status).toBe(200);
    const current = (await fixture.database.db.select().from(pushDevices))[0];
    expect(current?.id).not.toBe(previous?.id);
    expect(current?.userId).toBe(other.user.id);
    expect(await fixture.database.db.select().from(deliveries)).toHaveLength(0);
    await tick();
    expect(sent).toHaveLength(0);
  });
  it("preserves push opt-in when an older client updates only its Inbox preference", async () => {
    const client = createClient({
      baseUrl: fixture.config.KANVIL_URL,
      headers: () => ({ Cookie: cookie, Origin: fixture.config.KANVIL_URL }),
      fetch: async (input, init) => app.app.fetch(new Request(input, init)),
    });
    expect(await client.setNotificationPreferences({ inApp: true })).toMatchObject({
      inApp: true,
      push: true,
    });
    expect(await (await request("/notifications/preferences")).json()).toMatchObject({
      inApp: true,
      push: true,
    });
  });
  it("delivers queued updates and the deletion notice after subscriptions cascade away", async () => {
    await app.domain.execute(
      "delete_ticket",
      { projectId: project.id, ticketId: ticket.id, expectedVersion: ticket.version },
      machine,
    );
    await tick();
    expect(sent).toHaveLength(2);
    expect(
      (await fixture.database.db.select().from(deliveries)).some(
        (row) => row.error === "access_revoked",
      ),
    ).toBe(false);
  });
  it("keeps queued notices cancelled after an explicit unsubscribe and later ticket deletion", async () => {
    await app.domain.execute(
      "set_subscription",
      { projectId: project.id, ticketId: ticket.id, enabled: false },
      owner,
    );
    await app.domain.execute(
      "delete_ticket",
      { projectId: project.id, ticketId: ticket.id, expectedVersion: ticket.version },
      machine,
    );
    await tick();
    expect(sent).toHaveLength(0);
    expect((await fixture.database.db.select().from(deliveries))[0]?.error).toBe("unsubscribed");
  });
  it("pushes a mention to a member who does not follow the ticket", async () => {
    const teammate = await fixture.auth.api.createUser({
      body: {
        name: "Push teammate",
        email: `teammate-${crypto.randomUUID()}@example.test`,
        password: "Isolated push password 42!",
        role: "user",
      },
    });
    await app.domain.execute(
      "set_member",
      { projectId: project.id, email: teammate.user.email, role: "writer" },
      owner,
    );
    await app.domain.execute(
      "add_comment",
      {
        projectId: project.id,
        ticketId: ticket.id,
        body: `[@Push owner](mention:${owner.id}) please look`,
      },
      await app.domain.actor(teammate.user.id),
    );
    // Unfollowing after the mention cancels the follower updates but keeps the mention's push.
    await app.domain.execute(
      "set_subscription",
      { projectId: project.id, ticketId: ticket.id, enabled: false },
      owner,
    );
    await tick();
    expect(sent.map((message) => message.body)).toEqual(["You were mentioned in a comment."]);
  });
  it("stops sending to registered devices once push is turned off", async () => {
    await tick(false);
    expect(sent).toHaveLength(0);
    expect((await fixture.database.db.select().from(deliveries))[0]?.error).toBe("push_disabled");
  });
  it("drops a queued notice whose category was turned off before sending", async () => {
    await request("/notifications/preferences", "PUT", {
      inApp: false,
      categories: { comment: false },
    });
    await tick();
    expect(sent).toHaveLength(0);
    expect((await fixture.database.db.select().from(deliveries))[0]?.error).toBe(
      "category_disabled",
    );
  });
  it("drops a queued reminder once its ticket is completed", async () => {
    await tick();
    const dueAt = new Date(Date.now() + 86_400_000);
    const updated = await app.domain.execute(
      "update_ticket",
      {
        projectId: project.id,
        ticketId: ticket.id,
        expectedVersion: ticket.version,
        changes: { dueAt: dueAt.toISOString() },
      },
      machine,
    );
    await tick();
    sent = [];
    expect(await sendDueReminders(fixture.database, dueAt)).toBe(1);
    await app.domain.execute(
      "update_ticket",
      {
        projectId: project.id,
        ticketId: ticket.id,
        expectedVersion: updated.version,
        changes: { status: "done" },
      },
      machine,
    );
    await fixture.database.db.update(deliveries).set({ availableAt: new Date(0) });
    await tick();
    expect(sent.filter((message) => message.data?.ticketId === ticket.id)).toHaveLength(1);
    expect((await fixture.database.db.select().from(deliveries)).map((row) => row.error)).toContain(
      "reminder_stale",
    );
  });
  it("drops a queued reminder once its project is archived", async () => {
    await tick();
    const dueAt = new Date(Date.now() + 86_400_000);
    await app.domain.execute(
      "update_ticket",
      {
        projectId: project.id,
        ticketId: ticket.id,
        expectedVersion: ticket.version,
        changes: { dueAt: dueAt.toISOString() },
      },
      machine,
    );
    await tick();
    sent = [];
    expect(await sendDueReminders(fixture.database, dueAt)).toBe(1);
    const current = await app.domain.execute("get_project", { projectId: project.id }, owner);
    await app.domain.execute(
      "archive_project",
      { projectId: project.id, expectedVersion: current.version, archived: true },
      owner,
    );
    await fixture.database.db.update(deliveries).set({ availableAt: new Date(0) });
    await tick();
    expect(sent.filter((message) => message.data?.ticketId === ticket.id)).toHaveLength(0);
    expect((await fixture.database.db.select().from(deliveries)).map((row) => row.error)).toContain(
      "reminder_stale",
    );
  });
});
