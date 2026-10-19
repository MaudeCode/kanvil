import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vite-plus/test";
import { asc, eq, inArray } from "drizzle-orm";
import type { ImportSource, Operation, Output } from "@kanvil/contracts";
import { createFixture } from "./test-fixture.ts";
import { createDomain, type Actor, type Domain } from "./domain.ts";
import { processImports } from "./import-operations.ts";
import { createImportSources } from "./adapters/import-sources.ts";
import { createHttpSender } from "./adapters/outbound.ts";
import { comments, importRecords, importRuns, receipts, relations, tickets } from "./schema.ts";
import { fakeCredentials, sourceOwnerEmail, startImportSources } from "./import-source-fixture.ts";

const prefix = (letter: string) =>
  `${letter}${crypto.randomUUID().replaceAll("-", "").slice(0, 8).toUpperCase()}`;
const linearToken = "lin_api_fixture_secret_0123456789";
const jiraToken = "jira-fixture-secret-0123456789";

// The preview's warnings, by their start.
const warns = (staged: Output<"preview_source_import">, ...starts: string[]) => {
  const messages = staged.issues.map((issue) => issue.message);
  for (const start of starts)
    expect(
      messages.some((message) => message.startsWith(start)),
      start,
    ).toBe(true);
};
describe("imports from other trackers", () => {
  let fixture: Awaited<ReturnType<typeof createFixture>>,
    source: Awaited<ReturnType<typeof startImportSources>>,
    domain: Domain,
    owner: Actor,
    reader: Actor,
    workspaceId: string;
  const linear: ImportSource = { provider: "linear", token: linearToken };
  const jira = (edition: "cloud" | "data_center"): ImportSource => ({
    provider: "jira",
    edition,
    baseUrl: source.jiraUrl,
    email: edition === "cloud" ? "owner@example.test" : "",
    token: jiraToken,
  });
  const trello: ImportSource = { provider: "trello", ...fakeCredentials.trello };
  const plane = (): ImportSource => ({
    provider: "plane",
    baseUrl: source.planeUrl,
    workspace: "acme",
    token: fakeCredentials.plane,
  });
  const planka = (signIn: "password" | "api_key" = "password"): ImportSource => ({
    provider: "planka",
    baseUrl: source.plankaUrl,
    signIn,
    username: signIn === "password" ? fakeCredentials.planka.username : "",
    password: signIn === "password" ? fakeCredentials.planka.password : "",
    token: signIn === "api_key" ? fakeCredentials.planka.apiKey : "",
  });
  const kaneo = (): ImportSource => ({
    provider: "kaneo",
    baseUrl: source.kaneoUrl,
    token: fakeCredentials.kaneo,
  });
  const list = (from: ImportSource) =>
    domain.execute("list_import_source_projects", { workspaceId, source: from }, owner);
  beforeAll(async () => {
    fixture = await createFixture();
    source = await startImportSources();
    domain = createDomain(fixture.database, {
      sources: createImportSources(createHttpSender({ allowPrivate: true }), source.urls),
    });
    const people = await Promise.all(
      [
        ["Owner", sourceOwnerEmail],
        ["Reader", "reader@example.test"],
      ].map(([name, email]) =>
        fixture.auth.api.createUser({
          body: {
            name: name!,
            email: email!,
            password: "Isolated fixture password 42!",
            role: "user",
          },
        }),
      ),
    );
    owner = await domain.actor(people[0]!.user.id);
    reader = await domain.actor(people[1]!.user.id);
    workspaceId = (
      await domain.execute(
        "create_project",
        { key: prefix("W"), name: "Home", visibility: "workspace" },
        owner,
      )
    ).workspaceId;
    await domain.execute(
      "set_workspace_member",
      { workspaceId, email: "reader@example.test", role: "reader" },
      owner,
    );
  });
  afterAll(async () => {
    await source?.close();
    await fixture?.close();
  });
  beforeEach(() => source.reset());

  const preview = (
    from: ImportSource,
    sourceProject: string,
    options: { includeComments?: boolean; actor?: Actor } = {},
  ) =>
    domain.execute(
      "preview_source_import",
      {
        workspaceId,
        key: prefix("I"),
        name: "Imported",
        visibility: "workspace",
        source: from,
        sourceProject,
        includeComments: options.includeComments ?? true,
      },
      options.actor ?? owner,
    );
  const run = async (staged: Output<"preview_source_import">) => {
    await domain.execute(
      "start_import",
      { workspaceId, importId: staged.id, expectedVersion: staged.version },
      owner,
    );
    while (await processImports(domain));
    return domain.execute("get_import", { workspaceId, importId: staged.id }, owner);
  };
  const imported = async (projectId: string) => {
    const rows = await fixture.database.db
      .select()
      .from(tickets)
      .where(eq(tickets.projectId, projectId))
      .orderBy(asc(tickets.number));
    const ids = rows.map((row) => row.id);
    return {
      rows,
      byTitle: (title: string) => rows.find((row) => row.title === title)!,
      relations: await fixture.database.db
        .select()
        .from(relations)
        .where(inArray(relations.sourceId, ids)),
      comments: await fixture.database.db
        .select()
        .from(comments)
        .where(inArray(comments.ticketId, ids))
        .orderBy(asc(comments.createdAt)),
      states: await domain.execute("list_workflow_states", { projectId }, owner),
    };
  };
  // Every source request was a read; a PLANKA password signs in and out around them.
  const readOnly = () => {
    expect(source.requests.length).toBeGreaterThan(0);
    for (const request of source.requests)
      if (request.path.startsWith("/linear/")) {
        expect(request.method).toBe("POST");
        expect(request.body).toMatch(/^\{"query":"query /);
        expect(request.body).not.toMatch(/mutation/i);
      } else if (request.path === "/planka/api/access-tokens") expect(request.method).toBe("POST");
      else if (request.path === "/planka/api/access-tokens/me")
        expect(request.method).toBe("DELETE");
      else expect(request.method).toBe("GET");
  };
  // The credentials reach the source and nothing Kanvil stores or answers.
  const leaves = async (secret: string, answer: unknown) => {
    expect(JSON.stringify(answer)).not.toContain(secret);
    const stored = JSON.stringify([
      await fixture.database.db.select().from(importRuns),
      await fixture.database.db.select().from(importRecords),
      await fixture.database.db.select().from(receipts),
      await fixture.database.db.select().from(comments),
      await fixture.database.db.select().from(tickets),
    ]);
    expect(stored).not.toContain(secret);
    expect(stored).not.toContain(Buffer.from(`owner@example.test:${secret}`).toString("base64"));
  };

  it("lists the teams and projects the credentials can read, page by page", async () => {
    expect(
      await domain.execute("list_import_source_projects", { workspaceId, source: linear }, owner),
    ).toEqual([
      { ref: "lin-team", key: "ENG", name: "Engineering", group: "" },
      { ref: "lin-team-2", key: "DES", name: "Design", group: "" },
      { ref: "lin-team-3", key: "OPS", name: "Operations", group: "" },
    ]);
    expect(source.requests.every((request) => request.authorization === linearToken)).toBe(true);
    for (const edition of ["cloud", "data_center"] as const) {
      const listed = await domain.execute(
        "list_import_source_projects",
        { workspaceId, source: jira(edition) },
        owner,
      );
      expect(listed.map((item) => item.key)).toEqual(
        edition === "cloud" ? ["OPS", "WEB", "HR"] : ["OPS", "WEB"],
      );
    }
    expect(source.requests.at(-1)?.authorization).toBe(`Bearer ${jiraToken}`);
    expect(source.requests[3]?.authorization).toBe(
      `Basic ${Buffer.from(`owner@example.test:${jiraToken}`).toString("base64")}`,
    );
    readOnly();
  });

  it("refuses workspace readers and credentials before reaching the source", async () => {
    await expect(
      domain.execute("list_import_source_projects", { workspaceId, source: linear }, reader),
    ).rejects.toMatchObject({ status: 403, code: "forbidden" });
    await expect(preview(linear, "lin-team", { actor: reader })).rejects.toMatchObject({
      status: 403,
      code: "forbidden",
    });
    await expect(
      domain.execute(
        "list_import_source_projects",
        { workspaceId, source: linear },
        { ...owner, machine: true },
      ),
    ).rejects.toMatchObject({ status: 403, code: "session_required" });
    expect(source.requests).toEqual([]);
  });

  it("imports a Linear team with its hierarchy, workflow, labels, people, and comments", async () => {
    const staged = await preview(linear, "lin-team");
    expect(staged.issues.filter((issue) => issue.severity === "error")).toEqual([]);
    expect(staged.counts).toMatchObject({
      tickets: 3,
      workflow: 6,
      labels: 2,
      relations: 1,
      comments: 3,
    });
    const messages = staged.issues.map((issue) => issue.message);
    // What Linear holds and Kanvil does not is disclosed, never invented.
    for (const omitted of [
      "Not imported: cycles (1)",
      "Not imported: estimates (1)",
      "Not imported: milestones (1)",
      "Not imported: Linear projects (1)",
      "Not imported: attachments.",
    ])
      expect(messages.some((message) => message.startsWith(omitted))).toBe(true);
    expect(messages).toEqual(
      expect.arrayContaining([
        "Relationships to tickets outside the import are left out: ENG-2",
        "Tickets lose an assignee who cannot open the new project: ENG-2",
      ]),
    );
    expect(staged.members.find((person) => person.email === sourceOwnerEmail)?.userId).toBe(
      owner.id,
    );
    readOnly();
    await leaves(linearToken, staged);

    const finished = await run(staged);
    expect(finished).toMatchObject({ status: "completed", progress: { failed: 0 } });
    const result = await imported(finished.projectId!);
    const parent = result.byTitle("Ship the importer"),
      child = result.byTitle("Map nested issues"),
      archived = result.byTitle("Archive the old tracker");
    expect(parent).toMatchObject({
      priority: "urgent",
      kind: "bug",
      labels: ["Bug", "migration"],
      assigneeId: owner.id,
      description: "Parent **work**",
      difficulty: null,
    });
    expect(parent.dueAt?.toISOString()).toBe("2026-12-01T23:59:59.999Z");
    expect(child).toMatchObject({ parentId: parent.id, priority: "medium", assigneeId: null });
    expect(archived).toMatchObject({ archived: true, priority: "low", status: "done" });
    // A started state named like Kanvil's review state lands in that category.
    expect(result.states.find((state) => state.id === parent.stateId)).toMatchObject({
      name: "In review",
      category: "in_review",
    });
    expect(result.states.map((state) => state.name)).toEqual(
      expect.arrayContaining(["Todo", "Canceled"]),
    );
    expect(result.relations).toEqual([
      expect.objectContaining({ sourceId: child.id, targetId: archived.id, type: "blocks" }),
    ]);
    expect(result.comments.map((comment) => comment.body)).toEqual([
      "Originally by Bob Elsewhere on 2026-01-05.\n\nStarted on the mapping",
      "Originally by an unknown author on 2026-01-06.\n\nPosted by an integration",
      "Originally by Ann Linear on 2026-01-07.\n\nBlocked until ENG-3",
    ]);
    await leaves(linearToken, finished);
  });

  it("answers a retried preview from its receipt without reading the source again", async () => {
    const input = {
      workspaceId,
      key: prefix("R"),
      name: "Retried",
      visibility: "workspace" as const,
      source: linear,
      sourceProject: "lin-team",
      includeComments: false,
      requestId: crypto.randomUUID(),
    };
    const first = await domain.execute("preview_source_import", input, owner);
    const reads = source.requests.length;
    expect(reads).toBeGreaterThan(0);
    // The response was lost and the client retries the same request.
    const again = await domain.execute("preview_source_import", input, owner);
    expect(again.id).toBe(first.id);
    expect(source.requests).toHaveLength(reads);
    await expect(
      domain.execute("preview_source_import", { ...input, key: prefix("R") }, owner),
    ).rejects.toMatchObject({ status: 409, code: "idempotency_conflict" });
    await leaves(linearToken, again);
  });

  it("leaves comments out on request and says so", async () => {
    const staged = await preview(linear, "lin-team", { includeComments: false });
    expect(staged.counts.comments).toBe(0);
    expect(staged.issues.map((issue) => issue.message)).toContain(
      "Not imported: comments. Left out when the import was set up.",
    );
    expect(source.requests.some((request) => request.body.includes("query Comments"))).toBe(false);
  });

  it("imports a Jira Cloud project with sub-tasks, links, and every comment page", async () => {
    const staged = await preview(jira("cloud"), "10000");
    expect(staged.issues.filter((issue) => issue.severity === "error")).toEqual([]);
    expect(staged.counts).toMatchObject({ tickets: 3, workflow: 4, relations: 1, comments: 2 });
    const messages = staged.issues.map((issue) => issue.message);
    for (const omitted of [
      "Not imported: estimates (1)",
      "Not imported: fix versions (1)",
      "Not imported: attachments (2)",
      "Not imported: sprints and story points.",
      "Not imported: Jira formatting.",
    ])
      expect(messages.some((message) => message.startsWith(omitted))).toBe(true);
    expect(source.requests.some((request) => request.path.includes("nextPageToken=2"))).toBe(true);
    expect(
      source.requests.some((request) =>
        request.path.startsWith("/jira/rest/api/2/issue/10001/comment"),
      ),
    ).toBe(true);
    readOnly();
    const finished = await run(staged);
    expect(finished).toMatchObject({ status: "completed", progress: { failed: 0 } });
    const result = await imported(finished.projectId!);
    const drill = result.byTitle("Database failover drill"),
      runbook = result.byTitle("Write the runbook"),
      retire = result.byTitle("Retire the old cluster");
    expect(drill).toMatchObject({
      priority: "urgent",
      kind: "bug",
      labels: ["infra"],
      assigneeId: owner.id,
      description: "h2. Steps\n* one",
    });
    expect(drill.createdBy).toBe(owner.id);
    expect(runbook).toMatchObject({
      parentId: drill.id,
      priority: "low",
      kind: "feature",
      assigneeId: null,
    });
    expect(result.states.find((state) => state.id === drill.stateId)?.category).toBe("in_review");
    expect(result.states.find((state) => state.id === retire.stateId)?.category).toBe("done");
    expect(retire).toMatchObject({ kind: "bug", labels: ["bug"] });
    // The link is on both issues in Jira and becomes one relationship.
    expect(result.relations).toEqual([
      expect.objectContaining({ sourceId: drill.id, targetId: retire.id, type: "blocks" }),
    ]);
    expect(result.comments.map((comment) => comment.body)).toEqual([
      "Originally by Hidden Email on 2026-03-02.\n\nFirst look",
      "Originally by Owner Jira on 2026-03-02.\n\nDrill passed",
    ]);
    await leaves(jiraToken, finished);
  });

  it("reads a Jira Data Center project by offset with a personal access token", async () => {
    const staged = await preview(jira("data_center"), "OPS", { includeComments: false });
    expect(staged.counts).toMatchObject({ tickets: 3, comments: 0 });
    expect(staged.issues.map((issue) => issue.message)).toEqual(
      expect.arrayContaining([expect.stringMatching(/^Not imported: epic links\./)]),
    );
    const searches = source.requests.filter((request) =>
      request.path.startsWith("/jira/rest/api/2/search?"),
    );
    expect(
      searches.map((request) => new URLSearchParams(request.path.split("?")[1]).get("startAt")),
    ).toEqual(["0", "2"]);
    expect(
      source.requests.every((request) => request.authorization === `Bearer ${jiraToken}`),
    ).toBe(true);
    readOnly();
  });

  it("waits out rate limits and reports sources that keep failing", async () => {
    const before = (await fixture.database.db.select({ id: importRuns.id }).from(importRuns))
      .length;
    source.fail(1, 429, { "Retry-After": "0" });
    expect((await preview(linear, "lin-team")).counts.tickets).toBe(3);
    // Linear also limits with a GraphQL error.
    source.fail(
      1,
      400,
      {},
      JSON.stringify({
        errors: [{ message: "Rate limited", extensions: { code: "RATELIMITED" } }],
      }),
    );
    expect((await preview(linear, "lin-team")).counts.tickets).toBe(3);
    source.fail(4, 429, { "Retry-After": "0" });
    await expect(preview(linear, "lin-team")).rejects.toMatchObject({
      status: 429,
      code: "source_rate_limited",
    });
    source.fail(4, 503, { "Retry-After": "0" });
    await expect(preview(jira("cloud"), "10000")).rejects.toMatchObject({
      status: 502,
      code: "source_unavailable",
    });
    source.fail(1, 401);
    const refused = preview(jira("cloud"), "10000");
    await expect(refused).rejects.toMatchObject({ status: 422, code: "source_rejected" });
    await expect(refused).rejects.not.toHaveProperty("message", expect.stringContaining(jiraToken));
    source.fail(1, 200, {}, "<html>");
    await expect(preview(linear, "lin-team")).rejects.toMatchObject({ code: "source_unavailable" });
    // An answer in a shape the reader does not know is unreadable, not a server error.
    source.fail(1, 200, {}, JSON.stringify({ data: { team: { id: 42 } } }));
    await expect(preview(linear, "lin-team")).rejects.toMatchObject({
      status: 502,
      code: "source_unavailable",
      message: "Linear sent a response Kanvil cannot read",
    });
    // A request the source refuses as malformed is not repeated.
    source.reset();
    source.fail(1, 400);
    await expect(preview(jira("cloud"), "10000")).rejects.toMatchObject({
      status: 502,
      message: "Jira answered with an error (400)",
    });
    expect(source.requests).toHaveLength(1);
    await expect(preview(linear, "lin-missing")).rejects.toMatchObject({
      status: 404,
      code: "not_found",
    });
    await expect(preview(jira("cloud"), "99999")).rejects.toMatchObject({
      status: 404,
      code: "not_found",
    });
    // Nothing was staged by the failed reads.
    const staged = await fixture.database.db.select({ id: importRuns.id }).from(importRuns);
    expect(staged).toHaveLength(before + 2);
  });

  it("keeps private addresses closed unless the operator opens them", async () => {
    const closed = createDomain(fixture.database, {
      sources: createImportSources(createHttpSender({ allowPrivate: false }), source.urls),
    });
    await expect(
      closed.execute("list_import_source_projects", { workspaceId, source: jira("cloud") }, owner),
    ).rejects.toMatchObject({
      status: 502,
      code: "source_unavailable",
      message: expect.stringContaining("blocked_address"),
    });
    expect(source.requests).toEqual([]);
  });

  it("resumes a source import after a restart without writing anything twice", async () => {
    let interrupted = false;
    async function execute<K extends Operation>(
      name: K,
      value: unknown,
      actor: Actor,
      provenance?: { importRun: string },
    ) {
      const result = await domain.execute(name, value, actor, provenance);
      if (name === "create_ticket" && !interrupted) {
        interrupted = true;
        throw new Error("Simulated restart");
      }
      return result;
    }
    const staged = await preview(linear, "lin-team");
    await domain.execute(
      "start_import",
      { workspaceId, importId: staged.id, expectedVersion: staged.version },
      owner,
    );
    const requests = source.requests.length;
    await expect(processImports({ ...domain, execute })).rejects.toThrow("Simulated restart");
    while (await processImports(domain));
    const finished = await domain.execute(
      "get_import",
      { workspaceId, importId: staged.id },
      owner,
    );
    expect(finished).toMatchObject({ status: "completed", progress: { failed: 0 } });
    expect((await imported(finished.projectId!)).rows).toHaveLength(3);
    // The run writes from its staged records; the source is never read again.
    expect(source.requests).toHaveLength(requests);
  });
  it("lists Trello boards, Plane and Kaneo projects, and PLANKA boards by their project", async () => {
    expect(await list(trello)).toEqual([
      { ref: "tb-roadmap", key: "", name: "Roadmap", group: "" },
      { ref: "tb-ideas", key: "", name: "Ideas", group: "" },
    ]);
    expect((await list(plane())).map((item) => item.key)).toEqual(["WEB", "APP", "OPS"]);
    expect(source.requests.some((request) => request.path.includes("cursor=2%3A2%3A0"))).toBe(true);
    expect(await list(planka())).toEqual([
      { ref: "2002", key: "", name: "Classic", group: "Marketing" },
      { ref: "2001", key: "", name: "Campaigns", group: "Marketing" },
    ]);
    expect(await list(kaneo())).toEqual([
      { ref: "kp-platform", key: "PLAT", name: "Platform", group: "Acme" },
      { ref: "kp-docs", key: "DOCS", name: "Docs", group: "Acme" },
    ]);
    readOnly();
    // Each source got its own credentials, in a header.
    const sent = (start: string) =>
      source.requests.filter((request) => request.path.startsWith(start));
    expect(sent("/trello/").every((request) => request.authorization.includes(trello.token))).toBe(
      true,
    );
    expect(sent("/plane/").every((request) => request.apiKey === fakeCredentials.plane)).toBe(true);
    expect(
      sent("/kaneo/").every((request) => request.authorization.endsWith(fakeCredentials.kaneo)),
    ).toBe(true);
    expect(sent("/planka/").map((request) => `${request.method} ${request.path}`)).toEqual([
      "POST /planka/api/access-tokens",
      "GET /planka/api/projects",
      "DELETE /planka/api/access-tokens/me",
    ]);
    // None in an address, where proxies and logs keep it.
    const addresses = JSON.stringify(source.requests.map((request) => request.path));
    for (const secret of [
      trello.token,
      trello.apiKey,
      fakeCredentials.plane,
      fakeCredentials.kaneo,
    ])
      expect(addresses).not.toContain(secret);
  });

  it("imports a Trello board with its lists, checklists, members, and comments", async () => {
    const staged = await preview(trello, "tb-roadmap");
    expect(staged.issues.filter((issue) => issue.severity === "error")).toEqual([]);
    expect(staged.counts).toMatchObject({ tickets: 3, workflow: 4, labels: 3, comments: 2 });
    warns(
      staged,
      "Not imported: completed due dates (1)",
      "Not imported: attachments (2)",
      "Not imported: custom fields (1)",
      "Not imported: additional assignees (1)",
    );
    readOnly();
    await leaves(fakeCredentials.trello.token, staged);
    await leaves(fakeCredentials.trello.apiKey, staged);
    const finished = await run(staged);
    expect(finished).toMatchObject({ status: "completed", progress: { failed: 0 } });
    const result = await imported(finished.projectId!);
    const launch = result.byTitle("Plan the launch"),
      copy = result.byTitle("Write the copy");
    expect(launch).toMatchObject({
      kind: "bug",
      labels: ["Bug", "green_dark"],
      priority: "none",
      assigneeId: null,
      description: "Launch **plan**\n\n### Steps\n\n- [x] Draft\n- [ ] Review",
    });
    expect(launch.startAt?.toISOString()).toBe("2026-04-01T09:00:00.000Z");
    expect(launch.dueAt?.toISOString()).toBe("2026-05-01T17:00:00.000Z");
    // The archived card keeps its archived list, renamed apart from the open one.
    expect(copy).toMatchObject({ archived: true, labels: ["marketing"] });
    expect(result.states.find((state) => state.id === copy.stateId)).toMatchObject({
      name: "Done 2",
      category: "done",
    });
    expect(result.states.map((state) => state.name)).not.toContain("Someday");
    const labels = await domain.execute(
      "list_project_labels",
      { projectId: finished.projectId! },
      owner,
    );
    expect(labels.find((label) => label.name === "green_dark")?.color).toBe("green");
    expect(result.comments.map((comment) => comment.body)).toEqual([
      "Originally by Ann Trello on 2026-04-01.\n\nDrafting now",
      "Originally by Bob Trello on 2026-04-01.\n\nCopy is ready",
    ]);
  });

  it("pages past Trello's thousand-item cap without repeating an item", async () => {
    const card = source.data.trello.cards[2]!.id;
    for (let n = 0; n < 1000; n++)
      source.data.trello.comments.push({
        id: `6a${n.toString(16).padStart(22, "0")}`,
        date: "2026-04-02T00:00:00.000Z",
        data: { text: `Note ${n}`, card: { id: card } },
        memberCreator: source.data.trello.members[0]!,
      });
    const staged = await preview(trello, "tb-roadmap");
    expect(staged.counts.comments).toBe(1002);
    expect(
      source.requests
        .filter((request) => request.path.includes("/actions?"))
        .map((request) => new URLSearchParams(request.path.split("?")[1]).has("before")),
    ).toEqual([false, true]);
  });

  it("imports a Plane project with Markdown text, relations, and cursor pages", async () => {
    const staged = await preview(plane(), "pp-web");
    expect(staged.issues.filter((issue) => issue.severity === "error")).toEqual([]);
    expect(staged.counts).toMatchObject({
      tickets: 3,
      workflow: 5,
      labels: 2,
      relations: 2,
      comments: 2,
    });
    warns(
      staged,
      "Not imported: estimates (1)",
      "Not imported: cycles (1)",
      "Not imported: attachments (1)",
      "Not imported: date dependencies (1)",
      "Not imported: modules (2)",
      "Not imported: additional assignees (1)",
      "Not imported: archived, draft, and intake work items.",
    );
    readOnly();
    expect(
      source.requests.some((request) => request.path.includes("/work-items/?per_page=100&cursor=")),
    ).toBe(true);
    await leaves(fakeCredentials.plane, staged);
    const finished = await run(staged);
    expect(finished).toMatchObject({ status: "completed", progress: { failed: 0 } });
    const result = await imported(finished.projectId!);
    const home = result.byTitle("Redesign the homepage"),
      footer = result.byTitle("Fix the footer"),
      copy = result.byTitle("Remove the old copy");
    expect(home).toMatchObject({
      priority: "high",
      labels: ["ui"],
      assigneeId: owner.id,
      createdBy: owner.id,
    });
    expect(home.description).toContain("New **hero** and a [brief](https://example.test/brief).");
    expect(home.description).toMatch(/^-\s+Desktop$/m);
    expect(home.startAt?.toISOString()).toBe("2026-05-01T00:00:00.000Z");
    expect(home.dueAt?.toISOString()).toBe("2026-05-31T23:59:59.999Z");
    expect(footer).toMatchObject({ parentId: home.id, priority: "urgent", kind: "bug" });
    expect(result.states.find((state) => state.id === home.stateId)?.category).toBe("in_progress");
    expect(result.states.find((state) => state.id === copy.stateId)?.category).toBe("done");
    // Relations listed on both work items are imported once; related ones have no direction.
    expect(
      result.relations.map((link) => [link.type, ...[link.sourceId, link.targetId].toSorted()]),
    ).toEqual(
      expect.arrayContaining([
        ["blocks", ...[home.id, copy.id].toSorted()],
        ["related", ...[home.id, footer.id].toSorted()],
      ]),
    );
    expect(result.relations).toHaveLength(2);
    expect(result.relations).toContainEqual(
      expect.objectContaining({ sourceId: home.id, targetId: copy.id, type: "blocks" }),
    );
    expect(result.comments.map((comment) => comment.body)).toEqual([
      "Originally by owner on 2026-04-23.\n\nFirst _pass_",
      "Originally by dev on 2026-04-24.\n\nShipped to staging",
    ]);
  });

  it("reads Plane releases before work items through their issue routes", async () => {
    source.data.plane.legacy = true;
    const staged = await preview(plane(), "pp-web");
    expect(staged.counts).toMatchObject({ tickets: 3, relations: 0, comments: 2 });
    warns(staged, "Not imported: relations.");
    expect(source.requests.some((request) => request.path.includes("/issues/pw-1/comments/"))).toBe(
      true,
    );
  });

  it("imports a PLANKA 2 board and signs out again", async () => {
    const staged = await preview(planka(), "2001");
    expect(staged.issues.filter((issue) => issue.severity === "error")).toEqual([]);
    expect(staged.counts).toMatchObject({ tickets: 3, workflow: 2, labels: 2, comments: 2 });
    warns(
      staged,
      "Not imported: deleted cards.",
      "Not imported: attachments (1)",
      "Not imported: stopwatches (1)",
    );
    readOnly();
    expect(source.requests.at(0)?.method).toBe("POST");
    expect(source.requests.at(-1)?.method).toBe("DELETE");
    // Archived cards page by the time they left their list.
    expect(
      source.requests.some((request) => request.path.startsWith("/planka/api/lists/3003/cards")),
    ).toBe(true);
    await leaves(fakeCredentials.planka.password, staged);
    await leaves(fakeCredentials.planka.session, staged);
    const finished = await run(staged);
    expect(finished).toMatchObject({ status: "completed", progress: { failed: 0 } });
    const result = await imported(finished.projectId!);
    const launch = result.byTitle("Spring launch"),
      flyer = result.byTitle("Old flyer"),
      retro = result.byTitle("Retro");
    expect(launch).toMatchObject({
      labels: ["Urgent", "lagoon-blue"],
      assigneeId: owner.id,
      createdBy: owner.id,
      description: "Launch **it**\n\n### Prep\n\n- [x] Book a venue\n- [ ] Send invites",
    });
    expect(launch.dueAt?.toISOString()).toBe("2026-03-20T10:00:00.000Z");
    // An archived card returns to the list it left.
    expect(flyer).toMatchObject({ archived: true, stateId: launch.stateId });
    expect(result.states.find((state) => state.id === retro.stateId)).toMatchObject({
      name: "Live",
      category: "done",
    });
    const labels = await domain.execute(
      "list_project_labels",
      { projectId: finished.projectId! },
      owner,
    );
    expect(Object.fromEntries(labels.map((label) => [label.name, label.color]))).toMatchObject({
      Urgent: "red",
      "lagoon-blue": "blue",
    });
    expect(result.comments.map((comment) => comment.body)).toEqual([
      "Originally by Ann Planka on 2026-02-03.\n\nStarting",
      "Originally by Bob Planka on 2026-02-04.\n\nVenue booked",
    ]);
  });

  it("reads a PLANKA 1 board with an API key and keeps only comments among card actions", async () => {
    const staged = await preview(planka("api_key"), "2002");
    expect(staged.counts).toMatchObject({ tickets: 1, workflow: 1, comments: 1 });
    expect(
      source.requests.every((request) => request.apiKey === fakeCredentials.planka.apiKey),
    ).toBe(true);
    expect(source.requests.some((request) => request.path.includes("access-tokens"))).toBe(false);
    readOnly();
    const result = await imported((await run(staged)).projectId!);
    expect(result.byTitle("Old way").description).toBe("Plain\n\n### Tasks\n\n- [ ] Check");
    expect(result.comments.map((comment) => comment.body)).toEqual([
      "Originally by Ann Planka on 2025-01-03.\n\nClassic comment",
    ]);
  });

  it("signs out of PLANKA when a read fails, and refuses a wrong password", async () => {
    // The sign-in succeeds, the board read fails.
    source.data.planka.boards = [];
    await expect(preview(planka(), "2999")).rejects.toMatchObject({
      status: 404,
      code: "not_found",
    });
    expect(source.requests.at(-1)).toMatchObject({
      method: "DELETE",
      path: "/planka/api/access-tokens/me",
    });
    source.reset();
    const wrong: ImportSource = {
      provider: "planka",
      baseUrl: source.plankaUrl,
      signIn: "password",
      username: fakeCredentials.planka.username,
      password: "not the password",
      token: "",
    };
    await expect(preview(wrong, "2001")).rejects.toMatchObject({
      status: 422,
      code: "source_rejected",
    });
    expect(source.requests).toHaveLength(1);
  });

  it("imports a Kaneo project with every task and related page, subtasks, and comments", async () => {
    const staged = await preview(kaneo(), "kp-platform");
    expect(staged.issues.filter((issue) => issue.severity === "error")).toEqual([]);
    expect(staged.counts).toMatchObject({
      tickets: 4,
      workflow: 4,
      labels: 2,
      relations: 1,
      comments: 1,
    });
    warns(
      staged,
      "Not imported: external links (1)",
      "Not imported: custom fields (1)",
      "Not imported: time entries.",
    );
    readOnly();
    const pages = source.requests
      .filter((request) => request.path.startsWith("/kaneo/api/task/tasks/"))
      .map((request) => {
        const query = new URLSearchParams(request.path.split("?")[1]);
        return `${query.get("page")}/${query.get("relatedPage")}`;
      });
    expect(pages).toEqual(["1/1", "1/2", "2/1", "2/2"]);
    await leaves(fakeCredentials.kaneo, staged);
    const finished = await run(staged);
    expect(finished).toMatchObject({ status: "completed", progress: { failed: 0 } });
    const result = await imported(finished.projectId!);
    const ci = result.byTitle("Set up CI"),
      caching = result.byTitle("Add caching"),
      vm = result.byTitle("Retire the VM"),
      search = result.byTitle("Explore search");
    expect(ci).toMatchObject({
      priority: "high",
      kind: "bug",
      labels: ["bug", "backend"],
      assigneeId: owner.id,
      description: "Run **checks**",
    });
    expect(ci.startAt?.toISOString()).toBe("2026-06-01T00:00:00.000Z");
    expect(caching).toMatchObject({ parentId: ci.id, priority: "none", assigneeId: null });
    expect(vm).toMatchObject({ archived: true, priority: "low" });
    expect(result.states.find((state) => state.id === vm.stateId)?.category).toBe("done");
    // A description too long for Kaneo's list is read on its own.
    expect(search.description).toBe("A long **description**");
    expect(result.states.find((state) => state.id === search.stateId)).toMatchObject({
      name: "Planned",
      category: "backlog",
    });
    expect(result.relations).toEqual([
      expect.objectContaining({ sourceId: ci.id, targetId: vm.id, type: "blocks" }),
    ]);
    expect(result.comments.map((comment) => comment.body)).toEqual([
      "Originally by Dev Kaneo on 2026-05-05.\n\nPipeline is green",
    ]);
  });

  it("keeps every source's credentials out of a retried preview's receipt", async () => {
    const refs: Record<string, string> = {
      trello: "tb-roadmap",
      plane: "pp-web",
      planka: "2001",
      kaneo: "kp-platform",
    };
    for (const from of [trello, plane(), planka(), kaneo()]) {
      const input = {
        workspaceId,
        key: prefix("S"),
        name: "Retried",
        visibility: "workspace" as const,
        source: from,
        sourceProject: refs[from.provider]!,
        includeComments: false,
        requestId: crypto.randomUUID(),
      };
      const first = await domain.execute("preview_source_import", input, owner);
      const reads = source.requests.length;
      expect((await domain.execute("preview_source_import", input, owner)).id).toBe(first.id);
      expect(source.requests).toHaveLength(reads);
    }
    const stored = JSON.stringify(await fixture.database.db.select().from(receipts));
    for (const secret of [
      fakeCredentials.trello.token,
      fakeCredentials.trello.apiKey,
      fakeCredentials.plane,
      fakeCredentials.planka.password,
      fakeCredentials.kaneo,
    ])
      expect(stored).not.toContain(secret);
  });

  it("writes the staged board after the source changes, and resumes without duplicates", async () => {
    let interrupted = false;
    async function execute<K extends Operation>(
      name: K,
      value: unknown,
      actor: Actor,
      provenance?: { importRun: string },
    ) {
      const result = await domain.execute(name, value, actor, provenance);
      if (name === "create_ticket" && !interrupted) {
        interrupted = true;
        throw new Error("Simulated restart");
      }
      return result;
    }
    const staged = await preview(trello, "tb-roadmap");
    // The board changes in Trello after the preview.
    source.data.trello.cards[0]!.name = "Renamed in Trello";
    source.data.trello.cards.pop();
    await domain.execute(
      "start_import",
      { workspaceId, importId: staged.id, expectedVersion: staged.version },
      owner,
    );
    const requests = source.requests.length;
    await expect(processImports({ ...domain, execute })).rejects.toThrow("Simulated restart");
    while (await processImports(domain));
    const finished = await domain.execute(
      "get_import",
      { workspaceId, importId: staged.id },
      owner,
    );
    expect(finished).toMatchObject({ status: "completed", progress: { failed: 0 } });
    const result = await imported(finished.projectId!);
    expect(result.rows.map((row) => row.title).toSorted()).toEqual([
      "Plan the launch",
      "Ship it",
      "Write the copy",
    ]);
    expect(result.comments).toHaveLength(2);
    expect(source.requests).toHaveLength(requests);
  });
});
