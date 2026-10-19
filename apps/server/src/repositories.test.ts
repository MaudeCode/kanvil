import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vite-plus/test";
import { createHmac } from "node:crypto";
import { createServer, type IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";
import { and, eq, isNotNull } from "drizzle-orm";
import type { Project, RepositoryConnection, Ticket } from "@kanvil/contracts";
import { createFixture } from "./test-fixture.ts";
import { createApplication } from "./app.ts";
import { createPollingJob } from "./adapters/polling-jobs.ts";
import { createHttpSender } from "./adapters/outbound.ts";
import { createGitHubDriver } from "./adapters/github.ts";
import { defaultAdapters } from "./runtime-adapters.ts";
import { deliverBatch } from "./outbox.ts";
import { deliverySecrets } from "./sealing.ts";
import { deliveries, events, receivedWebhooks, repositoryConnections } from "./schema.ts";
import type { Actor } from "./domain.ts";

function portOf(address: string | AddressInfo | null) {
  if (!address || typeof address === "string") throw new Error("Expected a TCP listener");
  return address.port;
}
type Received = { method: string; url: string; headers: IncomingHttpHeaders; body: string };
// A loopback stand-in for the GitHub, Gitea, and GitLab REST APIs. `statuses` answers each request in turn, then 200.
async function fakeGitHub() {
  const state = { statuses: [] as number[], received: [] as Received[] };
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk: Buffer) => (body += chunk.toString()));
    request.on("end", () => {
      state.received.push({
        method: request.method ?? "",
        url: request.url ?? "",
        headers: request.headers,
        body,
      });
      response.writeHead(state.statuses.shift() ?? 200, { "Content-Type": "application/json" });
      response.end("{}");
    });
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const port = portOf(server.address());
  const origin = `http://127.0.0.1:${port}`;
  return { state, origin, url: `${origin}/api/v3`, close: () => server.close() };
}
const repository = { full_name: "acme/widgets", html_url: "https://github.com/acme/widgets" };
const pullRequest = (
  number: number,
  action: string,
  {
    title = "Fix the widget",
    ref = "fix",
    state = "open",
    draft = false,
    merged = false,
    at = "2030-01-01T10:00:00Z",
  } = {},
) => ({
  action,
  number,
  pull_request: {
    number,
    html_url: `https://github.com/acme/widgets/pull/${number}`,
    title,
    state,
    draft,
    merged,
    updated_at: at,
    head: { ref },
  },
  repository,
});

describe("repository connections", () => {
  let fixture: Awaited<ReturnType<typeof createFixture>>,
    app: Awaited<ReturnType<typeof createApplication>>,
    github: Awaited<ReturnType<typeof fakeGitHub>>;
  let owner: Actor, admin: Actor, writer: Actor, project: Project, ticket: Ticket;
  let states: Record<string, string>;
  const repositories = () => ({
    ...defaultAdapters.repositories(fixture.config),
    github: createGitHubDriver(github.url),
  });
  const tick = (allowPrivate = true) =>
    deliverBatch(
      fixture.database,
      fixture.config,
      {
        push: {
          sendPushNotificationsAsync: async () => [],
          getPushNotificationReceiptsAsync: async () => ({}),
        },
        http: createHttpSender({ allowPrivate, timeout: 2000 }),
      },
      deliverySecrets(fixture.config),
      repositories(),
    );
  const connect = (input: Record<string, unknown> = {}, actor = owner) =>
    app.domain.execute(
      "create_repository_connection",
      {
        projectId: project.id,
        repository: "acme/widgets",
        token: "ghp_isolatedTestToken",
        webhookSecret: "hook-secret",
        transitions: {
          branch_created: states.in_progress,
          pull_request_opened: states.in_review,
          pull_request_merged: states.done,
        },
        ...input,
      },
      actor,
    );
  async function send(
    connection: { id: string },
    event: string,
    payload: unknown,
    { secret = "hook-secret", delivery = crypto.randomUUID() } = {},
  ) {
    const body = JSON.stringify(payload);
    const response = await app.app.fetch(
      new Request(`http://localhost/api/repository-hooks/${connection.id}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-GitHub-Event": event,
          "X-GitHub-Delivery": delivery,
          "X-Hub-Signature-256": `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`,
        },
        body,
      }),
    );
    const parsed: unknown = await response.json();
    return { status: response.status, body: parsed };
  }
  const links = (target = ticket) =>
    app.domain.execute("list_resources", { projectId: project.id, ticketId: target.id }, owner);
  const current = async (target = ticket) =>
    (await app.domain.execute("get_ticket", { projectId: project.id, ticketId: target.id }, owner))
      .ticket;
  const listed = async () =>
    (await app.domain.execute("list_repository_connections", { projectId: project.id }, owner))[0];
  async function user(email: string) {
    const created = await fixture.auth.api.createUser({
      body: { name: email, email, password: "Isolated repository password 42!", role: "user" },
    });
    return app.domain.actor(created.user.id);
  }

  beforeAll(async () => {
    fixture = await createFixture();
    github = await fakeGitHub();
    app = await createApplication(fixture.database, fixture.config, {
      jobs: (name, _interval, run) => createPollingJob(name, 86_400_000, run),
      repositories,
    });
    owner = await user("repository-owner@example.test");
    admin = await user("repository-admin@example.test");
    writer = await user("repository-writer@example.test");
  });
  afterAll(async () => {
    github?.close();
    await app?.close();
    await fixture?.close();
  });
  beforeEach(async () => {
    // Access checks another test queued for hosts that only exist on paper are never sent.
    await fixture.database.db.delete(deliveries);
    github.state.statuses = [];
    github.state.received = [];
    project = await app.domain.execute(
      "create_project",
      { key: `R${crypto.randomUUID().slice(0, 8).toUpperCase()}`, name: "Repository project" },
      owner,
    );
    for (const [email, role] of [
      ["repository-admin@example.test", "admin"],
      ["repository-writer@example.test", "writer"],
    ] as const)
      await app.domain.execute("set_member", { projectId: project.id, email, role }, owner);
    states = Object.fromEntries(
      (await app.domain.execute("list_workflow_states", { projectId: project.id }, owner)).map(
        (state) => [state.category, state.id],
      ),
    );
    ticket = await app.domain.execute(
      "create_ticket",
      { projectId: project.id, title: "Ship the widget", status: "todo" },
      owner,
    );
  });

  it("keeps secrets write-only, verifies access through the outbox, and reports revocation", async () => {
    const created = await connect();
    expect(created).toMatchObject({
      provider: "github",
      repository: "acme/widgets",
      secrets: ["token", "webhookSecret"],
      webhookUrl: `http://localhost:5180/api/repository-hooks/${created.id}`,
      lastEventAt: null,
      health: { status: "idle", pending: 1 },
    });
    expect(JSON.stringify(created)).not.toContain("ghp_isolatedTestToken");
    const [stored] = await fixture.database.db
      .select()
      .from(repositoryConnections)
      .where(eq(repositoryConnections.id, created.id));
    expect(stored?.settings).not.toContain("ghp_isolatedTestToken");
    expect(stored?.settings).not.toContain("hook-secret");

    // Only project administrators configure or inspect connections.
    await expect(
      app.domain.execute("list_repository_connections", { projectId: project.id }, writer),
    ).rejects.toMatchObject({ code: "forbidden" });
    await expect(connect({}, admin)).rejects.toMatchObject({ code: "repository_connected" });
    await expect(
      connect({
        repository: "acme/other",
        transitions: { pull_request_merged: crypto.randomUUID() },
      }),
    ).rejects.toMatchObject({ code: "validation_error" });

    await tick();
    expect(github.state.received).toMatchObject([
      {
        method: "GET",
        url: "/api/v3/repos/acme/widgets",
        headers: { authorization: "Bearer ghp_isolatedTestToken" },
      },
    ]);
    expect((await listed())?.health).toMatchObject({ status: "ok", error: null, pending: 0 });

    // A transient failure is retried; a revoked token fails at once and is not retried.
    github.state.statuses = [503];
    await app.domain.execute(
      "verify_repository_connection",
      { projectId: project.id, connectionId: created.id },
      owner,
    );
    await tick();
    expect((await listed())?.health).toMatchObject({
      status: "failing",
      error: "http_503",
      pending: 1,
    });
    await fixture.database.db.update(deliveries).set({ availableAt: new Date() });
    await tick();
    expect((await listed())?.health).toMatchObject({ status: "ok", pending: 0 });

    github.state.statuses = [401];
    await app.domain.execute(
      "verify_repository_connection",
      { projectId: project.id, connectionId: created.id },
      owner,
    );
    await tick();
    expect((await listed())?.health).toMatchObject({
      status: "failing",
      error: "http_401",
      pending: 0,
    });

    // Reconnecting with a new token keeps the webhook secret and checks access again.
    const reconnected = await app.domain.execute(
      "update_repository_connection",
      {
        projectId: project.id,
        connectionId: created.id,
        expectedVersion: created.version,
        token: "ghp_replacementToken",
      },
      admin,
    );
    expect(reconnected).toMatchObject({
      secrets: ["token", "webhookSecret"],
      health: { status: "idle", pending: 1 },
    });
    await tick();
    expect(github.state.received.at(-1)?.headers.authorization).toBe("Bearer ghp_replacementToken");
    expect(
      (await send(created, "ping", { zen: "Keep it logically awesome.", repository })).body,
    ).toMatchObject({
      outcome: "ignored",
    });
    expect((await listed())?.lastEventAt).not.toBeNull();
    // A delivery that changes no ticket still tells open clients the connection changed.
    expect(
      await fixture.database.db
        .select({ data: events.data })
        .from(events)
        .where(eq(events.type, "repository.received")),
    ).toContainEqual({
      data: expect.objectContaining({
        connectionId: created.id,
        event: "ping",
        outcome: "ignored",
      }),
    });
  });

  it("links verified branches, pull requests, and issues and moves tickets through mapped states", async () => {
    const connection = await connect();
    const branch = await send(connection, "create", {
      ref: `feat/${ticket.key.toLowerCase()}-widget`,
      ref_type: "branch",
      repository,
    });
    expect(branch).toMatchObject({
      status: 202,
      body: { outcome: "processed", tickets: [{ key: ticket.key, result: "moved" }] },
    });
    expect(await current()).toMatchObject({ status: "in_progress", stateId: states.in_progress });

    const opened = await send(
      connection,
      "pull_request",
      pullRequest(12, "opened", { title: `${ticket.key}: Fix the widget` }),
    );
    expect(opened.body).toMatchObject({ tickets: [{ result: "moved" }] });
    expect(await current()).toMatchObject({ status: "in_review" });

    // A delivery for a change the mapping leaves alone records state without moving the ticket.
    const draft = await send(
      connection,
      "pull_request",
      pullRequest(12, "converted_to_draft", {
        title: `${ticket.key}: Fix the widget`,
        draft: true,
        at: "2030-01-01T10:05:00Z",
      }),
    );
    expect(draft.body).toMatchObject({ tickets: [{ result: "linked" }] });
    expect(await current()).toMatchObject({ status: "in_review" });

    await send(
      connection,
      "pull_request",
      pullRequest(12, "closed", {
        title: `${ticket.key}: Fix the widget`,
        state: "closed",
        merged: true,
        at: "2030-01-01T11:00:00Z",
      }),
    );
    await send(connection, "issues", {
      action: "closed",
      issue: {
        number: 7,
        html_url: "https://github.com/acme/widgets/issues/7",
        title: `Widget breaks (${ticket.key})`,
        state: "closed",
        updated_at: "2030-01-01T09:00:00Z",
      },
      repository,
    });
    expect(await current()).toMatchObject({ status: "done", stateId: states.done });
    expect(await links()).toMatchObject([
      {
        url: `https://github.com/acme/widgets/tree/feat/${ticket.key.toLowerCase()}-widget`,
        provider: "GitHub",
        remoteKind: "branch",
        remoteState: "active",
      },
      {
        url: "https://github.com/acme/widgets/pull/12",
        title: `${ticket.key}: Fix the widget #12`,
        remoteKind: "pull_request",
        remoteState: "merged",
        remoteCheckedAt: "2030-01-01T11:00:00.000Z",
      },
      { remoteKind: "issue", remoteState: "closed", title: `Widget breaks (${ticket.key}) #7` },
    ]);

    // A link someone added by hand is verified in place rather than duplicated.
    const other = await app.domain.execute(
      "create_ticket",
      { projectId: project.id, title: "Second widget" },
      owner,
    );
    await app.domain.execute(
      "add_resource",
      {
        projectId: project.id,
        ticketId: other.id,
        url: "https://github.com/acme/widgets/pull/30",
        title: "Hand-added",
      },
      owner,
    );
    await send(connection, "pull_request", pullRequest(30, "opened", { ref: `${other.key}-fix` }));
    expect(await links(other)).toMatchObject([
      { title: "Hand-added", remoteKind: "pull_request", remoteState: "open" },
    ]);
    // Another repository's delivery signed with the same secret changes nothing.
    const foreign = await send(connection, "pull_request", {
      ...pullRequest(31, "opened", { ref: `${other.key}-fix` }),
      repository: { full_name: "acme/elsewhere", html_url: "https://github.com/acme/elsewhere" },
    });
    expect(foreign.body).toMatchObject({ outcome: "repository_mismatch" });
    expect((await listed())?.lastEventError).toBe("repository_mismatch");
    expect(await links(other)).toHaveLength(1);
    // Pointing a verified link elsewhere drops everything the connection verified about it.
    const [verified] = await links(other);
    await app.domain.execute(
      "update_resource",
      {
        projectId: project.id,
        resourceId: verified?.id,
        expectedVersion: verified?.version,
        url: "https://example.com/spec",
      },
      owner,
    );
    expect(await links(other)).toMatchObject([
      { remoteKind: null, remoteState: null, remoteCheckedAt: null },
    ]);
  });

  it("rejects unsigned deliveries and applies replayed or out-of-order ones only once", async () => {
    const connection = await connect();
    const merged = pullRequest(5, "closed", {
      ref: `${ticket.key}-fix`,
      state: "closed",
      merged: true,
      at: "2030-01-02T00:00:00Z",
    });
    const forged = await send(connection, "pull_request", merged, { secret: "wrong-secret" });
    expect(forged).toMatchObject({ status: 401, body: { error: { code: "invalid_signature" } } });
    expect(await links()).toEqual([]);
    expect(
      await fixture.database.db
        .select()
        .from(receivedWebhooks)
        .where(eq(receivedWebhooks.connectionId, connection.id)),
    ).toEqual([]);

    const delivery = crypto.randomUUID();
    expect((await send(connection, "pull_request", merged, { delivery })).status).toBe(202);
    const done = await current();
    expect(done).toMatchObject({ status: "done" });
    // Someone reopens the ticket by hand; replaying the merge must not close it again.
    const reopened = await app.domain.execute(
      "update_ticket",
      {
        projectId: project.id,
        ticketId: ticket.id,
        expectedVersion: done.version,
        changes: { status: "todo" },
      },
      owner,
    );
    const replay = await send(connection, "pull_request", merged, { delivery });
    expect(replay).toMatchObject({ status: 200, body: { outcome: "duplicate" } });
    // An older delivery arriving late cannot roll the link or the ticket back.
    const late = await send(
      connection,
      "pull_request",
      pullRequest(5, "opened", { ref: `${ticket.key}-fix`, at: "2030-01-01T00:00:00Z" }),
    );
    expect(late.body).toMatchObject({ tickets: [{ key: ticket.key, result: "stale" }] });
    expect(await current()).toMatchObject({ status: "todo", version: reopened.version });
    expect(await links()).toMatchObject([{ remoteState: "merged" }]);

    // Concurrent copies of one delivery apply once.
    const twice = crypto.randomUUID(),
      reopen = pullRequest(5, "reopened", { ref: `${ticket.key}-fix`, at: "2030-01-03T00:00:00Z" });
    const results = await Promise.all([
      send(connection, "pull_request", reopen, { delivery: twice }),
      send(connection, "pull_request", reopen, { delivery: twice }),
    ]);
    expect(results.map((result) => result.status).toSorted((a, b) => a - b)).toEqual([200, 202]);
    expect(await current()).toMatchObject({ status: "in_review", version: reopened.version + 1 });
    // A human edit against the version they read before the webhook moved the ticket conflicts.
    await expect(
      app.domain.execute(
        "update_ticket",
        {
          projectId: project.id,
          ticketId: ticket.id,
          expectedVersion: reopened.version,
          changes: { status: "done" },
        },
        owner,
      ),
    ).rejects.toMatchObject({ code: "version_conflict" });
  });

  it("follows claim rules, pauses, and stops when the connecting administrator loses access", async () => {
    const ready = await app.domain.execute(
      "create_ticket",
      {
        projectId: project.id,
        title: "Claimed widget",
        description: "Build it",
        acceptanceCriteria: "It works",
        difficulty: "low",
        automationReady: true,
      },
      owner,
    );
    const worker = await app.domain.actor(owner.id, {
      ownerId: "agent",
      scopes: ["read", "claim"],
    });
    await app.domain.execute(
      "claim_ticket",
      {
        projectId: project.id,
        ticketId: ready.id,
        workerId: "agent-1",
        expectedVersion: ready.version,
      },
      worker,
    );
    const connection = await connect({}, admin);
    const claimed = await send(
      connection,
      "pull_request",
      pullRequest(8, "opened", { ref: `${ready.key}-x` }),
    );
    expect(claimed.body).toMatchObject({ tickets: [{ key: ready.key, result: "claim_conflict" }] });
    // Claiming started the work; the connection, holding no claim, cannot move it.
    expect(await current(ready)).toMatchObject({ status: "in_progress" });
    expect(await links(ready)).toMatchObject([{ remoteState: "open" }]);

    const paused = await app.domain.execute(
      "update_repository_connection",
      {
        projectId: project.id,
        connectionId: connection.id,
        expectedVersion: connection.version,
        paused: true,
      },
      owner,
    );
    expect(
      (await send(connection, "pull_request", pullRequest(9, "opened", { ref: `${ticket.key}-x` })))
        .body,
    ).toMatchObject({ outcome: "paused" });
    await app.domain.execute(
      "update_repository_connection",
      {
        projectId: project.id,
        connectionId: connection.id,
        expectedVersion: paused.version,
        paused: false,
      },
      owner,
    );

    await app.domain.execute(
      "set_member",
      { projectId: project.id, email: "repository-admin@example.test", role: null },
      owner,
    );
    const revoked = await send(
      connection,
      "pull_request",
      pullRequest(9, "opened", { ref: `${ticket.key}-x` }),
    );
    expect(revoked.body).toMatchObject({ outcome: "access_revoked" });
    expect((await listed())?.lastEventError).toBe("access_revoked");
    expect(await links()).toEqual([]);
    expect(await current()).toMatchObject({ status: "todo" });

    await app.domain.execute(
      "delete_repository_connection",
      { projectId: project.id, connectionId: connection.id, expectedVersion: paused.version + 1 },
      owner,
    );
    expect(
      (await send(connection, "pull_request", pullRequest(9, "opened", { ref: `${ticket.key}-x` })))
        .status,
    ).toBe(404);
  });

  it("comments on newly linked pull requests through the outbox and retries failures", async () => {
    let connection: RepositoryConnection = await connect({ commentOnLink: true });
    await tick();
    github.state.received = [];
    await send(connection, "pull_request", pullRequest(21, "opened", { ref: `${ticket.key}-x` }));
    // Later deliveries for the same link do not comment again.
    await send(
      connection,
      "pull_request",
      pullRequest(21, "closed", {
        ref: `${ticket.key}-x`,
        state: "closed",
        merged: true,
        at: "2030-01-01T12:00:00Z",
      }),
    );
    github.state.statuses = [502];
    await tick();
    expect((await listed())?.health).toMatchObject({
      status: "failing",
      error: "http_502",
      pending: 1,
    });
    await fixture.database.db.update(deliveries).set({ availableAt: new Date() });
    await tick();
    expect(github.state.received).toHaveLength(2);
    const [, comment] = github.state.received;
    expect(comment).toMatchObject({
      method: "POST",
      url: "/api/v3/repos/acme/widgets/issues/21/comments",
    });
    expect(JSON.parse(comment?.body ?? "{}")).toEqual({
      body: `Linked to [${ticket.key} Ship the widget](http://localhost:5180/projects/${project.id}/tickets/${ticket.id}) in Kanvil.`,
    });
    expect((await listed())?.health).toMatchObject({ status: "ok", pending: 0 });

    // Turning comments off drops comments still queued.
    connection = (await listed()) ?? connection;
    await send(connection, "issues", {
      action: "opened",
      issue: {
        number: 22,
        html_url: "https://github.com/acme/widgets/issues/22",
        title: `${ticket.key} follow-up`,
        state: "open",
        updated_at: "2030-01-01T09:00:00Z",
      },
      repository,
    });
    await app.domain.execute(
      "update_repository_connection",
      {
        projectId: project.id,
        connectionId: connection.id,
        expectedVersion: connection.version,
        commentOnLink: false,
      },
      owner,
    );
    github.state.received = [];
    await tick();
    expect(github.state.received).toEqual([]);
    const [skipped] = await fixture.database.db
      .select()
      .from(deliveries)
      .where(eq(deliveries.error, "comments_disabled"));
    expect(skipped?.finishedAt).toBeInstanceOf(Date);

    // Moving the connection to another repository never sends its queued comments there.
    connection = (await listed()) ?? connection;
    connection = await app.domain.execute(
      "update_repository_connection",
      {
        projectId: project.id,
        connectionId: connection.id,
        expectedVersion: connection.version,
        commentOnLink: true,
      },
      owner,
    );
    await send(connection, "issues", {
      action: "opened",
      issue: {
        number: 23,
        html_url: "https://github.com/acme/widgets/issues/23",
        title: `${ticket.key} second follow-up`,
        state: "open",
        updated_at: "2030-01-01T09:00:00Z",
      },
      repository,
    });
    await app.domain.execute(
      "update_repository_connection",
      {
        projectId: project.id,
        connectionId: connection.id,
        expectedVersion: connection.version,
        repository: "acme/renamed",
      },
      owner,
    );
    await tick();
    expect(github.state.received).toMatchObject([
      { method: "GET", url: "/api/v3/repos/acme/renamed" },
    ]);
    const [cancelled] = await fixture.database.db
      .select()
      .from(deliveries)
      .where(eq(deliveries.error, "repository_changed"));
    expect(cancelled?.finishedAt).toBeInstanceOf(Date);
  });

  it("keeps updating a link after its key leaves the title", async () => {
    const connection = await connect();
    await send(
      connection,
      "pull_request",
      pullRequest(18, "opened", { title: `${ticket.key} Fix the widget` }),
    );
    const merged = await send(
      connection,
      "pull_request",
      pullRequest(18, "closed", {
        title: "Fix the widget",
        state: "closed",
        merged: true,
        at: "2030-01-01T11:00:00Z",
      }),
    );
    expect(merged.body).toMatchObject({ tickets: [{ key: ticket.key, result: "moved" }] });
    expect(await current()).toMatchObject({ status: "done" });
    expect(await links()).toMatchObject([{ remoteState: "merged" }]);
  });

  it("drops a queued comment whose ticket was deleted", async () => {
    const connection = await connect({ commentOnLink: true });
    await tick();
    github.state.received = [];
    await send(connection, "pull_request", pullRequest(19, "opened", { ref: `${ticket.key}-x` }));
    const live = await current();
    await app.domain.execute(
      "delete_ticket",
      { projectId: project.id, ticketId: ticket.id, expectedVersion: live.version },
      owner,
    );
    await tick();
    expect(github.state.received).toEqual([]);
    const [dropped] = await fixture.database.db
      .select()
      .from(deliveries)
      .where(and(eq(deliveries.connectionId, connection.id), isNotNull(deliveries.eventId)));
    expect(dropped).toMatchObject({ error: "link_removed" });
  });

  it("drops queued comments once the connecting administrator loses access", async () => {
    const connection = await connect({ commentOnLink: true }, admin);
    await tick();
    github.state.received = [];
    await send(connection, "pull_request", pullRequest(17, "opened", { ref: `${ticket.key}-x` }));
    await app.domain.execute(
      "set_member",
      { projectId: project.id, email: "repository-admin@example.test", role: null },
      owner,
    );
    await tick();
    expect(github.state.received).toEqual([]);
    const [dropped] = await fixture.database.db
      .select()
      .from(deliveries)
      .where(and(eq(deliveries.connectionId, connection.id), isNotNull(deliveries.eventId)));
    expect(dropped).toMatchObject({ error: "access_revoked" });
    expect(dropped?.finishedAt).toBeInstanceOf(Date);
  });

  it("applies nothing to an archived project and still lets administrators disconnect", async () => {
    const connection = await connect();
    await app.domain.execute(
      "archive_project",
      { projectId: project.id, expectedVersion: project.version, archived: true },
      owner,
    );
    const archived = await send(
      connection,
      "pull_request",
      pullRequest(3, "opened", { ref: `${ticket.key}-x` }),
    );
    expect(archived.body).toMatchObject({ outcome: "project_archived" });
    expect(await links()).toEqual([]);
    await expect(
      app.domain.execute(
        "verify_repository_connection",
        { projectId: project.id, connectionId: connection.id },
        owner,
      ),
    ).rejects.toMatchObject({ code: "project_archived" });
    await app.domain.execute(
      "delete_repository_connection",
      { projectId: project.id, connectionId: connection.id, expectedVersion: connection.version },
      owner,
    );
  });

  it("resolves tickets named by a project's earlier prefix", async () => {
    const connection = await connect();
    const renamed = await app.domain.execute(
      "update_project",
      {
        projectId: project.id,
        expectedVersion: project.version,
        name: project.name,
        description: project.description,
        key: `Q${crypto.randomUUID().slice(0, 8).toUpperCase()}`,
      },
      owner,
    );
    const result = await send(
      connection,
      "pull_request",
      pullRequest(14, "opened", { ref: `${ticket.key.toLowerCase()}-old-prefix` }),
    );
    expect(result.body).toMatchObject({
      tickets: [{ key: `${renamed.key}-${ticket.number}`, result: "moved" }],
    });
    expect(await links()).toMatchObject([{ remoteKind: "pull_request", remoteState: "open" }]);
  });

  it("removes connections, secrets, and webhooks with a deleted project", async () => {
    const connection = await connect();
    await app.domain.execute(
      "delete_project",
      { projectId: project.id, expectedVersion: project.version, confirmKey: project.key },
      owner,
    );
    expect(
      await fixture.database.db
        .select()
        .from(repositoryConnections)
        .where(eq(repositoryConnections.id, connection.id)),
    ).toEqual([]);
    expect(
      await fixture.database.db
        .select()
        .from(deliveries)
        .where(eq(deliveries.connectionId, connection.id)),
    ).toEqual([]);
    expect(
      (await send(connection, "pull_request", pullRequest(3, "opened", { ref: `${ticket.key}-x` })))
        .status,
    ).toBe(404);
  });

  it("moves mapped transitions with a deleted workflow state's tickets", async () => {
    const extra = await app.domain.execute(
      "create_workflow_state",
      { projectId: project.id, name: "Shipped", category: "done" },
      owner,
    );
    const connection = await connect({ transitions: { pull_request_merged: extra.id } });
    await app.domain.execute(
      "delete_workflow_state",
      {
        projectId: project.id,
        stateId: extra.id,
        expectedVersion: extra.version,
        reassignTo: states.done,
      },
      owner,
    );
    expect(await listed()).toMatchObject({
      transitions: { pull_request_merged: states.done },
      version: connection.version + 1,
    });
  });

  // A delivery with any provider's headers; `send` above signs GitHub's.
  async function deliver(
    connection: { id: string },
    headers: Record<string, string>,
    body: string,
  ) {
    const response = await app.app.fetch(
      new Request(`http://localhost/api/repository-hooks/${connection.id}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...headers },
        body,
      }),
    );
    const parsed: unknown = await response.json();
    return { status: response.status, body: parsed };
  }
  const forgeConnection = (input: Record<string, unknown>) =>
    app.domain.execute(
      "create_repository_connection",
      {
        projectId: project.id,
        repository: "acme/widgets",
        token: "forge-isolated-token",
        webhookSecret: "forge-hook-secret",
        commentOnLink: true,
        transitions: {
          branch_created: states.in_progress,
          pull_request_opened: states.in_review,
          pull_request_draft: states.in_progress,
          pull_request_merged: states.done,
        },
        ...input,
      },
      owner,
    );

  it("validates self-managed URLs and provider paths and keeps forge credentials write-only", async () => {
    // Malformed URLs fail the schema; the provider's own rules fail in the handler.
    const malformed = (baseUrl: string) =>
      expect(forgeConnection({ provider: "gitea", baseUrl })).rejects.toMatchObject({
        name: "ZodError",
        issues: [expect.objectContaining({ path: ["baseUrl"] })],
      });
    await malformed("https://user:pass@git.example.test");
    await malformed("ftp://git.example.test");
    await malformed("https://git.example.test/?next=x");
    const invalid = (input: Record<string, unknown>, path: string) =>
      expect(forgeConnection(input)).rejects.toMatchObject({
        code: "validation_error",
        details: [expect.objectContaining({ path })],
      });
    await invalid({ provider: "gitea" }, "baseUrl");
    await invalid({ provider: "github", baseUrl: "https://git.example.test" }, "baseUrl");
    await invalid({ provider: "github", repository: "acme/platform/widgets" }, "repository");
    await invalid(
      { provider: "gitea", baseUrl: "https://git.example.test", repository: "acme/a/b" },
      "repository",
    );

    // GitLab paths nest groups, and gitlab.com is the default instance.
    const gitlab = await forgeConnection({
      provider: "gitlab",
      repository: "acme/platform/widgets",
    });
    expect(gitlab).toMatchObject({
      provider: "gitlab",
      baseUrl: "https://gitlab.com",
      repository: "acme/platform/widgets",
      secrets: ["token", "webhookSecret"],
    });
    // A trailing slash is dropped; the same path on another provider or instance is another repository.
    const gitea = await forgeConnection({
      provider: "gitea",
      baseUrl: "https://git.example.test/forge/",
    });
    expect(gitea).toMatchObject({ baseUrl: "https://git.example.test/forge" });
    await forgeConnection({ provider: "github", baseUrl: undefined });
    await forgeConnection({ provider: "gitea", baseUrl: "https://other.example.test" });
    await expect(
      forgeConnection({
        provider: "gitea",
        baseUrl: "https://git.example.test/forge",
        repository: "ACME/widgets",
      }),
    ).rejects.toMatchObject({ code: "repository_connected" });
    // Paths are checked against the saved provider on update too.
    await expect(
      app.domain.execute(
        "update_repository_connection",
        {
          projectId: project.id,
          connectionId: gitea.id,
          expectedVersion: gitea.version,
          repository: "acme/platform/widgets",
        },
        owner,
      ),
    ).rejects.toMatchObject({ code: "validation_error" });
    // An instance URL is operator-trusted only as far as the outbound address rules allow.
    await fixture.database.db.delete(deliveries);
    const internal = await forgeConnection({
      provider: "gitea",
      repository: "acme/internal",
      baseUrl: `${github.origin}/gitea`,
    });
    await tick(false);
    expect(github.state.received).toEqual([]);
    expect(
      (
        await app.domain.execute("list_repository_connections", { projectId: project.id }, owner)
      ).find((item) => item.id === internal.id)?.health,
    ).toMatchObject({ status: "failing", error: "blocked_address", pending: 0 });
    for (const created of [gitlab, gitea]) {
      expect(JSON.stringify(created)).not.toContain("forge-isolated-token");
      const [stored] = await fixture.database.db
        .select()
        .from(repositoryConnections)
        .where(eq(repositoryConnections.id, created.id));
      expect(stored?.settings).not.toContain("forge-isolated-token");
      expect(stored?.settings).not.toContain("forge-hook-secret");
    }
  });

  it("runs a Gitea connection through verify, events, comments, reconnect, pause, and disconnect", async () => {
    const giteaRepository = {
      full_name: "acme/widgets",
      html_url: "https://git.example.test/acme/widgets",
    };
    const created = forgeConnection({
      provider: "gitea",
      repository: "acme/widgets",
      baseUrl: `${github.origin}/gitea`,
    });
    await expect(created).resolves.toMatchObject({ provider: "gitea", health: { pending: 1 } });
    let connection: RepositoryConnection = await created;
    await tick();
    expect(github.state.received).toMatchObject([
      {
        method: "GET",
        url: "/gitea/api/v1/repos/acme/widgets",
        headers: { authorization: "token forge-isolated-token" },
      },
    ]);
    expect((await listed())?.health).toMatchObject({ status: "ok", pending: 0 });
    github.state.received = [];

    const gitea = (
      event: string,
      payload: unknown,
      { secret = "forge-hook-secret", delivery = crypto.randomUUID() } = {},
    ) => {
      const body = JSON.stringify(payload);
      return deliver(
        connection,
        {
          "X-Gitea-Event": event,
          "X-Gitea-Delivery": delivery,
          "X-Gitea-Signature": createHmac("sha256", secret).update(body).digest("hex"),
        },
        body,
      );
    };
    const giteaPull = (action: string, title: string, at: string, extra: object = {}) => ({
      action,
      number: 4,
      pull_request: {
        number: 4,
        html_url: "https://git.example.test/acme/widgets/pulls/4",
        title,
        state: "open",
        merged: false,
        updated_at: at,
        head: { ref: "widget-fix" },
      },
      repository: giteaRepository,
      ...extra,
    });

    const branch = {
      ref: `feat/${ticket.key.toLowerCase()}-widget`,
      ref_type: "branch",
      repository: giteaRepository,
    };
    // GitHub's signature header is not Gitea's; a wrong or missing signature is refused.
    expect(await send(connection, "create", branch, { secret: "forge-hook-secret" })).toMatchObject(
      {
        status: 401,
      },
    );
    expect(await gitea("create", branch, { secret: "wrong" })).toMatchObject({ status: 401 });
    expect((await gitea("create", branch)).body).toMatchObject({
      tickets: [{ key: ticket.key, result: "moved" }],
    });
    expect(await current()).toMatchObject({ status: "in_progress" });

    // Gitea marks drafts by a WIP title prefix; removing it is the pull request becoming ready.
    expect(
      (
        await gitea(
          "pull_request",
          giteaPull("opened", `WIP: ${ticket.key} Fix`, "2030-01-01T10:00:00Z"),
        )
      ).body,
    ).toMatchObject({ tickets: [{ result: "linked" }] });
    expect(await links()).toMatchObject([{}, { remoteKind: "pull_request", remoteState: "draft" }]);
    const ready = crypto.randomUUID();
    const readied = giteaPull("edited", `${ticket.key} Fix`, "2030-01-01T10:05:00Z", {
      changes: { title: { from: `WIP: ${ticket.key} Fix` } },
    });
    expect((await gitea("pull_request", readied, { delivery: ready })).body).toMatchObject({
      tickets: [{ result: "moved" }],
    });
    expect(await current()).toMatchObject({ status: "in_review" });
    expect(await gitea("pull_request", readied, { delivery: ready })).toMatchObject({
      status: 200,
      body: { outcome: "duplicate" },
    });
    // Review and sync actions change nothing.
    expect(
      (
        await gitea(
          "pull_request",
          giteaPull("synchronized", `${ticket.key} Fix`, "2030-01-01T10:06:00Z"),
        )
      ).body,
    ).toMatchObject({ outcome: "ignored" });

    await gitea("pull_request", {
      ...giteaPull("closed", `${ticket.key} Fix`, "2030-01-01T11:00:00Z"),
      pull_request: {
        ...giteaPull("closed", `${ticket.key} Fix`, "2030-01-01T11:00:00Z").pull_request,
        state: "closed",
        merged: true,
      },
    });
    await gitea("issues", {
      action: "opened",
      issue: {
        number: 6,
        html_url: "https://git.example.test/acme/widgets/issues/6",
        title: `${ticket.key} follow-up`,
        state: "open",
        updated_at: "2030-01-01T09:00:00Z",
      },
      repository: giteaRepository,
    });
    await gitea("delete", branch);
    expect(await current()).toMatchObject({ status: "done" });
    expect(await links()).toMatchObject([
      {
        url: `https://git.example.test/acme/widgets/src/branch/feat/${ticket.key.toLowerCase()}-widget`,
        provider: "Gitea",
        remoteKind: "branch",
        remoteState: "deleted",
      },
      // A link keeps the title it was created with.
      { remoteKind: "pull_request", remoteState: "merged", title: `WIP: ${ticket.key} Fix #4` },
      { remoteKind: "issue", remoteState: "open" },
    ]);

    await tick();
    expect(github.state.received.map(({ method, url }) => [method, url])).toEqual([
      ["POST", "/gitea/api/v1/repos/acme/widgets/issues/4/comments"],
      ["POST", "/gitea/api/v1/repos/acme/widgets/issues/6/comments"],
    ]);
    expect(github.state.received[0]?.headers.authorization).toBe("token forge-isolated-token");

    // Reconnecting to a moved instance with a new token checks access there.
    connection = (await listed()) ?? connection;
    connection = await app.domain.execute(
      "update_repository_connection",
      {
        projectId: project.id,
        connectionId: connection.id,
        expectedVersion: connection.version,
        baseUrl: `${github.origin}/moved`,
        token: "forge-replacement-token",
      },
      owner,
    );
    expect(connection).toMatchObject({ baseUrl: `${github.origin}/moved`, health: { pending: 1 } });
    github.state.received = [];
    await tick();
    expect(github.state.received).toMatchObject([
      {
        url: "/moved/api/v1/repos/acme/widgets",
        headers: { authorization: "token forge-replacement-token" },
      },
    ]);

    connection = await app.domain.execute(
      "update_repository_connection",
      {
        projectId: project.id,
        connectionId: connection.id,
        expectedVersion: connection.version,
        paused: true,
      },
      owner,
    );
    expect((await gitea("create", branch)).body).toMatchObject({ outcome: "paused" });
    await app.domain.execute(
      "delete_repository_connection",
      { projectId: project.id, connectionId: connection.id, expectedVersion: connection.version },
      owner,
    );
    expect((await gitea("create", branch)).status).toBe(404);
  });

  it("runs a GitLab connection through verify, events, comments, reconnect, pause, and disconnect", async () => {
    const gitlabProject = {
      path_with_namespace: "acme/platform/widgets",
      web_url: "https://gitlab.example.test/acme/platform/widgets",
    };
    const created = forgeConnection({
      provider: "gitlab",
      repository: "acme/platform/widgets",
      baseUrl: `${github.origin}/gitlab`,
    });
    await expect(created).resolves.toMatchObject({ provider: "gitlab", health: { pending: 1 } });
    let connection: RepositoryConnection = await created;
    await tick();
    expect(github.state.received).toMatchObject([
      {
        method: "GET",
        url: "/gitlab/api/v4/projects/acme%2Fplatform%2Fwidgets",
        headers: { "private-token": "forge-isolated-token" },
      },
    ]);
    github.state.received = [];

    const gitlab = (
      event: string,
      payload: unknown,
      {
        token = "forge-hook-secret",
        delivery = crypto.randomUUID(),
      }: { token?: string | null; delivery?: string } = {},
    ) =>
      deliver(
        connection,
        {
          "X-Gitlab-Event": event,
          "X-Gitlab-Event-UUID": delivery,
          ...(token !== null && { "X-Gitlab-Token": token }),
        },
        JSON.stringify(payload),
      );
    const zero = "0".repeat(40);
    const push = (ref: string, before: string, after: string) => ({
      object_kind: "push",
      ref,
      before,
      after,
      project: gitlabProject,
    });
    const mergeRequest = (
      action: string,
      { state = "opened", draft = false, at = "2030-01-01T10:00:00Z", changes = {} } = {},
    ) => ({
      object_kind: "merge_request",
      project: gitlabProject,
      object_attributes: {
        iid: 3,
        url: "https://gitlab.example.test/acme/platform/widgets/-/merge_requests/3",
        title: "Fix the widget",
        state,
        action,
        draft,
        source_branch: `${ticket.key}-fix`,
        updated_at: at,
      },
      changes,
    });

    const branch = push(`refs/heads/${ticket.key}-fix`, zero, "a".repeat(40));
    expect(await gitlab("Push Hook", branch, { token: "wrong" })).toMatchObject({ status: 401 });
    expect(await gitlab("Push Hook", branch, { token: null })).toMatchObject({ status: 401 });
    expect((await gitlab("Push Hook", branch)).body).toMatchObject({
      tickets: [{ key: ticket.key, result: "moved" }],
    });
    expect(await current()).toMatchObject({ status: "in_progress" });
    // Commits to an existing branch and tag pushes are not branch lifecycle events.
    expect(
      (
        await gitlab(
          "Push Hook",
          push(`refs/heads/${ticket.key}-fix`, "a".repeat(40), "b".repeat(40)),
        )
      ).body,
    ).toMatchObject({ outcome: "ignored" });
    expect(
      (
        await gitlab("Tag Push Hook", {
          ...push(`refs/tags/${ticket.key}`, zero, "c".repeat(40)),
          object_kind: "tag_push",
        })
      ).body,
    ).toMatchObject({ outcome: "ignored" });

    expect(
      (await gitlab("Merge Request Hook", mergeRequest("open", { draft: true }))).body,
    ).toMatchObject({
      tickets: [{ result: "linked" }],
    });
    // Marking a draft ready arrives as an update whose changes flip `draft`.
    const readied = mergeRequest("update", {
      at: "2030-01-01T10:05:00Z",
      changes: { draft: { previous: true, current: false } },
    });
    const ready = crypto.randomUUID();
    expect((await gitlab("Merge Request Hook", readied, { delivery: ready })).body).toMatchObject({
      tickets: [{ result: "moved" }],
    });
    expect(await current()).toMatchObject({ status: "in_review" });
    expect(await gitlab("Merge Request Hook", readied, { delivery: ready })).toMatchObject({
      status: 200,
      body: { outcome: "duplicate" },
    });
    expect(
      (await gitlab("Merge Request Hook", mergeRequest("approved", { at: "2030-01-01T10:06:00Z" })))
        .body,
    ).toMatchObject({ outcome: "ignored" });
    // Older GitLab versions send `YYYY-MM-DD HH:MM:SS UTC` timestamps.
    await gitlab(
      "Merge Request Hook",
      mergeRequest("merge", { state: "merged", at: "2030-01-01 11:00:00 UTC" }),
    );
    // A late, older update cannot roll the merge back.
    expect(
      (await gitlab("Merge Request Hook", mergeRequest("update", { at: "2030-01-01T10:30:00Z" })))
        .body,
    ).toMatchObject({ tickets: [{ result: "stale" }] });
    await gitlab("Issue Hook", {
      object_kind: "issue",
      project: gitlabProject,
      object_attributes: {
        iid: 8,
        url: "https://gitlab.example.test/acme/platform/widgets/-/issues/8",
        title: `${ticket.key} follow-up`,
        state: "opened",
        action: "open",
        updated_at: "2030-01-01T09:00:00Z",
      },
    });
    expect(await current()).toMatchObject({ status: "done" });
    expect(await links()).toMatchObject([
      {
        url: `https://gitlab.example.test/acme/platform/widgets/-/tree/${ticket.key}-fix`,
        provider: "GitLab",
        remoteKind: "branch",
        remoteState: "active",
      },
      {
        remoteKind: "pull_request",
        remoteState: "merged",
        remoteCheckedAt: "2030-01-01T11:00:00.000Z",
        title: "Fix the widget #3",
      },
      { remoteKind: "issue", remoteState: "open", title: `${ticket.key} follow-up #8` },
    ]);
    // Another project's delivery under the same token changes nothing.
    expect(
      (
        await gitlab("Merge Request Hook", {
          ...mergeRequest("open"),
          project: { ...gitlabProject, path_with_namespace: "acme/other" },
        })
      ).body,
    ).toMatchObject({ outcome: "repository_mismatch" });

    // Merge requests and issues take notes on their own endpoints.
    await tick();
    expect(github.state.received.map(({ method, url }) => [method, url])).toEqual([
      ["POST", "/gitlab/api/v4/projects/acme%2Fplatform%2Fwidgets/merge_requests/3/notes"],
      ["POST", "/gitlab/api/v4/projects/acme%2Fplatform%2Fwidgets/issues/8/notes"],
    ]);
    expect(github.state.received[0]?.headers["private-token"]).toBe("forge-isolated-token");
    expect(JSON.parse(github.state.received[0]?.body ?? "{}")).toMatchObject({
      body: expect.stringContaining(`[${ticket.key} Ship the widget]`),
    });

    connection = (await listed()) ?? connection;
    connection = await app.domain.execute(
      "update_repository_connection",
      {
        projectId: project.id,
        connectionId: connection.id,
        expectedVersion: connection.version,
        token: "forge-replacement-token",
        webhookSecret: "forge-new-secret",
      },
      owner,
    );
    github.state.received = [];
    await tick();
    expect(github.state.received).toMatchObject([
      { headers: { "private-token": "forge-replacement-token" } },
    ]);
    expect(await gitlab("Push Hook", branch)).toMatchObject({ status: 401 });
    expect((await gitlab("Push Hook", branch, { token: "forge-new-secret" })).status).toBe(202);

    connection = await app.domain.execute(
      "update_repository_connection",
      {
        projectId: project.id,
        connectionId: connection.id,
        expectedVersion: connection.version,
        paused: true,
      },
      owner,
    );
    expect((await gitlab("Push Hook", branch, { token: "forge-new-secret" })).body).toMatchObject({
      outcome: "paused",
    });
    await app.domain.execute(
      "delete_repository_connection",
      { projectId: project.id, connectionId: connection.id, expectedVersion: connection.version },
      owner,
    );
    expect((await gitlab("Push Hook", branch, { token: "forge-new-secret" })).status).toBe(404);
  });
});
