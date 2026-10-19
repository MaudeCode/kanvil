import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vite-plus/test";
import { createHmac } from "node:crypto";
import { createServer, type ServerResponse } from "node:http";
import { eq } from "drizzle-orm";
import { z } from "zod";
import type { Project, RepositoryConnection, SyncRule, Ticket } from "@kanvil/contracts";
import { createFixture } from "./test-fixture.ts";
import { createApplication } from "./app.ts";
import { createPollingJob } from "./adapters/polling-jobs.ts";
import { createHttpSender } from "./adapters/outbound.ts";
import { createGitHubDriver } from "./adapters/github.ts";
import { createGiteaDriver } from "./adapters/gitea.ts";
import { createGitLabDriver } from "./adapters/gitlab.ts";
import { defaultAdapters } from "./runtime-adapters.ts";
import { deliverBatch } from "./outbox.ts";
import { deliverySecrets } from "./sealing.ts";
import { deliveries, issueLinks, repositoryConnections } from "./schema.ts";
import type { Actor } from "./domain.ts";

type Issue = {
  number: number;
  title: string;
  body: string;
  state: "open" | "closed";
  labels: string[];
  updated_at: string;
};
function answer(response: ServerResponse, status: number, body: unknown, delay = 0) {
  setTimeout(() => {
    if (response.destroyed) return;
    response.writeHead(status, { "Content-Type": "application/json" });
    response.end(JSON.stringify(body));
  }, delay);
}
const text = (value: unknown) => (typeof value === "string" ? value : "");
const headers = (entries: Record<string, string>) => new Headers(entries);
const webhookResult = z.object({
  tickets: z.array(z.object({ key: z.string(), result: z.string() })).optional(),
});
// What issue sync made of a delivery, beside the link updates every issue event makes.
const synced = ({ body }: { body: unknown }) =>
  webhookResult.parse(body).tickets?.find((item) => item.result.startsWith("sync_")) ?? body;
// A loopback forge that keeps issues and comments like GitHub's REST API. `script` answers the next
// requests first: a status without acting, or acting and then answering after `delay` milliseconds.
async function fakeForge() {
  const state = {
    issues: new Map<number, Issue>(),
    comments: [] as { id: number; issue: number; body: string }[],
    requests: [] as { method: string; url: string; body: string }[],
    script: [] as ({ status: number } | { delay: number })[],
    next: 1,
    clock: Date.parse("2030-01-01T10:00:00Z"),
  };
  const stamp = () => new Date((state.clock += 1000)).toISOString();
  const server = createServer((request, response) => {
    let raw = "";
    request.on("data", (chunk: Buffer) => (raw += chunk.toString()));
    request.on("end", () => {
      const method = request.method ?? "",
        url = request.url ?? "";
      state.requests.push({ method, url, body: raw });
      const scripted = state.script.shift();
      if (scripted && "status" in scripted) {
        answer(response, scripted.status, {});
        return;
      }
      const delay = scripted?.delay ?? 0;
      const parsed: unknown = raw ? JSON.parse(raw) : {};
      const sent = z.record(z.string(), z.unknown()).parse(parsed);
      const path = url.replace(/^\/api\/v3\/repos\/acme\/[\w-]+/, "");
      const edit = /^\/issues\/(\d+)$/.exec(path),
        commented = /^\/issues\/(\d+)\/comments$/.exec(path);
      if (method === "POST" && path === "/issues") {
        const issue: Issue = {
          number: state.next++,
          title: text(sent.title),
          body: text(sent.body),
          state: "open",
          labels: [],
          updated_at: stamp(),
        };
        state.issues.set(issue.number, issue);
        answer(response, 201, wire(issue), delay);
      } else if (method === "PATCH" && edit) {
        const issue = state.issues.get(Number(edit[1]));
        if (!issue) {
          answer(response, 404, {});
          return;
        }
        if (typeof sent.title === "string") issue.title = sent.title;
        if (typeof sent.body === "string") issue.body = sent.body;
        if (sent.state === "open" || sent.state === "closed") issue.state = sent.state;
        issue.updated_at = stamp();
        answer(response, 200, wire(issue), delay);
      } else if (method === "POST" && commented) {
        const comment = {
          id: 9000 + state.comments.length,
          issue: Number(commented[1]),
          body: text(sent.body),
        };
        state.comments.push(comment);
        answer(response, 201, comment, delay);
      } else answer(response, 200, {});
    });
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected a TCP listener");
  return {
    state,
    stamp,
    url: `http://127.0.0.1:${address.port}/api/v3`,
    close: () => server.close(),
  };
}
const repository = { full_name: "acme/widgets", html_url: "https://github.com/acme/widgets" };
const wire = (issue: Issue) => ({
  ...issue,
  html_url: `https://github.com/acme/widgets/issues/${issue.number}`,
  labels: issue.labels.map((name) => ({ name })),
});

describe("issue sync", () => {
  let fixture: Awaited<ReturnType<typeof createFixture>>,
    app: Awaited<ReturnType<typeof createApplication>>,
    forge: Awaited<ReturnType<typeof fakeForge>>;
  let owner: Actor, project: Project, label: string;
  const repositories = () => ({
    ...defaultAdapters.repositories(fixture.config),
    github: createGitHubDriver(forge.url),
  });
  // Each run is a fresh worker reading the durable outbox, as after a restart.
  const tick = (timeout = 2000) =>
    deliverBatch(
      fixture.database,
      fixture.config,
      {
        push: {
          sendPushNotificationsAsync: async () => [],
          getPushNotificationReceiptsAsync: async () => ({}),
        },
        http: createHttpSender({ allowPrivate: true, timeout }),
      },
      deliverySecrets(fixture.config),
      repositories(),
    );
  // Sends what is queued, minus the access check, and returns the forge requests it made.
  async function flush(timeout?: number) {
    forge.state.requests = [];
    await tick(timeout);
    return forge.state.requests.filter((request) => request.method !== "GET");
  }
  async function send(
    connection: { id: string },
    event: string,
    payload: unknown,
    delivery?: string,
  ) {
    const raw = JSON.stringify(payload);
    const response = await app.app.fetch(
      new Request(`http://localhost/api/repository-hooks/${connection.id}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-GitHub-Event": event,
          "X-GitHub-Delivery": delivery ?? crypto.randomUUID(),
          "X-Hub-Signature-256": `sha256=${createHmac("sha256", "hook-secret").update(raw).digest("hex")}`,
        },
        body: raw,
      }),
    );
    const body: unknown = await response.json();
    return { status: response.status, body };
  }
  function issueOf(number: number) {
    const issue = forge.state.issues.get(number);
    if (!issue) throw new Error(`No issue ${number}`);
    return issue;
  }
  // The host reports an issue as it now stands.
  const reportIssue = (connection: { id: string }, number: number, action = "edited") =>
    send(connection, "issues", { action, issue: wire(issueOf(number)), repository });
  // Someone edits the issue on the host, which then reports it.
  function editIssue(connection: { id: string }, number: number, changes: Partial<Issue>) {
    Object.assign(issueOf(number), changes, { updated_at: forge.stamp() });
    return reportIssue(connection, number);
  }
  const rule = (labels: string[] = [label], match: SyncRule["match"] = "any"): SyncRule => ({
    enabled: true,
    labels,
    match,
  });
  const off: SyncRule = { enabled: false, labels: [], match: "any" };
  const connect = (path = "acme/widgets") =>
    app.domain.execute(
      "create_repository_connection",
      {
        projectId: project.id,
        repository: path,
        token: "ghp_isolatedTestToken",
        webhookSecret: "hook-secret",
      },
      owner,
    );
  const preview = (connection: RepositoryConnection, outbound: SyncRule, inbound = off) =>
    app.domain.execute(
      "preview_repository_sync",
      { projectId: project.id, connectionId: connection.id, outbound, inbound },
      owner,
    );
  async function apply(connection: RepositoryConnection, outbound: SyncRule, inbound = off) {
    const { fingerprint } = await preview(connection, outbound, inbound);
    return app.domain.execute(
      "apply_repository_sync",
      {
        projectId: project.id,
        connectionId: connection.id,
        expectedVersion: connection.version,
        outbound,
        inbound,
        fingerprint,
      },
      owner,
    );
  }
  const create = (title: string, labels: string[] = [label], status: "todo" | "done" = "todo") =>
    app.domain.execute("create_ticket", { projectId: project.id, title, labels, status }, owner);
  const current = async (target: Ticket) =>
    (await app.domain.execute("get_ticket", { projectId: project.id, ticketId: target.id }, owner))
      .ticket;
  const update = async (target: Ticket, changes: Record<string, unknown>) =>
    app.domain.execute(
      "update_ticket",
      {
        projectId: project.id,
        ticketId: target.id,
        expectedVersion: (await current(target)).version,
        changes,
      },
      owner,
    );
  const linkOf = async (target: Ticket) =>
    (
      await fixture.database.db.select().from(issueLinks).where(eq(issueLinks.ticketId, target.id))
    )[0];
  const compare = async (target: Ticket) => {
    const link = await linkOf(target);
    return app.domain.execute(
      "compare_issue_link",
      { projectId: project.id, linkId: link?.id ?? "" },
      owner,
    );
  };
  async function reconcile(target: Ticket, resolution: "kanvil" | "remote" | "unlink") {
    const comparison = await compare(target);
    return app.domain.execute(
      "reconcile_issue_link",
      {
        projectId: project.id,
        linkId: comparison.link.id,
        expectedVersion: comparison.link.version,
        ticketVersion: comparison.ticketVersion,
        resolution,
      },
      owner,
    );
  }
  const commentsOf = async (target: Ticket) =>
    (
      await app.domain.execute(
        "list_comments",
        { projectId: project.id, ticketId: target.id },
        owner,
      )
    ).items;
  // A connection that already exported `ticket` as an issue.
  async function exported(target: Ticket) {
    const connection = await apply(await connect(), rule());
    await flush();
    const link = await linkOf(target);
    expect(link).toMatchObject({ state: "active" });
    return { connection, number: link?.number ?? 0 };
  }

  beforeAll(async () => {
    fixture = await createFixture();
    forge = await fakeForge();
    app = await createApplication(fixture.database, fixture.config, {
      jobs: (name, _interval, run) => createPollingJob(name, 86_400_000, run),
      repositories,
    });
    const created = await fixture.auth.api.createUser({
      body: {
        name: "Sync owner",
        email: "sync-owner@example.test",
        password: "Isolated repository password 42!",
        role: "user",
      },
    });
    owner = await app.domain.actor(created.user.id);
  });
  afterAll(async () => {
    forge?.close();
    await app?.close();
    await fixture?.close();
  });
  beforeEach(async () => {
    await fixture.database.db.delete(deliveries);
    forge.state.script = [];
    project = await app.domain.execute(
      "create_project",
      { key: `S${crypto.randomUUID().slice(0, 8).toUpperCase()}`, name: "Sync project" },
      owner,
    );
    label = (
      await app.domain.execute(
        "create_workspace_label",
        { workspaceId: project.workspaceId, name: `sync-${crypto.randomUUID().slice(0, 6)}` },
        owner,
      )
    ).id;
  });
  const labelName = async () =>
    (
      await app.domain.execute("list_workspace_labels", { workspaceId: project.workspaceId }, owner)
    ).find((item) => item.id === label)?.name ?? "";

  it("previews and applies filtered export rules and creates each issue once from a verified answer", async () => {
    const name = await labelName();
    const first = await create("Export me", [name]);
    await create("Not labelled", []);
    await create("Already done", [name], "done");
    const connection = await connect();
    await expect(preview(connection, rule([label]))).resolves.toMatchObject({
      matching: 0,
      export: 1,
      pause: 0,
      review: 0,
    });
    const stale = await preview(connection, rule([label]));
    const second = await create("Labelled after the preview", [name]);
    // The previewed set changed, so the old preview no longer describes what applying would do.
    await expect(
      app.domain.execute(
        "apply_repository_sync",
        {
          projectId: project.id,
          connectionId: connection.id,
          expectedVersion: connection.version,
          outbound: rule([label]),
          inbound: off,
          fingerprint: stale.fingerprint,
        },
        owner,
      ),
    ).rejects.toMatchObject({ code: "version_conflict" });
    await expect(preview(connection, rule([crypto.randomUUID()]))).rejects.toMatchObject({
      code: "validation_error",
    });
    const applied = await apply(connection, rule([label]));
    expect(applied).toMatchObject({ outbound: rule([label]), issueLinks: { creating: 2 } });

    const created = await flush();
    expect(created.map((request) => [request.method, request.url])).toEqual([
      ["POST", "/api/v3/repos/acme/widgets/issues"],
      ["POST", "/api/v3/repos/acme/widgets/issues"],
    ]);
    for (const ticket of [first, second]) {
      const link = await linkOf(ticket);
      expect(link).toMatchObject({ state: "active", origin: "outbound" });
      expect(forge.state.issues.get(link?.number ?? 0)?.body).toContain(
        `<!-- kanvil:ticket:${ticket.id} -->`,
      );
    }
    expect(await flush()).toEqual([]);
    expect(
      await app.domain.execute(
        "list_issue_links",
        { projectId: project.id, connectionId: connection.id },
        owner,
      ),
    ).toMatchObject([
      { ticketKey: first.key, state: "active", url: expect.stringContaining("/issues/") },
      { ticketKey: second.key, state: "active" },
    ]);
    // Unrestricted export covers every open ticket without a link.
    const listed = (
      await app.domain.execute("list_repository_connections", { projectId: project.id }, owner)
    )[0];
    if (!listed) throw new Error("Connection missing");
    await expect(preview(listed, rule([]))).resolves.toMatchObject({ matching: 2, export: 1 });
    await expect(preview(listed, off)).resolves.toMatchObject({ matching: 0, pause: 2 });
  });

  it("pauses on lost labels, holds requalified links for review, and resumes only from a fresh comparison", async () => {
    const name = await labelName();
    const ticket = await create("Keep in sync", [name]);
    const { number } = await exported(ticket);

    await update(ticket, { labels: [] });
    expect(await linkOf(ticket)).toMatchObject({ state: "paused", reason: "labels" });
    await update(ticket, { title: "Changed while paused" });
    expect(await flush()).toEqual([]);
    expect(forge.state.issues.get(number)?.title).toBe("Keep in sync");

    await update(ticket, { labels: [name] });
    expect(await linkOf(ticket)).toMatchObject({ state: "review", reason: "labels" });
    expect(await flush()).toEqual([]);
    const comparison = await compare(ticket);
    expect(comparison).toMatchObject({
      local: { title: "Changed while paused", open: true },
      remote: { title: "Keep in sync", open: true },
    });
    await update(ticket, { title: "Changed after the comparison" });
    await expect(
      app.domain.execute(
        "reconcile_issue_link",
        {
          projectId: project.id,
          linkId: comparison.link.id,
          expectedVersion: comparison.link.version,
          ticketVersion: comparison.ticketVersion,
          resolution: "kanvil",
        },
        owner,
      ),
    ).rejects.toMatchObject({ code: "version_conflict" });
    await reconcile(ticket, "kanvil");
    expect(await linkOf(ticket)).toMatchObject({ state: "active", reason: null });
    const pushed = await flush();
    expect(pushed).toMatchObject([{ method: "PATCH" }]);
    expect(forge.state.issues.get(number)?.title).toBe("Changed after the comparison");
    // Unlinking keeps both records.
    await reconcile(ticket, "unlink");
    expect(await linkOf(ticket)).toBeUndefined();
    expect(forge.state.issues.has(number)).toBe(true);
    expect(await current(ticket)).toMatchObject({ title: "Changed after the comparison" });
  });

  it("drops the link of a ticket moved to another project and keeps the issue", async () => {
    const ticket = await create("Moving away", [await labelName()]);
    const { connection, number } = await exported(ticket);
    const link = await linkOf(ticket);
    const destination = await app.domain.execute(
      "create_project",
      { key: `D${crypto.randomUUID().slice(0, 8).toUpperCase()}`, name: "Destination" },
      owner,
    );
    await app.domain.execute(
      "relocate_ticket",
      {
        projectId: project.id,
        ticketId: ticket.id,
        expectedVersion: (await current(ticket)).version,
        destinationProjectId: destination.id,
      },
      owner,
    );
    expect(await linkOf(ticket)).toBeUndefined();
    await expect(
      app.domain.execute(
        "compare_issue_link",
        { projectId: project.id, linkId: link?.id ?? "" },
        owner,
      ),
    ).rejects.toMatchObject({ code: "not_found" });
    expect(
      await app.domain.execute(
        "list_issue_links",
        { projectId: project.id, connectionId: connection.id },
        owner,
      ),
    ).toEqual([]);
    expect(forge.state.issues.has(number)).toBe(true);
    expect(await flush()).toEqual([]);
  });

  it("converges content and comments both ways without loops, repeats, or stale replays", async () => {
    const ticket = await create("Converge", [await labelName()]);
    const { connection, number } = await exported(ticket);

    await update(ticket, { title: "Renamed in Kanvil", description: "Details" });
    expect(await flush()).toMatchObject([{ method: "PATCH" }]);
    expect(forge.state.issues.get(number)).toMatchObject({ title: "Renamed in Kanvil" });
    // The host reports Kanvil's own edit back; nothing changes and nothing is sent again.
    const before = await current(ticket);
    expect(synced(await reportIssue(connection, number))).toEqual({
      key: ticket.key,
      result: "sync_synced",
    });
    expect((await current(ticket)).version).toBe(before.version);
    expect(await flush()).toEqual([]);

    const older = structuredClone(issueOf(number));
    expect(
      synced(
        await editIssue(connection, number, { title: "Renamed on the host", state: "closed" }),
      ),
    ).toMatchObject({ result: "sync_synced" });
    expect(await current(ticket)).toMatchObject({ title: "Renamed on the host", status: "done" });
    expect(await flush()).toEqual([]);
    // A delayed delivery older than the recorded state applies nothing.
    expect(
      synced(
        await send(connection, "issues", { action: "edited", issue: wire(older), repository }),
      ),
    ).toMatchObject({ result: "sync_stale" });
    expect(await current(ticket)).toMatchObject({ title: "Renamed on the host" });

    await app.domain.execute(
      "add_comment",
      { projectId: project.id, ticketId: ticket.id, body: "From Kanvil @everyone" },
      owner,
    );
    const posted = await flush();
    expect(posted).toMatchObject([
      { method: "POST", url: `/api/v3/repos/acme/widgets/issues/${number}/comments` },
    ]);
    const copy = forge.state.comments.at(-1);
    expect(copy?.body).toContain("From Kanvil @​everyone");
    const commentPayload = (id: number, body: string, at = "2031-01-01T00:00:00Z") => ({
      action: "created",
      issue: wire(issueOf(number)),
      comment: { id, body, user: { login: "octo" }, created_at: at },
      repository,
    });
    expect(
      (await send(connection, "issue_comment", commentPayload(copy?.id ?? 0, copy?.body ?? "")))
        .body,
    ).toMatchObject({ tickets: [{ result: "echo" }] });
    expect(await commentsOf(ticket)).toHaveLength(1);

    expect(
      (await send(connection, "issue_comment", commentPayload(77, "From the host"))).body,
    ).toMatchObject({ tickets: [{ result: "commented" }] });
    expect((await commentsOf(ticket)).map((comment) => comment.body)).toEqual([
      "From Kanvil @everyone",
      "**octo** commented on GitHub:\n\nFrom the host",
    ]);
    expect(await flush()).toEqual([]);
    // A second delivery of the same comment, and one from before the link existed, are not copied.
    expect(
      (await send(connection, "issue_comment", commentPayload(77, "From the host"))).body,
    ).toMatchObject({ tickets: [{ result: "duplicate" }] });
    expect(
      (await send(connection, "issue_comment", commentPayload(78, "Old", "2001-01-01T00:00:00Z")))
        .body,
    ).toMatchObject({ tickets: [{ result: "historical" }] });
    expect(await commentsOf(ticket)).toHaveLength(2);
  });

  it("stops for review on concurrent edits and claimed tickets, and resumes from the chosen side", async () => {
    const ticket = await create("Contested", [await labelName()]);
    const { connection, number } = await exported(ticket);

    await update(ticket, { title: "Kanvil title" });
    expect(synced(await editIssue(connection, number, { title: "Host title" }))).toMatchObject({
      result: "sync_conflict",
    });
    expect(await linkOf(ticket)).toMatchObject({ state: "review", reason: "conflict" });
    expect(await flush()).toEqual([]);
    expect(await compare(ticket)).toMatchObject({
      local: { title: "Kanvil title" },
      remote: { title: "Host title" },
      base: { title: "Contested" },
    });
    await reconcile(ticket, "remote");
    expect(await current(ticket)).toMatchObject({ title: "Host title" });
    expect(await linkOf(ticket)).toMatchObject({ state: "active" });
    expect(await flush()).toEqual([]);

    await update(ticket, {
      description: "Build it",
      acceptanceCriteria: "It works",
      difficulty: "low",
      automationReady: true,
    });
    expect(await flush()).toMatchObject([{ method: "PATCH" }]);
    const worker = await app.domain.actor(owner.id, {
      ownerId: "agent",
      scopes: ["read", "claim"],
    });
    await app.domain.execute(
      "claim_ticket",
      {
        projectId: project.id,
        ticketId: ticket.id,
        workerId: "agent-1",
        expectedVersion: (await current(ticket)).version,
      },
      worker,
    );
    expect(synced(await editIssue(connection, number, { body: "Host description" }))).toMatchObject(
      {
        result: "sync_claim_conflict",
      },
    );
    expect(await linkOf(ticket)).toMatchObject({ state: "review", reason: "claim_conflict" });
    expect((await current(ticket)).description).toBe("Build it");
  });

  it("never repeats an ambiguous creation and confirms it from the issue's own webhook", async () => {
    const name = await labelName();
    const failed = await create("Server error", [name]);
    const connection = await connect();
    await flush();
    forge.state.script = [{ status: 503 }];
    await apply(connection, rule());
    expect(await flush()).toHaveLength(1);
    expect(await linkOf(failed)).toMatchObject({ state: "unknown", reason: "http_503" });
    expect(await flush()).toEqual([]);
    // Creating it again is the administrator's explicit choice.
    await reconcile(failed, "kanvil");
    expect(await flush()).toMatchObject([{ method: "POST" }]);
    expect(await linkOf(failed)).toMatchObject({ state: "active" });

    // The host creates the issue but its answer arrives after the deadline.
    const slow = await create("Slow answer", [name]);
    forge.state.script = [{ delay: 600 }];
    expect(await flush(300)).toHaveLength(1);
    expect(await linkOf(slow)).toMatchObject({ state: "unknown", reason: "timeout" });
    expect(await flush()).toEqual([]);
    const number = forge.state.next - 1;
    expect(forge.state.issues.get(number)?.title).toBe("Slow answer");
    expect(synced(await reportIssue(connection, number, "opened"))).toEqual({
      key: slow.key,
      result: "sync_synced",
    });
    expect(await linkOf(slow)).toMatchObject({ state: "active", number });
    expect(await flush()).toEqual([]);

    // Updates set whole values, so a failed one is retried.
    await update(slow, { title: "Retried" });
    forge.state.script = [{ status: 502 }];
    expect(await flush()).toHaveLength(1);
    await fixture.database.db.update(deliveries).set({ availableAt: new Date() });
    expect(await flush()).toMatchObject([{ method: "PATCH" }]);
    expect(forge.state.issues.get(number)?.title).toBe("Retried");

    // A refusal means no issue exists; the link waits instead of retrying.
    const refused = await create("Refused", [name]);
    forge.state.script = [{ status: 422 }];
    await flush();
    expect(await linkOf(refused)).toMatchObject({ state: "paused", reason: "http_422" });
  });

  it("refuses issue content longer than a ticket allows instead of truncating it", async () => {
    const name = await labelName();
    const ticket = await create("Fits", [name]);
    const { connection, number } = await exported(ticket);
    const long = "x".repeat(100_001);
    expect(synced(await editIssue(connection, number, { body: long }))).toMatchObject({
      result: "sync_invalid_content",
    });
    expect(await linkOf(ticket)).toMatchObject({ state: "review", reason: "invalid_content" });
    expect((await current(ticket)).description).toBe("");
    expect(await flush()).toEqual([]);
    expect(forge.state.issues.get(number)?.body).toBe(long);
    await expect(reconcile(ticket, "remote")).rejects.toMatchObject({ code: "validation_error" });
    expect((await current(ticket)).description).toBe("");

    await apply(connection, off, rule());
    forge.state.issues.set(900, {
      number: 900,
      title: "y".repeat(501),
      body: "",
      state: "open",
      labels: [name],
      updated_at: forge.stamp(),
    });
    expect(synced(await reportIssue(connection, 900, "opened"))).toMatchObject({
      result: "sync_invalid_content",
    });
    const tickets = await app.domain.execute("list_tickets", { projectId: project.id }, owner);
    expect(tickets.items).toHaveLength(1);
  });

  it("stops a link for review once an update has used its retries", async () => {
    const ticket = await create("Unreachable", [await labelName()]);
    const { number } = await exported(ticket);
    await update(ticket, { title: "Never arrives" });
    forge.state.script = Array.from({ length: 5 }, () => ({ status: 503 }));
    for (let attempt = 0; attempt < 5; attempt++) {
      expect(await flush()).toMatchObject([{ method: "PATCH" }]);
      await fixture.database.db.update(deliveries).set({ availableAt: new Date() });
    }
    expect(await linkOf(ticket)).toMatchObject({ state: "review", reason: "http_503" });
    expect(forge.state.issues.get(number)?.title).toBe("Unreachable");
    await reconcile(ticket, "kanvil");
    expect(await flush()).toMatchObject([{ method: "PATCH" }]);
    expect(forge.state.issues.get(number)?.title).toBe("Never arrives");
  });

  it("copies a ticket comment to each linked issue once", async () => {
    const ticket = await create("Linked twice", [await labelName()]);
    await exported(ticket);
    await apply(await connect("acme/gadgets"), rule());
    await flush();
    await app.domain.execute(
      "add_comment",
      { projectId: project.id, ticketId: ticket.id, body: "For both" },
      owner,
    );
    const posted = await flush();
    expect(posted.map((request) => request.url).toSorted()).toEqual([
      expect.stringMatching(/^\/api\/v3\/repos\/acme\/gadgets\/issues\/\d+\/comments$/),
      expect.stringMatching(/^\/api\/v3\/repos\/acme\/widgets\/issues\/\d+\/comments$/),
    ]);
    expect(await flush()).toEqual([]);
  });

  it("lets rules drop labels that no longer exist in the workspace", async () => {
    const connection = await connect();
    const gone = crypto.randomUUID();
    await fixture.database.db
      .update(repositoryConnections)
      .set({ outbound: { enabled: true, labels: [gone], match: "any" } })
      .where(eq(repositoryConnections.id, connection.id));
    // Turning the rule off, or saving it without the stale label, still works.
    await expect(
      preview(connection, { enabled: false, labels: [gone], match: "any" }),
    ).resolves.toMatchObject({ export: 0 });
    await expect(preview(connection, rule())).resolves.toMatchObject({ export: 0 });
  });

  it("stops links for review when a sync is skipped for archiving or lost access", async () => {
    const ticket = await create("Archived later", [await labelName()]);
    await exported(ticket);
    await update(ticket, { title: "Unsent" });
    const archived = await app.domain.execute(
      "archive_project",
      {
        projectId: project.id,
        expectedVersion: (await app.domain.execute("get_project", { projectId: project.id }, owner))
          .version,
        archived: true,
      },
      owner,
    );
    expect(await flush()).toEqual([]);
    expect(await linkOf(ticket)).toMatchObject({ state: "review", reason: "project_archived" });
    await app.domain.execute(
      "archive_project",
      { projectId: project.id, expectedVersion: archived.version, archived: false },
      owner,
    );
    await reconcile(ticket, "kanvil");
    expect(await flush()).toMatchObject([{ method: "PATCH" }]);
    expect(await linkOf(ticket)).toMatchObject({ state: "active" });
  });

  it("imports qualifying issues and keeps issue state for review while the connection is paused", async () => {
    const name = await labelName();
    const connection = await apply(await connect(), off, rule());
    const issue = (number: number, labels: string[]): Issue => ({
      number,
      title: `Host issue ${number}`,
      body: "Reported on the host",
      state: "open",
      labels,
      updated_at: forge.stamp(),
    });
    forge.state.issues.set(501, issue(501, [name.toUpperCase()]));
    forge.state.issues.set(502, issue(502, ["unrelated"]));
    const imported = await reportIssue(connection, 501, "opened");
    expect(synced(imported)).toMatchObject({ result: "sync_imported" });
    expect((await reportIssue(connection, 502, "opened")).body).toMatchObject({
      outcome: "no_ticket",
    });
    const tickets = await app.domain.execute("list_tickets", { projectId: project.id }, owner);
    expect(tickets.items).toMatchObject([
      { title: "Host issue 501", description: "Reported on the host", labels: [name] },
    ]);
    const ticket = tickets.items[0];
    if (!ticket) throw new Error("No imported ticket");
    expect(await linkOf(ticket)).toMatchObject({ origin: "inbound", state: "active", number: 501 });
    // Its own creation queued no export.
    expect(await flush()).toEqual([]);

    expect(synced(await editIssue(connection, 501, { labels: [] }))).toMatchObject({
      result: "sync_paused",
    });
    expect(await linkOf(ticket)).toMatchObject({ state: "paused", reason: "labels" });
    expect(synced(await editIssue(connection, 501, { labels: [name] }))).toMatchObject({
      result: "sync_review",
    });
    await reconcile(ticket, "remote");

    const paused = await app.domain.execute(
      "update_repository_connection",
      {
        projectId: project.id,
        connectionId: connection.id,
        expectedVersion:
          (
            await app.domain.execute(
              "list_repository_connections",
              { projectId: project.id },
              owner,
            )
          )[0]?.version ?? 0,
        paused: true,
      },
      owner,
    );
    expect((await editIssue(connection, 501, { title: "Edited while paused" })).body).toMatchObject(
      {
        outcome: "paused",
      },
    );
    expect(await linkOf(ticket)).toMatchObject({ state: "review", reason: "changed_while_paused" });
    expect(await current(ticket)).toMatchObject({ title: "Host issue 501" });
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
    await reconcile(ticket, "remote");
    expect(await current(ticket)).toMatchObject({ title: "Edited while paused" });
  });
});

describe("issue sync drivers", () => {
  it("reads GitLab issues and notes and writes issues with its own fields", () => {
    const driver = createGitLabDriver();
    const project = {
      path_with_namespace: "acme/widgets",
      web_url: "https://gitlab.com/acme/widgets",
    };
    const read = (payload: unknown, event: string) =>
      driver.read(
        headers({ "x-gitlab-event": event, "idempotency-key": crypto.randomUUID() }),
        JSON.stringify(payload),
      );
    expect(
      read(
        {
          object_kind: "issue",
          object_attributes: {
            iid: 4,
            url: "https://gitlab.com/acme/widgets/-/issues/4",
            title: "From GitLab",
            description: "Body",
            state: "closed",
            action: "close",
            updated_at: "2030-01-01 10:00:00 UTC",
          },
          labels: [{ title: "Sync" }],
          project,
        },
        "Issue Hook",
      ).issue,
    ).toEqual({
      number: 4,
      url: "https://gitlab.com/acme/widgets/-/issues/4",
      title: "From GitLab",
      description: "Body",
      open: false,
      labels: ["Sync"],
      updatedAt: new Date("2030-01-01T10:00:00Z"),
    });
    const note = (system: boolean) =>
      read(
        {
          object_kind: "note",
          object_attributes: {
            id: 12,
            note: "Looks good",
            noteable_type: "Issue",
            created_at: "2030-01-01T10:00:00Z",
            system,
          },
          issue: { iid: 4 },
          user: { username: "tanuki" },
          project,
        },
        "Note Hook",
      ).comment;
    expect(note(false)).toEqual({
      id: "12",
      issue: 4,
      body: "Looks good",
      author: "tanuki",
      createdAt: new Date("2030-01-01T10:00:00Z"),
    });
    expect(note(true)).toBeNull();
    const target = { repository: "acme/widgets", baseUrl: "https://gitlab.com" };
    expect(
      driver.updateIssue(target, "token", 4, { open: false, description: "New" }),
    ).toMatchObject({
      method: "PUT",
      url: "https://gitlab.com/api/v4/projects/acme%2Fwidgets/issues/4",
      body: JSON.stringify({ description: "New", state_event: "close" }),
      read: true,
    });
    expect(
      driver.issue(
        JSON.stringify({
          iid: 5,
          web_url: "https://gitlab.com/acme/widgets/-/issues/5",
          title: "Made",
          description: null,
          state: "opened",
          labels: ["a"],
          updated_at: "2030-01-01T10:00:00Z",
        }),
      ),
    ).toMatchObject({ number: 5, description: "", open: true, labels: ["a"] });
  });
  it("reads Gitea label edits as issue changes and skips pull request comments", () => {
    const driver = createGiteaDriver();
    const gitea = {
      full_name: "acme/widgets",
      html_url: "https://git.example.com/acme/widgets",
    };
    const issue = {
      number: 3,
      html_url: "https://git.example.com/acme/widgets/issues/3",
      title: "Labelled",
      body: "Body",
      state: "open",
      labels: [{ name: "sync" }],
      updated_at: "2030-01-01T10:00:00+02:00",
    };
    const read = (event: string, payload: unknown) =>
      driver.read(
        headers({ "x-gitea-event": event, "x-gitea-delivery": crypto.randomUUID() }),
        JSON.stringify(payload),
      );
    expect(
      read("issue_label", { action: "label_updated", issue, repository: gitea }).issue,
    ).toMatchObject({
      number: 3,
      labels: ["sync"],
    });
    const comment = { id: 7, body: "Hi", user: { login: "gitea" }, created_at: issue.updated_at };
    expect(
      read("issue_comment", { action: "created", issue, comment, repository: gitea }).comment,
    ).toMatchObject({
      id: "7",
      issue: 3,
    });
    expect(
      read("issue_comment", { action: "created", issue, comment, is_pull: true, repository: gitea })
        .comment,
    ).toBeNull();
  });
});
