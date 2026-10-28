import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vite-plus/test";
import { createHmac } from "node:crypto";
import { createServer as createTcpServer, type AddressInfo } from "node:net";
import { eq } from "drizzle-orm";
import type { Project, Ticket } from "@kanvil/contracts";
import {
  createFixture,
  startMailbox,
  startHttpReceiver,
  type ReceivedRequest,
} from "./test-fixture.ts";
import { createApplication } from "./app.ts";
import { createPollingJob } from "./adapters/polling-jobs.ts";
import { createHttpSender, createMailSender } from "./adapters/outbound.ts";
import type { OutboundSenders } from "./adapters/ports.ts";
import { deliverBatch, outbound } from "./outbox.ts";
import { defaultAdapters } from "./runtime-adapters.ts";
import { deliverySecrets } from "./sealing.ts";
import {
  deliveries,
  events,
  members,
  notificationChannels,
  projectDestinations,
} from "./schema.ts";
import type { Actor } from "./domain.ts";

function portOf(address: string | AddressInfo | null) {
  if (!address || typeof address === "string") throw new Error("Expected a TCP listener");
  return address.port;
}
// A local HTTP receiver standing in for webhooks, ntfy, Gotify, and chat services.
async function receiver() {
  const state = { status: 200, location: "", received: [] as ReceivedRequest[] };
  const http = await startHttpReceiver((request, response) => {
    state.received.push(request);
    response.writeHead(state.status, state.location ? { Location: state.location } : {});
    response.end();
  });
  return { state, ...http };
}
describe("notification channels and project destinations", () => {
  let fixture: Awaited<ReturnType<typeof createFixture>>,
    app: Awaited<ReturnType<typeof createApplication>>,
    http: Awaited<ReturnType<typeof receiver>>,
    mail: Awaited<ReturnType<typeof startMailbox>>;
  let owner: Actor, machine: Actor, reader: Actor, project: Project, ticket: Ticket;
  const secrets = () => deliverySecrets(fixture.config);
  const senders = (allowPrivate = true): OutboundSenders => ({
    push: {
      sendPushNotificationsAsync: async () => [],
      getPushNotificationReceiptsAsync: async () => ({}),
    },
    http: createHttpSender({ allowPrivate, timeout: 2000 }),
    mail: createMailSender(mail.url, "Kanvil <kanvil@example.test>"),
  });
  const tick = (allowPrivate = true) =>
    deliverBatch(
      fixture.database,
      fixture.config,
      senders(allowPrivate),
      secrets(),
      defaultAdapters.repositories(fixture.config),
    );
  const queued = () => fixture.database.db.select().from(deliveries);
  const comment = (body = "Agent progress") =>
    app.domain.execute(
      "add_comment",
      { projectId: project.id, ticketId: ticket.id, body },
      machine,
    );
  const route = () => [
    { workspaceId: project.workspaceId, mode: "selected" as const, projectIds: [project.id] },
  ];
  async function user(email: string) {
    const created = await fixture.auth.api.createUser({
      body: { name: email, email, password: "Isolated delivery password 42!", role: "user" },
    });
    return app.domain.actor(created.user.id);
  }
  beforeAll(async () => {
    fixture = await createFixture();
    http = await receiver();
    mail = await startMailbox();
    app = await createApplication(fixture.database, fixture.config, {
      jobs: (name, _interval, run) => createPollingJob(name, 86_400_000, run),
      senders: () => senders(),
    });
    owner = await user("delivery-owner@example.test");
    reader = await user("delivery-reader@example.test");
    machine = await app.domain.actor(owner.id, {
      ownerId: "delivery-worker",
      scopes: ["read", "write", "admin"],
    });
  });
  afterAll(async () => {
    await http?.close();
    await mail?.close();
    await app?.close();
    await fixture?.close();
  });
  beforeEach(async () => {
    await fixture.database.db.delete(notificationChannels);
    http.state.status = 200;
    http.state.location = "";
    http.state.received = [];
    mail.messages.length = 0;
    project = await app.domain.execute(
      "create_project",
      { key: `D${crypto.randomUUID().slice(0, 8).toUpperCase()}`, name: "Delivery project" },
      owner,
    );
    ticket = await app.domain.execute(
      "create_ticket",
      { projectId: project.id, title: "Rotate the signing key" },
      owner,
    );
    await app.domain.execute(
      "set_subscription",
      { projectId: project.id, ticketId: ticket.id, enabled: true },
      owner,
    );
  });

  it("masks and encrypts secrets, signs webhooks, and sends each notification once", async () => {
    const channel = await app.domain.execute(
      "create_notification_channel",
      {
        name: "Automation hook",
        settings: { kind: "webhook", url: `${http.url}/hook`, secret: "signing-secret-42" },
        routes: route(),
      },
      owner,
    );
    expect(channel).toMatchObject({
      kind: "webhook",
      settings: { url: `${http.url}/hook` },
      secrets: ["secret"],
      endpoint: `127.0.0.1:${http.port}`,
      health: { status: "idle", pending: 0 },
    });
    expect(JSON.stringify(channel)).not.toContain("signing-secret-42");
    const [stored] = await fixture.database.db.select().from(notificationChannels);
    expect(stored?.settings).not.toContain("signing-secret-42");
    expect(stored?.settings).not.toContain("/hook");

    await comment();
    // The outbox row commits with the event.
    expect(await queued()).toHaveLength(1);
    await tick();
    await tick();
    expect(http.state.received).toHaveLength(1);
    const [request] = http.state.received;
    const [job] = await queued();
    expect(job).toMatchObject({ error: null, attempts: 0 });
    expect(job?.finishedAt).toBeInstanceOf(Date);
    expect(request?.headers["kanvil-delivery"]).toBe(job?.id);
    expect(request?.headers["kanvil-event"]).toBe("comment.created");
    const timestamp = String(request?.headers["kanvil-timestamp"]);
    expect(request?.headers["kanvil-signature"]).toBe(
      `v1=${createHmac("sha256", "signing-secret-42").update(`${timestamp}.${request?.body}`).digest("hex")}`,
    );
    expect(JSON.parse(request?.body ?? "{}")).toMatchObject({
      id: job?.id,
      type: "comment.created",
      title: `${ticket.key} Rotate the signing key`,
      text: "Comment added by delivery-owner@example.test",
    });
    const [listed] = await app.domain.execute("list_notification_channels", {}, owner);
    expect(listed?.health).toMatchObject({ status: "ok", error: null, pending: 0 });
  });

  it("keeps configuration while paused or unrouted and keeps secrets through edits", async () => {
    let channel = await app.domain.execute(
      "create_notification_channel",
      {
        name: "Phone",
        settings: { kind: "ntfy", topic: "kanvil-alerts", token: "tk_private", server: http.url },
        routes: route(),
      },
      owner,
    );
    channel = await app.domain.execute(
      "update_notification_channel",
      { channelId: channel.id, expectedVersion: channel.version, paused: true },
      owner,
    );
    await comment();
    expect(await queued()).toHaveLength(0);
    channel = await app.domain.execute(
      "update_notification_channel",
      {
        channelId: channel.id,
        expectedVersion: channel.version,
        paused: false,
        routes: [{ ...route()[0]!, mode: "off" }],
      },
      owner,
    );
    await comment("Second update");
    expect(await queued()).toHaveLength(0);
    expect(channel.routes).toEqual([{ ...route()[0], mode: "off" }]);
    expect(channel.secrets).toEqual(["token"]);
    await expect(
      app.domain.execute(
        "update_notification_channel",
        { channelId: channel.id, expectedVersion: 1, name: "Stale" },
        owner,
      ),
    ).rejects.toMatchObject({ code: "version_conflict" });
    channel = await app.domain.execute(
      "update_notification_channel",
      {
        channelId: channel.id,
        expectedVersion: channel.version,
        settings: { kind: "ntfy", topic: "kanvil-renamed" },
        routes: route(),
      },
      owner,
    );
    expect(channel).toMatchObject({ settings: { topic: "kanvil-renamed" }, secrets: ["token"] });
    await comment("Third update");
    await tick();
    expect(http.state.received).toHaveLength(1);
    expect(http.state.received[0]?.headers.authorization).toBe("Bearer tk_private");
    expect(JSON.parse(http.state.received[0]?.body ?? "{}")).toMatchObject({
      topic: "kanvil-renamed",
      title: `${ticket.key} Rotate the signing key`,
    });
    // An empty optional secret clears it.
    channel = await app.domain.execute(
      "update_notification_channel",
      {
        channelId: channel.id,
        expectedVersion: channel.version,
        settings: { kind: "ntfy", token: "" },
      },
      owner,
    );
    expect(channel.secrets).toEqual([]);
    await app.domain.execute(
      "delete_notification_channel",
      { channelId: channel.id, expectedVersion: channel.version },
      owner,
    );
    expect(await app.domain.execute("list_notification_channels", {}, owner)).toEqual([]);
  });

  it("sends email through the instance SMTP relay and reports test results as health", async () => {
    const channel = await app.domain.execute(
      "create_notification_channel",
      { name: "Work email", settings: { kind: "email", address: "me@example.test" } },
      owner,
    );
    await app.domain.execute("test_notification_channel", { channelId: channel.id }, owner);
    expect(
      (await app.domain.execute("list_notification_channels", {}, owner))[0]?.health,
    ).toMatchObject({ pending: 1 });
    await tick();
    expect(mail.messages).toHaveLength(1);
    expect(mail.messages[0]).toContain("To: me@example.test");
    expect(mail.messages[0]).toContain("Subject: Kanvil test");
    expect(
      (await app.domain.execute("list_notification_channels", {}, owner))[0]?.health,
    ).toMatchObject({ status: "ok", pending: 0 });
  });

  it("bounds retries, records failures, and resumes queued work in a new worker", async () => {
    const channel = await app.domain.execute(
      "create_notification_channel",
      {
        name: "Flaky hook",
        settings: { kind: "webhook", url: http.url },
        routes: [{ workspaceId: project.workspaceId, mode: "all" }],
      },
      owner,
    );
    http.state.status = 503;
    await comment();
    for (let attempt = 1; attempt <= 5; attempt++) {
      await tick();
      const [job] = await queued();
      expect(job).toMatchObject({ attempts: attempt, error: "http_503" });
      expect(job?.finishedAt === null).toBe(attempt < 5);
      await fixture.database.db.update(deliveries).set({ availableAt: new Date(0) });
    }
    expect(http.state.received).toHaveLength(5);
    expect(
      (await app.domain.execute("list_notification_channels", {}, owner))[0]?.health,
    ).toMatchObject({ status: "failing", error: "http_503" });
    // A rejected request is final; a later success clears the failure.
    await fixture.database.db.delete(deliveries);
    http.state.status = 404;
    await comment("Rejected");
    await tick();
    expect((await queued())[0]).toMatchObject({ attempts: 0, error: "http_404" });
    // A row left by a stopped worker is sent by the next one.
    http.state.status = 200;
    await comment("After restart");
    await tick();
    expect(http.state.received.at(-1)?.body).toContain("comment.created");
    expect((await app.domain.execute("list_notification_channels", {}, owner))[0]?.id).toBe(
      channel.id,
    );
    expect(
      (await app.domain.execute("list_notification_channels", {}, owner))[0]?.health.status,
    ).toBe("ok");
  });

  it("rechecks project access before every send", async () => {
    await app.domain.execute(
      "set_member",
      { projectId: project.id, email: "delivery-reader@example.test", role: "reader" },
      owner,
    );
    await app.domain.execute(
      "set_subscription",
      { projectId: project.id, ticketId: ticket.id, enabled: true },
      reader,
    );
    await app.domain.execute(
      "create_notification_channel",
      { name: "Hook", settings: { kind: "webhook", url: http.url }, routes: route() },
      reader,
    );
    await comment();
    expect(await queued()).toHaveLength(1);
    await fixture.database.db.delete(members).where(eq(members.projectId, project.id));
    await tick();
    expect(http.state.received).toHaveLength(0);
    expect((await queued())[0]?.error).toBe("access_revoked");
  });

  it("sends a mention to a member's channel without a subscription", async () => {
    await app.domain.execute(
      "set_member",
      { projectId: project.id, email: "delivery-reader@example.test", role: "reader" },
      owner,
    );
    await app.domain.execute(
      "create_notification_channel",
      { name: "Hook", settings: { kind: "webhook", url: http.url }, routes: route() },
      reader,
    );
    await app.domain.execute(
      "add_comment",
      { projectId: project.id, ticketId: ticket.id, body: `[@Reader](mention:${reader.id}) look` },
      owner,
    );
    await tick();
    expect(http.state.received).toHaveLength(1);
    expect(JSON.parse(http.state.received[0]?.body ?? "{}").text).toBe(
      "delivery-owner@example.test mentioned you in a comment",
    );
  });

  it("blocks private addresses, DNS names that resolve to them, and redirects", async () => {
    const send = createHttpSender({ allowPrivate: false, timeout: 2000 });
    for (const url of [
      http.url,
      `http://localhost:${http.port}`,
      "http://[::1]/",
      "http://169.254.169.254/",
      "http://[64:ff9b:1::a00:1]/",
      "http://[fec0::1]/",
    ])
      await expect(send({ url, body: "{}" })).rejects.toMatchObject({ code: "blocked_address" });
    expect(http.state.received).toHaveLength(0);

    await app.domain.execute(
      "create_notification_channel",
      { name: "Internal", settings: { kind: "webhook", url: http.url }, routes: route() },
      owner,
    );
    await comment();
    await tick(false);
    expect((await queued())[0]).toMatchObject({ error: "blocked_address", attempts: 0 });
    expect(http.state.received).toHaveLength(0);

    await fixture.database.db.delete(deliveries);
    http.state.status = 302;
    http.state.location = "http://169.254.169.254/latest/meta-data";
    await comment("Redirected");
    await tick();
    expect(http.state.received).toHaveLength(1);
    expect((await queued())[0]?.error).toBe("redirect_blocked");
  });

  it("gives up on an endpoint that never answers", async () => {
    const silent = createTcpServer(() => {});
    await new Promise<void>((done) => silent.listen(0, "127.0.0.1", done));
    try {
      await expect(
        createHttpSender({ allowPrivate: true, timeout: 200 })({
          url: `http://127.0.0.1:${portOf(silent.address())}`,
          body: "{}",
        }),
      ).rejects.toMatchObject({ code: "timeout", retry: true });
    } finally {
      silent.close();
    }
  });

  it("limits channels to the account's own sessions and validates settings", async () => {
    await expect(
      app.domain.execute("list_notification_channels", {}, machine),
    ).rejects.toMatchObject({ code: "session_required" });
    await expect(
      app.domain.execute(
        "create_notification_channel",
        { name: "No token", settings: { kind: "gotify", server: http.url } },
        owner,
      ),
    ).rejects.toMatchObject({ name: "ZodError" });
    await expect(
      app.domain.execute(
        "create_notification_channel",
        { name: "Chat", settings: { kind: "slack", url: http.url } },
        owner,
      ),
    ).rejects.toMatchObject({ code: "validation_error" });
    await expect(
      app.domain.execute(
        "create_notification_channel",
        { name: "Inline", settings: { kind: "webhook", url: "https://user:pass@example.test" } },
        owner,
      ),
    ).rejects.toMatchObject({ name: "ZodError" });
    const mine = await app.domain.execute(
      "create_notification_channel",
      { name: "Mine", settings: { kind: "email", address: "me@example.test" } },
      owner,
    );
    await expect(
      app.domain.execute("test_notification_channel", { channelId: mine.id }, reader),
    ).rejects.toMatchObject({ code: "not_found" });
  });

  it("lets project administrators route ticket activity by event to destinations", async () => {
    await app.domain.execute(
      "set_member",
      { projectId: project.id, email: "delivery-reader@example.test", role: "writer" },
      owner,
    );
    await expect(
      app.domain.execute(
        "create_project_destination",
        {
          projectId: project.id,
          name: "Chat",
          settings: { kind: "slack", url: http.url },
          events: ["created"],
        },
        reader,
      ),
    ).rejects.toMatchObject({ code: "forbidden" });
    const slack = await app.domain.execute(
      "create_project_destination",
      {
        projectId: project.id,
        name: "Team chat",
        settings: { kind: "slack", url: `${http.url}/services/T000/B000/secretpath` },
        events: ["created"],
      },
      owner,
    );
    expect(slack).toMatchObject({
      settings: {},
      secrets: ["url"],
      endpoint: `127.0.0.1:${http.port}`,
    });
    const hook = await app.domain.execute(
      "create_project_destination",
      {
        projectId: project.id,
        name: "Audit hook",
        settings: { kind: "webhook", url: `${http.url}/audit`, secret: "project-secret" },
        events: ["comment"],
      },
      owner,
    );
    const recorded = await fixture.database.db
      .select()
      .from(events)
      .where(eq(events.type, "destination.created"));
    expect(recorded).toHaveLength(2);
    expect(JSON.stringify(recorded.map((row) => row.data))).not.toMatch(
      /secretpath|project-secret/,
    );

    await comment("@channel please look");
    await app.domain.execute(
      "create_ticket",
      { projectId: project.id, title: "Ping <!channel> & everyone" },
      machine,
    );
    await tick();
    expect(http.state.received.map((item) => item.url).toSorted()).toEqual([
      "/audit",
      "/services/T000/B000/secretpath",
    ]);
    const chat = http.state.received.find((item) => item.url !== "/audit");
    expect(JSON.parse(chat?.body ?? "{}").text).toContain("Ping &lt;!channel&gt; &amp; everyone");
    const destinations = await app.domain.execute(
      "list_project_destinations",
      { projectId: project.id },
      owner,
    );
    expect(destinations.map((item) => item.health.status)).toEqual(["ok", "ok"]);

    // Paused destinations and removed events stop new deliveries; deletion discards the queue.
    await app.domain.execute(
      "update_project_destination",
      {
        projectId: project.id,
        destinationId: hook.id,
        expectedVersion: hook.version,
        paused: true,
      },
      owner,
    );
    await comment("Paused");
    await app.domain.execute(
      "test_project_destination",
      { projectId: project.id, destinationId: slack.id },
      owner,
    );
    await app.domain.execute(
      "delete_project_destination",
      { projectId: project.id, destinationId: slack.id, expectedVersion: slack.version },
      owner,
    );
    await tick();
    expect(http.state.received).toHaveLength(2);
    expect(
      await fixture.database.db
        .select()
        .from(projectDestinations)
        .where(eq(projectDestinations.projectId, project.id)),
    ).toHaveLength(1);
  });

  it("formats Telegram, Discord, Mattermost, and Gotify requests", () => {
    const message = {
      title: "KAN-1 Fix",
      text: "Comment added by @ana",
      url: "https://kanvil.test/x",
    };
    const row = { deliveryId: "job", event: null, project: null };
    expect(
      outbound(
        { kind: "telegram", token: "123:abcdefghijklmnopqrstuvwxyz", chatId: "-100", topicId: 7 },
        message,
        row,
      ),
    ).toMatchObject({
      http: { url: "https://api.telegram.org/bot123:abcdefghijklmnopqrstuvwxyz/sendMessage" },
    });
    const telegram = outbound(
      { kind: "telegram", token: "123:abcdefghijklmnopqrstuvwxyz", chatId: "-100", topicId: 7 },
      message,
      row,
    );
    expect("http" in telegram && JSON.parse(telegram.http.body)).toMatchObject({
      chat_id: "-100",
      message_thread_id: 7,
      text: "KAN-1 Fix: Comment added by @\u200bana\nhttps://kanvil.test/x",
    });
    const discord = outbound({ kind: "discord", url: "https://discord.test/hook" }, message, row);
    expect("http" in discord && JSON.parse(discord.http.body)).toMatchObject({
      allowed_mentions: { parse: [] },
    });
    const mattermost = outbound(
      { kind: "mattermost", url: "https://chat.test/hooks/x", channel: "town-square" },
      message,
      row,
    );
    expect("http" in mattermost && JSON.parse(mattermost.http.body)).toMatchObject({
      channel: "town-square",
      text: "KAN-1 Fix: Comment added by @​ana https://kanvil.test/x",
    });
    expect(
      outbound({ kind: "gotify", server: "https://push.test/gotify", token: "app" }, message, row),
    ).toMatchObject({
      http: { url: "https://push.test/gotify/message", headers: { "X-Gotify-Key": "app" } },
    });
  });
});
