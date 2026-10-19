import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { createClient } from "@kanvil/client";
import { z } from "zod";
import { attachmentLimit, ticketSchema, snapshotSchema, type ChangeEvent } from "@kanvil/contracts";
import { createApplication } from "./app.ts";
import { createFixture } from "./test-fixture.ts";

async function readSseUntil(reader: ReadableStreamDefaultReader<Uint8Array>, value: string) {
  let received = "";
  const decoder = new TextDecoder();
  while (!received.includes(value)) {
    const part = await reader.read();
    if (part.done) throw new Error("Stream ended before the expected event");
    received += decoder.decode(part.value, { stream: true });
    if (!received.includes(value) && /event:\s*error/.test(received)) throw new Error(received);
  }
  return received;
}

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
    expect(await api.call("list_ticket_labels", { projectId: project.id })).toEqual([]);
    const dependency = await api.call("create_ticket", {
      projectId: project.id,
      title: "Prerequisite",
      labels: ["backend"],
    });
    expect(await api.call("list_ticket_labels", { projectId: project.id })).toEqual([
      { name: "backend", count: 1 },
    ]);
    const relation = await api.call("add_relation", {
      projectId: project.id,
      ticketId: created.id,
      targetId: dependency.id,
      type: "blocks",
      direction: "incoming",
    });
    expect(relation.sourceId).toBe(dependency.id);
    expect(relation.targetId).toBe(created.id);
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
    const work = await request(`/api/v1/my-work?workspaceId=${project.workspaceId}&activity=5`, {
      headers: sessionHeaders(),
    });
    expect(work.status).toBe(200);
    expect(z.object({ total: z.number() }).parse(await work.json()).total).toBe(0);
    expect(document.paths["/api/v1/my-work"]).toBeDefined();
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
    const reader = response.body!.getReader();
    try {
      expect(await readSseUntil(reader, "ticket.created")).toContain(previous.id);
      const next = await client().call("create_ticket", {
        projectId: project.id,
        title: "A new committed change",
      });
      expect(await readSseUntil(reader, next.id)).toContain("ticket.created");
    } finally {
      controller.abort();
      await reader.cancel().catch(() => {});
    }
    const invalid = await request(`/api/v1/events?projectId=${project.id}&cursor=9999999999`, {
      headers: sessionHeaders(),
    });
    expect(invalid.status).toBe(410);
  });
  it("counts an SSE connection once while rechecking credential revocation for every batch", async () => {
    const project = await newProject(),
      token = await credential(project.id, ["read"]);
    await fixture.database.pool.query(
      "UPDATE apikey SET rate_limit_max = 1, request_count = 0 WHERE id = $1",
      [token.id],
    );
    const controller = new AbortController();
    const response = await request(`/api/v1/events?projectId=${project.id}`, {
      headers: { Authorization: `Bearer ${token.key}` },
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(3000)]),
    });
    expect(response.status).toBe(200);
    const reader = response.body!.getReader();
    try {
      await readSseUntil(reader, "checkpoint");
      const ticket = await client().call("create_ticket", {
        projectId: project.id,
        title: "Rate-limited streaming",
      });
      await readSseUntil(reader, ticket.id);
      expect(
        (
          await fixture.database.pool.query("SELECT request_count FROM apikey WHERE id = $1", [
            token.id,
          ])
        ).rows[0]?.request_count,
      ).toBe(1);
      await request(`/api/v1/credentials/${token.id}`, {
        method: "DELETE",
        headers: sessionHeaders(),
      });
      await client().call("create_ticket", { projectId: project.id, title: "Wake revoked stream" });
      expect(await readSseUntil(reader, '"status":401')).toContain("unauthorized");
    } finally {
      controller.abort();
      await reader.cancel().catch(() => {});
    }
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
      for (const name of [
        "list_project_labels",
        "create_project_label",
        "update_project_label",
        "delete_project_label",
      ])
        expect(tools.tools.some((tool) => tool.name === name)).toBe(true);
      const managedLabel = await client().call("create_project_label", {
        projectId: project.id,
        name: "MCP label",
        color: "blue",
      });
      const catalog = await sdk.callTool({
        name: "list_project_labels",
        arguments: { projectId: project.id },
      });
      expect(catalog.structuredContent).toMatchObject({
        result: [{ id: managedLabel.id, name: "MCP label", color: "blue", count: 0 }],
      });
      const deniedLabel = await sdk.callTool({
        name: "create_project_label",
        arguments: { projectId: project.id, name: "Requires admin" },
      });
      expect(deniedLabel.isError).toBe(true);
      const spaces = await sdk.callTool({ name: "list_workspaces", arguments: {} });
      const discovered = z
        .object({ result: z.array(z.object({ id: z.string(), role: z.null() })) })
        .parse(spaces.structuredContent);
      expect(discovered.result.map((workspace) => workspace.id)).toEqual([project.workspaceId]);
      const forbidden = await sdk.callTool({
        name: "list_workspace_members",
        arguments: { workspaceId: project.workspaceId },
      });
      expect(forbidden.isError).toBe(true);

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
  it("keeps binary content transactional and protects downloads and deletion", async () => {
    const project = await newProject(),
      api = client();
    const ticket = await api.call("create_ticket", {
      projectId: project.id,
      title: "Binary evidence",
    });
    const bytes = Buffer.from([0, 1, 2, 13, 10, 128, 255]);
    const input = {
      projectId: project.id,
      ticketId: ticket.id,
      name: "../../résumé.bin",
      data: bytes.toString("base64"),
    };
    const uploaded = await api.call("upload_attachment", input);
    const path = `/api/v1/projects/${project.id}/attachments/${uploaded.id}/content`;
    expect((await request(path)).status).toBe(401);
    const content = await request(path, { headers: sessionHeaders() });
    expect(content.status).toBe(200);
    expect(Buffer.from(await content.arrayBuffer())).toEqual(bytes);
    expect(content.headers.get("content-disposition")).toContain("attachment;");
    await expect(
      api.call("upload_attachment", { ...input, data: "not base64!" }),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      api.call("upload_attachment", {
        ...input,
        data: Buffer.alloc(attachmentLimit + 1).toString("base64"),
      }),
    ).rejects.toMatchObject({ status: 400 });
    await api.call("delete_attachment", { projectId: project.id, attachmentId: uploaded.id });
    expect((await request(path, { headers: sessionHeaders() })).status).toBe(404);
    expect(
      (
        await fixture.database.pool.query("SELECT id FROM attachment_content WHERE id = $1", [
          uploaded.id,
        ])
      ).rowCount,
    ).toBe(0);
  });
  it("retries a lost write response without creating duplicate work", async () => {
    const project = await newProject();
    let loseResponse = true;
    const api = createClient({
      baseUrl: fixture.config.KANVIL_URL,
      headers: sessionHeaders,
      fetch: async (input, init) => {
        const response = await application.app.fetch(new Request(input, init));
        if (loseResponse) {
          loseResponse = false;
          throw new TypeError("Connection lost after commit");
        }
        return response;
      },
    });
    await api.call("create_ticket", {
      projectId: project.id,
      title: "One ticket after a lost response",
    });
    expect((await client().call("list_tickets", { projectId: project.id })).total).toBe(1);
  });
  it("does not retry custom credential creation after losing its committed response", async () => {
    const project = await newProject();
    let attempts = 0;
    const api = createClient({
      baseUrl: fixture.config.KANVIL_URL,
      headers: sessionHeaders,
      fetch: async (input, init) => {
        attempts++;
        await application.app.fetch(new Request(input, init));
        throw new TypeError("Connection lost after credential creation");
      },
    });
    const name = `Lost response ${crypto.randomUUID()}`;
    await expect(
      api.request("/api/v1/credentials", z.unknown(), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, projectIds: [project.id], scopes: ["read"], expiresIn: 3600 }),
      }),
    ).rejects.toThrow("Connection lost");
    expect(attempts).toBe(1);
    expect(
      (await fixture.database.pool.query("SELECT id FROM apikey WHERE name = $1", [name])).rowCount,
    ).toBe(1);
  });
  it("keeps a finite credential default and creates a key without expiry only when asked", async () => {
    const project = await newProject();
    const create = async (expiry: { expiresIn?: number | null }) => {
      const response = await request("/api/v1/credentials", {
        method: "POST",
        headers: sessionHeaders(),
        body: JSON.stringify({
          name: "Expiry consumer",
          projectIds: [project.id],
          scopes: ["read"],
          ...expiry,
        }),
      });
      expect(response.status).toBe(201);
      return z.object({ expiresAt: z.string().nullable() }).parse(await response.json());
    };
    const fallback = await create({});
    expect(fallback.expiresAt).not.toBeNull();
    expect(Number(new Date(fallback.expiresAt ?? 0)) - Date.now()).toBeGreaterThan(89 * 86400000);
    expect((await create({ expiresIn: null })).expiresAt).toBeNull();
  });
  it("provides an abortable parsed event consumer with processed checkpoints", async () => {
    const project = await newProject(),
      controller = new AbortController();
    let opened: (() => void) | undefined, receive: ((event: ChangeEvent) => void) | undefined;
    const connected = new Promise<void>((resolve) => {
      opened = resolve;
    });
    const received = new Promise<ChangeEvent>((resolve) => {
      receive = resolve;
    });
    const cursors: string[] = [];
    const consumer = client().subscribe({
      projectId: project.id,
      signal: controller.signal,
      onCursor: (cursor) => {
        cursors.push(cursor);
        opened?.();
      },
      onEvent: (event) => {
        if (event.type === "ticket.created") receive?.(event);
      },
    });
    try {
      await connected;
      const ticket = await client().call("create_ticket", {
        projectId: project.id,
        title: "SDK event delivery",
      });
      expect((await received).ticketId).toBe(ticket.id);
    } finally {
      controller.abort();
      await consumer;
    }
    expect(cursors.length).toBeGreaterThan(0);
  });
  it("notifies credential owners, records provenance, and respects account preferences", async () => {
    const project = await newProject(),
      human = client();
    const ticket = await human.call("create_ticket", {
      projectId: project.id,
      title: "Agent inbox context",
    });
    await human.call("set_subscription", {
      projectId: project.id,
      ticketId: ticket.id,
      enabled: true,
    });
    const before = await request("/api/v1/notifications", { headers: sessionHeaders() });
    const ids = z
      .array(z.object({ id: z.string() }))
      .parse(await before.json())
      .map((row) => row.id);
    await human.call("add_comment", {
      projectId: project.id,
      ticketId: ticket.id,
      body: "My own browser edit",
    });
    const issued = await credential(project.id);
    // Instance administrators retain project access without an explicit membership.
    await fixture.database.pool.query("DELETE FROM project_members WHERE project_id = $1", [
      project.id,
    ]);
    const machine = createClient({
      baseUrl: fixture.config.KANVIL_URL,
      headers: () => ({ Authorization: `Bearer ${issued.key}` }),
      fetch: async (input, init) => application.app.fetch(new Request(input, init)),
    });
    await machine.call("add_comment", {
      projectId: project.id,
      ticketId: ticket.id,
      body: "Agent progress",
    });
    const inbox = await request("/api/v1/notifications", { headers: sessionHeaders() });
    const added = z
      .array(
        z.object({ id: z.string(), event: z.object({ data: z.record(z.string(), z.unknown()) }) }),
      )
      .parse(await inbox.json())
      .filter((row) => !ids.includes(row.id));
    expect(added).toHaveLength(1);
    expect(added[0]?.event.data).toMatchObject({
      key: ticket.key,
      title: ticket.title,
      source: { kind: "credential", id: issued.id },
    });
    expect(await human.notificationPreferences().queryFn()).toEqual({ inApp: true, push: false });
    await expect(machine.setNotificationPreferences({ inApp: false })).rejects.toMatchObject({
      status: 403,
    });
    expect(
      (
        await request("/api/v1/notifications/read", {
          method: "POST",
          headers: { Authorization: `Bearer ${issued.key}`, "Content-Type": "application/json" },
          body: JSON.stringify({ ids: added.map((row) => row.id) }),
        })
      ).status,
    ).toBe(403);
    try {
      expect(await human.setNotificationPreferences({ inApp: false })).toEqual({
        inApp: false,
        push: false,
      });
      await machine.call("add_comment", {
        projectId: project.id,
        ticketId: ticket.id,
        body: "Muted progress",
      });
      const muted = await request("/api/v1/notifications", { headers: sessionHeaders() });
      expect(z.array(z.unknown()).parse(await muted.json())).toHaveLength(ids.length + 1);
    } finally {
      await human.setNotificationPreferences({ inApp: true });
    }
  });
});
