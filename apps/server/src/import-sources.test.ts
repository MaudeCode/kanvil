import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vite-plus/test";
import { asc, eq, inArray } from "drizzle-orm";
import type { ImportSource, Operation, Output } from "@kanvil/contracts";
import { createFixture } from "./test-fixture.ts";
import { createDomain, type Actor, type Domain } from "./domain.ts";
import { processImports } from "./import-operations.ts";
import { createImportSources } from "./adapters/import-sources.ts";
import { createHttpSender } from "./adapters/outbound.ts";
import { comments, importRecords, importRuns, receipts, relations, tickets } from "./schema.ts";
import { sourceOwnerEmail, startImportSources } from "./import-source-fixture.ts";

const prefix = (letter: string) =>
  `${letter}${crypto.randomUUID().replaceAll("-", "").slice(0, 8).toUpperCase()}`;
const linearToken = "lin_api_fixture_secret_0123456789";
const jiraToken = "jira-fixture-secret-0123456789";

describe("imports from Linear and Jira", () => {
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
  beforeAll(async () => {
    fixture = await createFixture();
    source = await startImportSources();
    domain = createDomain(fixture.database, {
      sources: createImportSources(createHttpSender({ allowPrivate: true }), source.linearUrl),
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
  // Every source request was a read.
  const readOnly = () => {
    expect(source.requests.length).toBeGreaterThan(0);
    for (const request of source.requests)
      if (request.path.startsWith("/linear/")) {
        expect(request.method).toBe("POST");
        expect(request.body).toMatch(/^\{"query":"query /);
        expect(request.body).not.toMatch(/mutation/i);
      } else expect(request.method).toBe("GET");
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
      { ref: "lin-team", key: "ENG", name: "Engineering" },
      { ref: "lin-team-2", key: "DES", name: "Design" },
      { ref: "lin-team-3", key: "OPS", name: "Operations" },
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
      sources: createImportSources(createHttpSender({ allowPrivate: false }), source.linearUrl),
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
});
