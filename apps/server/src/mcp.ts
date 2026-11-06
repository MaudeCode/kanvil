import { createMcpHandler, McpServer, type CallToolResult } from "@modelcontextprotocol/server";
import { requireMcpAuth } from "@better-auth/mcp";
import { z } from "zod";
import { ApiError, operations, isOperation, scopes, type Operation } from "@kanvil/contracts";
import { errorEnvelope, type Actor, type Domain } from "./domain.ts";
import type { Auth } from "./auth.ts";
import type { Config } from "./config.ts";
import { applicationVersion } from "./version.ts";
import type { createAccess } from "./access.ts";

const operationNames = Object.keys(operations).filter(isOperation);
const coreNames = operationNames.filter((name) => operations[name].mcp === "core");

// Agent protocol sent in the handshake, so it stays in English. mcp.test.ts holds it to 600
// characters and to the names of listed tools.
const instructions =
  "Ticket keys look like KAN-12, and a key's prefix or the project's linked git remote works as projectId. To work a ticket: claim_ticket, keep its status current with update_ticket, add_comment on what you did, add_evidence, then set status done and release_claim. Leave tickets with automationReady false to people. The core tools are listed. Reach every other operation with find_operation, then read_operation for reads or run_operation for writes. In replies, a missing key means null or empty; lists return summary rows unless view is full.";

// MCP lists default to summary rows, unlike HTTP. A tool's parsed input already carries the default
// its schema names, so the override has to reach what the tool and find_operation advertise.
const defaultView = "summary";
const toolInput = (name: Operation): z.ZodObject => {
  const input: z.ZodObject = operations[name].input;
  return "view" in input.shape
    ? input.safeExtend({ view: z.enum([defaultView, "full"]).default(defaultView) })
    : input;
};

// The ticket body fields an operation takes as input, which its reply need not repeat.
const echoedFields = (name: Operation) => {
  const { shape } = toolInput(name);
  const { changes } = shape;
  return ["description", "acceptanceCriteria"].filter(
    (field) => field in shape || (changes instanceof z.ZodObject && field in changes.shape),
  );
};
const isEmpty = (value: unknown) =>
  value === null || (typeof value === "object" && Object.keys(value).length === 0);
// Shrinks an operation's result for an agent: tickets lose `echoed` fields, and objects lose keys
// that say nothing. Only tickets have `acceptanceCriteria`; a project keeps its `description`.
const compact = (value: unknown, echoed: string[]): unknown => {
  if (Array.isArray(value)) return value.map((item) => compact(item, echoed));
  if (typeof value !== "object" || value === null) return value;
  const dropped = "acceptanceCriteria" in value ? echoed : [];
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !dropped.includes(key))
      .map(([key, field]) => [key, compact(field, echoed)] as const)
      .filter(([, field]) => !isEmpty(field)),
  );
};

const known = (name: string) => {
  if (!isOperation(name)) throw new ApiError(404, "not_found", `No operation is named ${name}`);
  return name;
};
// A tool's arguments reach an operation's schema with no route validator in front, and a schema may
// strip what it does not name: a misspelled filter would widen a read.
const refuseUnknownKeys = (name: Operation, input: Record<string, unknown>) => {
  const { shape } = toolInput(name);
  const unknown = Object.keys(input).filter((key) => !Object.hasOwn(shape, key));
  if (unknown.length > 0)
    throw new ApiError(
      400,
      "invalid_request",
      `${name} does not take ${unknown.join(", ")}. Valid keys: ${Object.keys(shape).join(", ") || "none"}.`,
    );
};
const summary = (name: Operation) => ({
  name,
  description: operations[name].description,
  access: operations[name].method === "GET" ? "read" : "write",
});
function findOperation({
  query = "",
  name,
}: {
  query?: string | undefined;
  name?: string | undefined;
}) {
  if (name !== undefined) {
    const operation = known(name),
      spec = operations[operation];
    return {
      ...summary(operation),
      method: spec.method,
      scope: spec.scope,
      inputSchema: z.toJSONSchema(toolInput(operation), { io: "input" }),
    };
  }
  const terms = query.toLowerCase().split(/\s+/);
  return {
    operations: operationNames
      .map(summary)
      .filter((row) =>
        terms.every((term) => `${row.name} ${row.description}`.toLowerCase().includes(term)),
      ),
  };
}

const reply = async (name: string, work: () => unknown): Promise<CallToolResult> => {
  try {
    return {
      content: [{ type: "text", text: `${name} completed.` }],
      structuredContent: { result: await work() },
    };
  } catch (error) {
    return {
      isError: true,
      content: [{ type: "text", text: JSON.stringify(errorEnvelope(error).body) }],
    };
  }
};

const runnerInput = {
  name: z.string().max(80).describe("Operation name from find_operation."),
  input: z.record(z.string(), z.unknown()).default({}).describe("The operation's input."),
};

export function createMcp(
  auth: Auth,
  domain: Domain,
  access: ReturnType<typeof createAccess>,
  config: Config,
  // Counts a write against the caller; OAuth clients are not covered by the credential limiter.
  limitWrite: (key: string) => void,
) {
  const serve = (request: Request, identity: Actor, limited = false) => {
    // Every operation call, from its own tool or a runner, passes through here.
    const execute = async (name: Operation, input: Record<string, unknown>) => {
      refuseUnknownKeys(name, input);
      if (limited && operations[name].method !== "GET") limitWrite(identity.ownerId);
      const value =
        "view" in operations[name].input.shape ? { view: defaultView, ...input } : input;
      return compact(await domain.execute(name, value, identity), echoedFields(name));
    };
    // Separate tools, so a client permission rule can allow reads without allowing deletes.
    const runner = (write: boolean) => (args: { name: string; input: Record<string, unknown> }) =>
      reply(args.name, () => {
        const name = known(args.name);
        if ((operations[name].method !== "GET") !== write)
          throw new ApiError(
            400,
            "invalid_request",
            `${name} ${write ? "only reads; use read_operation" : "writes; use run_operation"}`,
          );
        return execute(name, args.input);
      });
    return createMcpHandler(
      () => {
        const server = new McpServer(
          { name: "Kanvil", version: applicationVersion },
          { instructions },
        );
        for (const name of coreNames) {
          const spec = operations[name];
          server.registerTool(
            name,
            {
              description: spec.description,
              // Loose, because the SDK would strip an unknown key before execute can refuse it.
              inputSchema: toolInput(name).loose(),
              annotations: {
                readOnlyHint: spec.method === "GET",
                destructiveHint: false,
                idempotentHint: spec.method === "GET",
                openWorldHint: false,
              },
            },
            (input: Record<string, unknown>) => reply(name, () => execute(name, input)),
          );
        }
        server.registerTool(
          "find_operation",
          {
            description:
              "Find an operation that is not a listed tool. `query` matches names and descriptions and marks each match as read or write; `name` returns one operation with its input JSON Schema, method, and scope.",
            inputSchema: {
              query: z.string().max(200).optional(),
              name: z.string().max(80).optional(),
            },
            annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
          },
          (input) => reply("find_operation", () => findOperation(input)),
        );
        server.registerTool(
          "read_operation",
          {
            description: "Run a read operation found with find_operation.",
            inputSchema: runnerInput,
            annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
          },
          runner(false),
        );
        server.registerTool(
          "run_operation",
          {
            description: "Run a write operation found with find_operation.",
            inputSchema: runnerInput,
            annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
          },
          runner(true),
        );
        return server;
      },
      { legacy: "stateless" },
    ).fetch(request);
  };
  const oauth = requireMcpAuth(
    auth,
    async (request, claims) => {
      if (typeof claims.sub !== "string")
        throw new ApiError(401, "unauthorized", "A user subject is required");
      const granted = typeof claims.scope === "string" ? claims.scope.split(" ") : [];
      const permissions = scopes.filter((scope) => granted.includes(`kanvil:${scope}`));
      const clientId = typeof claims.client_id === "string" ? claims.client_id : "oauth";
      return serve(
        request,
        await domain.actor(claims.sub, {
          ownerId: `${claims.sub}:${clientId}`,
          scopes: permissions,
        }),
        true,
      );
    },
    { resource: `${config.KANVIL_URL}/mcp`, challengeScopes: ["kanvil:read"] },
  );
  return async (request: Request) => {
    if (request.headers.get("authorization")?.match(/^Bearer\s+kv_/i))
      return serve(request, await access.authenticate(request));
    return oauth(request);
  };
}
