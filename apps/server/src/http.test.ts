import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { createClient } from "@kanvil/client";
import { z } from "zod";
import { ticketSchema, snapshotSchema } from "@kanvil/contracts";
import { createApplication } from "./app.ts";
import { createFixture } from "./test-fixture.ts";

describe("HTTP, realtime, and MCP", () => {
  let fixture: Awaited<ReturnType<typeof createFixture>>,
    application: Awaited<ReturnType<typeof createApplication>>,
    cookie: string;
  const url = (path: string) => `${fixture.config.KANVIL_URL}${path}`;
  const request = (path: string, init?: RequestInit) =>
    application.app.fetch(new Request(url(path), init));
  const sessionHeaders = () => ({
    Cookie: cookie,
    Origin: fixture.config.KANVIL_URL,
    "Content-Type": "application/json",
  });
  beforeAll(async () => {
    fixture = await createFixture();
    application = await createApplication(fixture.database, fixture.config);
    const input = {
      email: "owner@example.test",
      name: "Instance owner",
      password: "Isolated HTTP password 42!",
      token: fixture.config.KANVIL_SETUP_TOKEN,
    };
    const setup = await request("/api/v1/setup", {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: fixture.config.KANVIL_URL },
      body: JSON.stringify(input),
    });
    expect(setup.status).toBe(201);
    const login = await request("/api/auth/sign-in/email", {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: fixture.config.KANVIL_URL },
      body: JSON.stringify({ email: input.email, password: input.password }),
    });
    expect(login.status).toBe(200);
    cookie = login.headers
      .getSetCookie()
      .map((value) => value.split(";")[0])
      .join("; ");
  });
  afterAll(async () => {
    await application?.close();
    await fixture?.close();
  });
  const client = () =>
    createClient({
      baseUrl: fixture.config.KANVIL_URL,
      headers: sessionHeaders,
      fetch: async (input, init) => application.app.fetch(new Request(input, init)),
    });
  const newProject = () =>
    client().call("create_project", {
      key: `H${crypto.randomUUID().slice(0, 8).toUpperCase()}`,
      name: "HTTP project",
    });
  async function credential(projectId: string, permissions: string[] = ["read", "write", "claim"]) {
    const response = await request("/api/v1/credentials", {
      method: "POST",
      headers: sessionHeaders(),
      body: JSON.stringify({ name: "Test consumer", projectIds: [projectId], scopes: permissions }),
    });
    expect(response.status).toBe(201);
    return z.object({ id: z.string(), key: z.string() }).parse(await response.json());
  }
  it("closes setup after the first owner and rejects cross-origin writes", async () => {
    expect(
      (
        await request("/api/v1/setup", {
          method: "POST",
          headers: sessionHeaders(),
          body: JSON.stringify({
            token: fixture.config.KANVIL_SETUP_TOKEN,
            email: "other@example.test",
            name: "Other",
            password: "Isolated HTTP password 42!",
          }),
        })
      ).status,
    ).toBe(409);
    expect(
      (
        await request("/api/v1/projects", {
          method: "POST",
          headers: { ...sessionHeaders(), Origin: "https://untrusted.example.test" },
          body: JSON.stringify({ key: "BAD", name: "Blocked" }),
        })
      ).status,
    ).toBe(403);
    expect((await request("/api/v1/projects")).status).toBe(401);
  });
  it("serves typed ticket operations and schemas without permitting forged fields", async () => {
    const project = await newProject(),
      api = client();
    const created = await api.call("create_ticket", {
      projectId: project.id,
      title: "The complete title stays readable and searchable",
    });
    const listed = await api.call("list_tickets", { projectId: project.id, q: "readable" });
    expect(listed.items[0]?.id).toBe(created.id);
    expect(
      (
        await request(`/api/v1/projects/${project.id}/tickets`, {
          method: "POST",
          headers: sessionHeaders(),
          body: JSON.stringify({ title: "Forged", createdBy: "another-user" }),
        })
      ).status,
    ).toBe(400);
    const document = z
      .object({ paths: z.record(z.string(), z.unknown()) })
      .parse(await (await request("/api/openapi.json")).json());
    expect(document.paths["/api/v1/projects/{projectId}/tickets"]).toBeDefined();
  });
  it("enforces project and operation scopes on credentials and allows revocation", async () => {
    const project = await newProject(),
      other = await newProject(),
      token = await credential(project.id, ["read"]);
    const headers = { Authorization: `Bearer ${token.key}`, "Content-Type": "application/json" };
    expect((await request(`/api/v1/projects/${project.id}/tickets`, { headers })).status).toBe(200);
    expect((await request(`/api/v1/projects/${other.id}/tickets`, { headers })).status).toBe(404);
    expect(
      (
        await request(`/api/v1/projects/${project.id}/tickets`, {
          method: "POST",
          headers,
          body: JSON.stringify({ title: "Forbidden" }),
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await request("/api/auth/api-key/create", {
          method: "POST",
          headers: sessionHeaders(),
          body: "{}",
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await request(`/api/v1/credentials/${token.id}`, {
          method: "DELETE",
          headers: sessionHeaders(),
        })
      ).status,
    ).toBe(200);
    expect((await request(`/api/v1/projects/${project.id}/tickets`, { headers })).status).toBe(401);
  });
  it("replays changes from a snapshot and streams new committed changes", async () => {
    const project = await newProject();
    const snapshot = snapshotSchema.parse(
      await (
        await request(`/api/v1/snapshot?projectId=${project.id}`, { headers: sessionHeaders() })
      ).json(),
    );
    const previous = await client().call("create_ticket", {
      projectId: project.id,
      title: "Replay this change",
    });
    const controller = new AbortController();
    const response = await request(
      `/api/v1/events?projectId=${project.id}&cursor=${snapshot.cursor}`,
      { headers: sessionHeaders(), signal: controller.signal },
    );
    expect(response.status).toBe(200);
    const reader = response.body!.getReader(),
      decoder = new TextDecoder();
    async function until(value: string) {
      let received = "";
      while (!received.includes(value)) {
        const part = await reader.read();
        if (part.done) throw new Error("Stream ended before the expected event");
        received += decoder.decode(part.value, { stream: true });
      }
      return received;
    }
    try {
      expect(await until("ticket.created")).toContain(previous.id);
      const next = await client().call("create_ticket", {
        projectId: project.id,
        title: "A new committed change",
      });
      expect(await until(next.id)).toContain("ticket.created");
    } finally {
      controller.abort();
      await reader.cancel().catch(() => {});
    }
    const invalid = await request(`/api/v1/events?projectId=${project.id}&cursor=9999999999`, {
      headers: sessionHeaders(),
    });
    expect(invalid.status).toBe(410);
  });
  it("supports discovery and tool calls with the official MCP client", async () => {
    const project = await newProject(),
      token = await credential(project.id);
    const sdk = new Client({ name: "kanvil-contract-test", version: "1.0.0" });
    const transport = new StreamableHTTPClientTransport(new URL(url("/mcp")), {
      requestInit: { headers: { Authorization: `Bearer ${token.key}` } },
      fetch: async (input, init) => application.app.fetch(new Request(input, init)),
    });
    try {
      await sdk.connect(transport);
      const tools = await sdk.listTools();
      expect(tools.tools.some((tool) => tool.name === "claim_ticket")).toBe(true);
      const response = await sdk.callTool({
        name: "create_ticket",
        arguments: { projectId: project.id, title: "Created through MCP" },
      });
      expect(response.isError).not.toBe(true);
      const result = z.object({ result: ticketSchema }).parse(response.structuredContent).result;
      expect(
        (await client().call("get_ticket", { projectId: project.id, ticketId: result.id })).ticket
          .title,
      ).toBe("Created through MCP");
    } finally {
      await sdk.close();
    }
    const unauthorized = await request("/mcp", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    expect(unauthorized.status).toBe(401);
    expect(unauthorized.headers.get("www-authenticate")).toContain("resource_metadata");
    const metadataUrl = unauthorized.headers
      .get("www-authenticate")
      ?.match(/resource_metadata="([^"]+)"/)?.[1];
    expect(metadataUrl).toBeDefined();
    const metadata = await application.app.fetch(new Request(metadataUrl!));
    expect(metadata.status).toBe(200);
    const resource = z
      .object({ resource: z.url(), authorization_servers: z.array(z.url()).min(1) })
      .parse(await metadata.json());
    expect(resource.resource).toBe(url("/mcp"));
    const issuer = new URL(resource.authorization_servers[0]!);
    const discovery = await application.app.fetch(
      new Request(`${issuer.origin}/.well-known/oauth-authorization-server${issuer.pathname}`),
    );
    expect(discovery.status).toBe(200);
  });
});
