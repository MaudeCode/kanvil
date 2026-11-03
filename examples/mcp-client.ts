import { parseArgs } from "node:util";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { z } from "zod";
import type { Input, Operation } from "../packages/contracts/src/index.ts";
import { exampleConnection } from "./connection.ts";

// MCP replies leave out null and empty keys, so read only the fields that always carry a value.
const row = z.object({ id: z.string() }).loose();
const page = <T extends z.ZodType>(item: T) =>
  z.object({ items: z.array(item).default([]), total: z.number() });

export async function inspectMcpProject(options: {
  baseUrl: string;
  key: string;
  projectId: string;
  fetch?: typeof fetch;
}) {
  const client = new Client({ name: "kanvil-reference-client", version: "0.1.0" });
  async function call<K extends Operation, T extends z.ZodType>(
    name: K,
    input: Partial<Input<K>>,
    schema: T,
  ): Promise<z.output<T>> {
    const response = await client.callTool({
      name: "read_operation",
      arguments: { name, input },
    });
    if (response.isError)
      throw new Error(
        `Kanvil MCP operation ${name} failed: ${JSON.stringify(response.structuredContent ?? response.content)}`,
      );
    return schema.parse(z.object({ result: z.unknown() }).parse(response.structuredContent).result);
  }
  try {
    await client.connect(
      new StreamableHTTPClientTransport(new URL("/mcp", options.baseUrl), {
        requestInit: { headers: { Authorization: `Bearer ${options.key}` } },
        ...(options.fetch ? { fetch: options.fetch } : {}),
      }),
    );
    const [projects, tickets, eligibility] = await Promise.all([
      call("list_projects", {}, z.array(row)),
      call("list_tickets", { projectId: options.projectId, limit: 20 }, page(row)),
      call(
        "list_eligible_tickets",
        { projectId: options.projectId, limit: 20 },
        page(z.object({ ticket: row, readiness: z.object({ ready: z.boolean() }).loose() })),
      ),
    ]);
    return { projects, tickets, eligibility };
  } finally {
    await client.close();
  }
}
if (import.meta.main) {
  const { values } = parseArgs({ options: { project: { type: "string" } } });
  if (!values.project) throw new Error("Pass --project <key-or-id>.");
  console.info(
    JSON.stringify(
      await inspectMcpProject({ ...exampleConnection(), projectId: values.project }),
      null,
      2,
    ),
  );
}
