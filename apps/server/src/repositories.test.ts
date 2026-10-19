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
import { deliverBatch } from "./outbox.ts";
import { deliverySecrets } from "./sealing.ts";
import { deliveries, events, receivedWebhooks, repositoryConnections } from "./schema.ts";
import type { Actor } from "./domain.ts";

function portOf(address: string | AddressInfo | null) {
  if (!address || typeof address === "string") throw new Error("Expected a TCP listener");
  return address.port;
}
type Received = { method: string; url: string; headers: IncomingHttpHeaders; body: string };
// A loopback stand-in for the GitHub REST API. `statuses` answers each request in turn, then 200.
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
  return { state, url: `http://127.0.0.1:${port}/api/v3`, close: () => server.close() };
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
  const repositories = () => ({ github: createGitHubDriver(github.url) });
  const tick = () =>
    deliverBatch(
      fixture.database,
      fixture.config,
      {
        push: {
          sendPushNotificationsAsync: async () => [],
          getPushNotificationReceiptsAsync: async () => ({}),
        },
        http: createHttpSender({ allowPrivate: true, timeout: 2000 }),
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
});
