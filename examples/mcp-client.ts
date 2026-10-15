import { parseArgs } from "node:util";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { z } from "zod";
import {
  operations,
  parseOutput,
  type Input,
  type Operation,
} from "../packages/contracts/src/index.ts";
import { exampleConnection } from "./connection.ts";

export async function inspectMcpProject(options: {
  baseUrl: string;
  key: string;
  projectId: string;
  fetch?: typeof fetch;
}) {
  const client = new Client({ name: "kanvil-reference-client", version: "0.1.0" });
  async function call<K extends Operation>(name: K, input: Input<K>) {
    const response = await client.callTool({
      name,
      arguments: operations[name].input.parse(input),
    });
    if (response.isError)
      throw new Error(
        `Kanvil MCP operation ${name} failed: ${JSON.stringify(response.structuredContent ?? response.content)}`,
      );
    return parseOutput(
      name,
      z.object({ result: z.unknown() }).parse(response.structuredContent).result,
    );
  }
  try {
    await client.connect(
      new StreamableHTTPClientTransport(new URL("/mcp", options.baseUrl), {
        requestInit: { headers: { Authorization: `Bearer ${options.key}` } },
        ...(options.fetch ? { fetch: options.fetch } : {}),
      }),
    );
    const [projects, tickets, eligibility] = await Promise.all([
      call("list_projects", {}),
      call("list_tickets", { projectId: options.projectId, limit: 20 }),
      call("list_eligible_tickets", { projectId: options.projectId, limit: 20 }),
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
