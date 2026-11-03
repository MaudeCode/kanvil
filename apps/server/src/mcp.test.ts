import { afterAll, beforeAll, describe, expect, it, vi } from "vite-plus/test";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { errorSchema, isOperation, operations } from "@kanvil/contracts";
import { z } from "zod";
import { createApplication } from "./app.ts";
import { createFixture } from "./test-fixture.ts";

const core = [
  "add_comment",
  "add_evidence",
  "claim_ticket",
  "create_ticket",
  "get_ticket",
  "list_eligible_tickets",
  "list_my_work",
  "release_claim",
  "renew_claim",
  "resolve_ticket",
  "search_tickets",
  "update_ticket",
];
const discovery = ["find_operation", "read_operation", "run_operation"];
const writeLimit = 2;

const resultOf = (response: Awaited<ReturnType<Client["callTool"]>>) => {
  expect(response.isError, JSON.stringify(response.content)).toBeFalsy();
  return z.object({ result: z.unknown() }).parse(response.structuredContent).result;
};
const errorOf = (response: Awaited<ReturnType<Client["callTool"]>>) => {
  expect(response.isError).toBe(true);
  const [content] = z.array(z.object({ text: z.string() })).parse(response.content);
  return errorSchema.parse(JSON.parse(content!.text)).error;
};

const rowsOf = (result: unknown) =>
  z.object({ items: z.array(z.record(z.string(), z.unknown())) }).parse(result).items;
// The paths of keys holding null, [], or {}, at any depth.
const emptyKeys = (value: unknown, path = "result"): string[] => {
  if (typeof value !== "object" || value === null) return [];
  return Object.entries(value).flatMap(([key, field]: [string, unknown]) => {
    const empty = field === null || (typeof field === "object" && Object.keys(field).length === 0);
    return empty && !Array.isArray(value) ? [`${path}.${key}`] : emptyKeys(field, `${path}.${key}`);
  });
};

const run = (client: Client, tool: string, name: string, input: Record<string, unknown>) =>
  client.callTool({ name: tool, arguments: { name, input } });

describe("MCP tool list", () => {
  let fixture: Awaited<ReturnType<typeof createFixture>>,
    application: Awaited<ReturnType<typeof createApplication>>,
    owner: Awaited<ReturnType<typeof application.domain.actor>>,
    project: Awaited<ReturnType<typeof application.domain.execute<"create_project">>>,
    agent: Client,
    reader: Client;
  const connections: Client[] = [];

  const connect = async (token: string) => {
    const client = new Client({ name: "kanvil-mcp-test", version: "1.0.0" });
    await client.connect(
      new StreamableHTTPClientTransport(new URL("/mcp", fixture.config.KANVIL_URL), {
        requestInit: { headers: { Authorization: `Bearer ${token}` } },
        fetch: async (input, init) => application.app.fetch(new Request(input, init)),
      }),
    );
    connections.push(client);
    return client;
  };
  const keyFor = async (permissions: string[]) =>
    (
      await fixture.auth.api.createApiKey({
        body: {
          userId: owner.id,
          name: "MCP test",
          metadata: { projectIds: [project.id] },
          permissions: { kanvil: permissions },
          expiresIn: 3600,
          rateLimitEnabled: false,
        },
      })
    ).key;
  beforeAll(async () => {
    fixture = await createFixture();
    application = await createApplication(fixture.database, {
      ...fixture.config,
      KANVIL_SESSION_WRITE_LIMIT: writeLimit,
    });
    // An OAuth token is verified against the issuer's published keys, which this application serves.
    vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) =>
      application.app.fetch(new Request(input, init)),
    );
    const created = await fixture.auth.api.createUser({
      body: {
        name: "MCP owner",
        email: `${crypto.randomUUID()}@example.test`,
        password: "Isolated MCP password 42!",
        role: "user",
      },
    });
    owner = await application.domain.actor(created.user.id);
    project = await application.domain.execute(
      "create_project",
      { key: `M${crypto.randomUUID().slice(0, 8).toUpperCase()}`, name: "MCP project" },
      owner,
    );
    agent = await connect(await keyFor(["read", "write", "claim", "admin"]));
    reader = await connect(await keyFor(["read"]));
  });
  afterAll(async () => {
    await Promise.all(connections.map((client) => client.close()));
    vi.unstubAllGlobals();
    await application?.close();
    await fixture?.close();
  });

  it("lists only the core and discovery tools, without output schemas, in a bounded size", async () => {
    const { tools } = await agent.listTools();
    expect(tools.map((tool) => tool.name).toSorted()).toEqual([...core, ...discovery].toSorted());
    expect(tools.filter((tool) => tool.outputSchema).map((tool) => tool.name)).toEqual([]);
    expect(JSON.stringify(tools).length).toBeLessThan(25_000);
    const annotations = new Map(tools.map((tool) => [tool.name, tool.annotations]));
    expect(annotations.get("find_operation")).toMatchObject({ readOnlyHint: true });
    expect(annotations.get("read_operation")).toMatchObject({
      readOnlyHint: true,
      idempotentHint: true,
    });
    expect(annotations.get("run_operation")).toMatchObject({
      readOnlyHint: false,
      destructiveHint: true,
    });
  });

  it("claims a named ticket in one tool call by its keys", async () => {
    const created = await application.domain.execute(
      "create_ticket",
      {
        projectId: project.id,
        title: "One-call claim",
        description: "Claim without a lookup.",
        acceptanceCriteria: "The claim returns the ticket.",
        difficulty: "low",
        automationReady: true,
      },
      owner,
    );
    const claimed = resultOf(
      await agent.callTool({
        name: "claim_ticket",
        arguments: { projectId: project.key, ticketId: created.key, workerId: "mcp-worker" },
      }),
    );
    expect(claimed).toMatchObject({
      ticketId: created.id,
      ticket: {
        status: "in_progress",
        claimRequired: true,
        version: created.version + 1,
        description: created.description,
        acceptanceCriteria: created.acceptanceCriteria,
      },
    });
  });

  it("tells agents how to work a ticket and names only listed tools", async () => {
    const { tools } = await agent.listTools();
    const instructions = agent.getInstructions() ?? "";
    expect(instructions.length).toBeGreaterThan(0);
    expect(instructions.length).toBeLessThanOrEqual(600);
    const mentioned = instructions.match(/\b[a-z]+(?:_[a-z]+)+\b/g) ?? [];
    expect(mentioned).toEqual(expect.arrayContaining(discovery));
    expect(tools.map((tool) => tool.name)).toEqual(expect.arrayContaining(mentioned));
  });

  it("reads through read_operation with the result of a direct call, and refuses writes", async () => {
    const ticket = await application.domain.execute(
      "create_ticket",
      { projectId: project.id, title: "Read through discovery" },
      owner,
    );
    expect(
      resultOf(
        await run(agent, "read_operation", "list_workflow_states", { projectId: project.id }),
      ),
    ).toEqual(
      await application.domain.execute("list_workflow_states", { projectId: project.id }, owner),
    );
    const subject = { projectId: project.id, ticketId: ticket.id };
    const direct = resultOf(await agent.callTool({ name: "get_ticket", arguments: subject }));
    expect(resultOf(await run(agent, "read_operation", "get_ticket", subject))).toEqual(direct);

    const write = { projectId: project.id, name: "Not created" };
    expect(
      errorOf(await run(agent, "read_operation", "create_project_label", write)),
    ).toMatchObject({
      status: 400,
      code: "invalid_request",
      message: expect.stringContaining("run_operation"),
    });
    expect(
      await application.domain.execute("list_project_labels", { projectId: project.id }, owner),
    ).toEqual([]);
  });

  it("writes through run_operation with the checks of a direct call, and refuses reads", async () => {
    const created = resultOf(
      await run(agent, "run_operation", "create_project_label", {
        projectId: project.id,
        name: "Discovered",
      }),
    );
    expect(created).toMatchObject({ name: "Discovered" });
    expect(
      await application.domain.execute("list_project_labels", { projectId: project.id }, owner),
    ).toMatchObject([{ name: "Discovered" }]);

    const input = { projectId: project.id, title: "Denied without write scope" };
    const denied = errorOf(await run(reader, "run_operation", "create_ticket", input));
    expect(denied).toMatchObject({ status: 403, code: "insufficient_scope" });
    expect(denied).toEqual(
      errorOf(await reader.callTool({ name: "create_ticket", arguments: input })),
    );
    expect(
      errorOf(await run(agent, "run_operation", "list_workflow_states", { projectId: project.id })),
    ).toMatchObject({
      status: 400,
      code: "invalid_request",
      message: expect.stringContaining("read_operation"),
    });
  });

  it("answers an unknown name with not_found in every discovery tool", async () => {
    // `constructor` exists on every object, so a plain property lookup would find it.
    for (const name of ["no_such_operation", "constructor"]) {
      for (const response of [
        await run(agent, "read_operation", name, {}),
        await run(agent, "run_operation", name, {}),
        await agent.callTool({ name: "find_operation", arguments: { name } }),
      ])
        expect(errorOf(response)).toMatchObject({ status: 404, code: "not_found" });
    }
  });

  it("describes every operation through find_operation", async () => {
    const found = z
      .object({ operations: z.array(z.object({ name: z.string(), access: z.string() })) })
      .parse(
        resultOf(
          await agent.callTool({ name: "find_operation", arguments: { query: "WORKFLOW state" } }),
        ),
      );
    expect(found.operations).toContainEqual(
      expect.objectContaining({ name: "list_workflow_states", access: "read" }),
    );
    expect(found.operations).toContainEqual(
      expect.objectContaining({ name: "create_workflow_state", access: "write" }),
    );
    expect(found.operations.map((row) => row.name)).not.toContain("get_ticket");

    for (const name of Object.keys(operations).filter(isOperation)) {
      const spec = operations[name];
      expect(
        resultOf(await agent.callTool({ name: "find_operation", arguments: { name } })),
        name,
      ).toMatchObject({
        name,
        description: spec.description,
        method: spec.method,
        scope: spec.scope,
        access: spec.method === "GET" ? "read" : "write",
        inputSchema: { type: "object" },
      });
    }
  });

  it("answers lists with summary rows unless asked for full ones, and leaves HTTP's default alone", async () => {
    const title = `Summary ${crypto.randomUUID()}`;
    await application.domain.execute(
      "create_ticket",
      { projectId: project.id, title, description: "Body", acceptanceCriteria: "Criteria" },
      owner,
    );
    const listInput = { projectId: project.id, q: title };
    const read = (view: object) => ({
      list: run(agent, "read_operation", "list_tickets", { ...listInput, ...view }),
      search: agent.callTool({ name: "search_tickets", arguments: { q: title, ...view } }),
      runnerSearch: run(agent, "read_operation", "search_tickets", { q: title, ...view }),
    });
    const summaries = read({}),
      full = read({ view: "full" });

    const [summaryRow] = rowsOf(resultOf(await summaries.list));
    expect(summaryRow).toMatchObject({ title });
    expect(summaryRow).not.toHaveProperty("description");
    expect(rowsOf(resultOf(await full.list))).toMatchObject([
      { title, description: "Body", acceptanceCriteria: "Criteria" },
    ]);
    for (const summary of [await summaries.search, await summaries.runnerSearch]) {
      const [row] = rowsOf(resultOf(summary));
      expect(row?.ticket).toMatchObject({ title });
      expect(row?.ticket).not.toHaveProperty("description");
    }
    for (const whole of [await full.search, await full.runnerSearch])
      expect(rowsOf(resultOf(whole))).toMatchObject([
        { ticket: { title, description: "Body", acceptanceCriteria: "Criteria" } },
      ]);
    // search_workspace's summary row is the only one of its views with `number`.
    expect(
      rowsOf(resultOf(await run(agent, "read_operation", "search_workspace", { q: title }))),
    ).toMatchObject([{ ticket: { title, number: expect.any(Number) } }]);

    // What a client reads about the default matches what the server does.
    const { tools } = await agent.listTools();
    expect(
      tools.find((tool) => tool.name === "search_tickets")?.inputSchema.properties?.view,
    ).toMatchObject({ default: "summary" });
    expect(
      resultOf(
        await agent.callTool({ name: "find_operation", arguments: { name: "list_tickets" } }),
      ),
    ).toMatchObject({ inputSchema: { properties: { view: { default: "summary" } } } });

    const response = await application.app.fetch(
      new Request(`${fixture.config.KANVIL_URL}/api/v1/projects/${project.id}/tickets?q=${title}`, {
        headers: { Authorization: `Bearer ${await keyFor(["read"])}` },
      }),
    );
    expect(rowsOf(await response.json())).toMatchObject([
      { title, description: "Body", acceptanceCriteria: "Criteria", assigneeId: null },
    ]);
  });

  it("leaves out the ticket bodies of a tool that takes them, and only those", async () => {
    const body = { description: "Sent body", acceptanceCriteria: "Sent criteria" };
    const created = z
      .object({ id: z.string(), version: z.number() })
      .loose()
      .parse(
        resultOf(
          await agent.callTool({
            name: "create_ticket",
            arguments: {
              projectId: project.id,
              title: "Echoless",
              labels: ["echo"],
              scopes: ["server"],
              holdReason: "Held",
              ...body,
            },
          }),
        ),
      );
    expect(created).toMatchObject({
      key: expect.any(String),
      projectId: project.id,
      version: 1,
      labels: ["echo"],
      scopes: ["server"],
      automationReady: false,
      holdReason: "Held",
    });
    expect(created).not.toHaveProperty("description");
    expect(created).not.toHaveProperty("acceptanceCriteria");

    const subject = { projectId: project.id, ticketId: created.id };
    const updated = resultOf(
      await agent.callTool({
        name: "update_ticket",
        arguments: { ...subject, expectedVersion: 1, changes: { priority: "high" } },
      }),
    );
    expect(updated).toMatchObject({ priority: "high", version: 2 });
    expect(updated).not.toHaveProperty("description");
    // Nested in an array, through a runner.
    const [bulk] = z.array(z.unknown()).parse(
      resultOf(
        await run(agent, "run_operation", "bulk_update_tickets", {
          projectId: project.id,
          tickets: [{ ticketId: created.id, expectedVersion: 2 }],
          changes: { priority: "low" },
        }),
      ),
    );
    expect(bulk).toMatchObject({ priority: "low", version: 3 });
    expect(bulk).not.toHaveProperty("acceptanceCriteria");

    // Nothing the caller sent: the body stays, on tickets from reads and from other writes.
    const expected = { ticket: body };
    expect(
      resultOf(await agent.callTool({ name: "get_ticket", arguments: subject })),
    ).toMatchObject(expected);
    expect(resultOf(await run(agent, "read_operation", "get_ticket", subject))).toMatchObject(
      expected,
    );
    expect(resultOf(await run(agent, "run_operation", "duplicate_ticket", subject))).toMatchObject(
      body,
    );
    // A project's description is not a ticket body, though update_project takes it.
    expect(
      resultOf(
        await run(agent, "run_operation", "update_project", {
          projectId: project.id,
          expectedVersion: project.version,
          name: project.name,
          description: "Project text",
        }),
      ),
    ).toMatchObject({ description: "Project text" });
  });

  it("drops null and empty keys from operation results, and keeps false, 0, and empty strings", async () => {
    const { id } = await application.domain.execute(
      "create_ticket",
      { projectId: project.id, title: "Sparse" },
      owner,
    );
    const subject = { projectId: project.id, ticketId: id };
    const replies = [
      await agent.callTool({ name: "get_ticket", arguments: subject }),
      await run(agent, "read_operation", "get_ticket", subject),
      await run(agent, "read_operation", "list_tickets", {
        projectId: project.id,
        view: "full",
      }),
    ].map(resultOf);
    for (const reply of replies) expect(emptyKeys(reply)).toEqual([]);
    const { ticket } = z.object({ ticket: z.record(z.string(), z.unknown()) }).parse(replies[0]);
    expect(ticket).toMatchObject({ archived: false, description: "", acceptanceCriteria: "" });
    expect(ticket).not.toHaveProperty("assigneeId");
    expect(replies[0]).not.toHaveProperty("claim");

    // An empty page keeps its count, and a write through the runner follows the same rule.
    expect(
      resultOf(
        await run(agent, "read_operation", "list_tickets", {
          projectId: project.id,
          q: crypto.randomUUID(),
        }),
      ),
    ).toEqual({ total: 0 });
    expect(
      emptyKeys(resultOf(await run(agent, "run_operation", "duplicate_ticket", subject))),
    ).toEqual([]);

    // An input schema is not a result: a default of null or [] is what a caller needs to read.
    expect(
      resultOf(
        await agent.callTool({ name: "find_operation", arguments: { name: "create_ticket" } }),
      ),
    ).toMatchObject({
      inputSchema: { properties: { assigneeId: { default: null }, labels: { default: [] } } },
    });
  });

  it("counts OAuth writes through run_operation, but not reads or refusals", async () => {
    const { baseURL } = await fixture.auth.$context;
    const { token } = await fixture.auth.api.signJWT({
      body: {
        payload: {
          sub: owner.id,
          aud: `${fixture.config.KANVIL_URL}/mcp`,
          iss: baseURL,
          client_id: "mcp-test-client",
          scope: "kanvil:read kanvil:write",
          exp: Math.floor(Date.now() / 1000) + 300,
        },
      },
    });
    const oauth = await connect(token);
    const write = () =>
      run(oauth, "run_operation", "add_relation", {
        projectId: project.id,
        ticketId: "not-a-ticket",
        targetId: "not-a-ticket",
        type: "related",
      });
    for (let attempt = 0; attempt < 3; attempt += 1) {
      resultOf(await run(oauth, "read_operation", "list_projects", {}));
      expect(errorOf(await run(oauth, "run_operation", "no_such_operation", {})).code).toBe(
        "not_found",
      );
      expect(errorOf(await run(oauth, "run_operation", "list_projects", {})).code).toBe(
        "invalid_request",
      );
    }
    for (let attempt = 0; attempt < writeLimit; attempt += 1)
      expect(errorOf(await write()).code).toBe("not_found");
    expect(errorOf(await write())).toMatchObject({ status: 429, code: "rate_limited" });
  });
});
