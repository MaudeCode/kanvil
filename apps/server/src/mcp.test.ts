import { afterAll, beforeAll, describe, expect, it, vi } from "vite-plus/test";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { errorSchema, isOperation, operations, parseOutput } from "@kanvil/contracts";
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
    expect(parseOutput("get_ticket", direct)).toEqual(direct);
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
    expect(created).toEqual(parseOutput("create_project_label", created));
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
