import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vite-plus/test";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { createClient } from "@kanvil/client";
import { z } from "zod";
import {
  attachmentLimit,
  attachmentPath,
  ticketSchema,
  timeEntrySchema,
  snapshotSchema,
  type ChangeEvent,
} from "@kanvil/contracts";
import { createApplication } from "./app.ts";
import { createFixture } from "./test-fixture.ts";
import { startImportSources } from "./import-source-fixture.ts";

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
    await application.close();
  });
  // Keep process-local state, including request budgets, isolated between unrelated cases.
  beforeEach(async () => {
    application = await createApplication(fixture.database, fixture.config);
  });
  afterEach(async () => {
    await application?.close();
  });
  afterAll(async () => {
    await fixture?.close();
  });
  const client = (key?: string) =>
    createClient({
      baseUrl: fixture.config.KANVIL_URL,
      headers: key ? () => ({ Authorization: `Bearer ${key}` }) : sessionHeaders,
      fetch: async (input, init) => application.app.fetch(new Request(input, init)),
    });
  const listedProjects = async (query = "") =>
    z
      .array(z.object({ id: z.string() }))
      .parse(
        await (await request(`/api/v1/projects${query}`, { headers: sessionHeaders() })).json(),
      )
      .map((row) => row.id);
  const newProject = () =>
    client().call("create_project", {
      key: `H${crypto.randomUUID().slice(0, 8).toUpperCase()}`,
      name: "HTTP project",
    });
  async function credential(
    projectId: string | null,
    permissions: string[] = ["read", "write", "claim"],
  ) {
    const response = await request("/api/v1/credentials", {
      method: "POST",
      headers: sessionHeaders(),
      body: JSON.stringify({
        name: "Test consumer",
        projectIds: projectId === null ? null : [projectId],
        scopes: permissions,
      }),
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
  it("duplicates a ticket over HTTP and refuses read-only credentials", async () => {
    const project = await newProject();
    const original = await client().call("create_ticket", {
      projectId: project.id,
      title: "Copied over HTTP",
    });
    const path = `/api/v1/projects/${project.id}/tickets/${original.key}/duplicate`;
    const response = await request(path, { method: "POST", headers: sessionHeaders(), body: "{}" });
    expect(response.status).toBe(200);
    expect(ticketSchema.parse(await response.json())).toMatchObject({
      title: "Copied over HTTP (copy)",
      key: `${project.key}-2`,
    });
    const token = await credential(project.id, ["read"]);
    expect(
      (
        await request(path, {
          method: "POST",
          headers: { Authorization: `Bearer ${token.key}`, "Content-Type": "application/json" },
          body: "{}",
        })
      ).status,
    ).toBe(403);
  });
  it("moves a ticket next to a neighbor and lists the manual order over HTTP", async () => {
    const project = await newProject(),
      api = client(),
      [first, second, third] = [
        await api.call("create_ticket", { projectId: project.id, title: "First" }),
        await api.call("create_ticket", { projectId: project.id, title: "Second" }),
        await api.call("create_ticket", { projectId: project.id, title: "Third" }),
      ];
    const moved = await request(`/api/v1/projects/${project.id}/tickets/${third.key}/move`, {
      method: "POST",
      headers: sessionHeaders(),
      body: JSON.stringify({ expectedVersion: third.version, before: first.id }),
    });
    expect(moved.status).toBe(200);
    expect(ticketSchema.parse(await moved.json()).version).toBe(third.version + 1);
    const listed = await request(`/api/v1/projects/${project.id}/tickets?sort=manual`, {
      headers: sessionHeaders(),
    });
    expect(listed.status).toBe(200);
    expect(
      z
        .object({ items: z.array(z.object({ key: z.string() })) })
        .parse(await listed.json())
        .items.map((item) => item.key),
    ).toEqual([third.key, first.key, second.key]);
  });
  it("defines typed custom fields and validates, stores, and filters ticket values over HTTP", async () => {
    const project = await newProject();
    const post = (path: string, body: unknown) =>
      request(`/api/v1/projects/${project.id}${path}`, {
        method: "POST",
        headers: sessionHeaders(),
        body: JSON.stringify(body),
      });
    const defined = await post("/custom-fields", {
      name: "Severity",
      type: "select",
      options: [{ name: "High" }, { name: "Low" }],
      required: true,
    });
    expect(defined.status).toBe(200);
    const field = z
      .object({ id: z.string(), options: z.array(z.object({ id: z.string() })) })
      .parse(await defined.json());
    const [high, low] = field.options;
    const missing = await post("/tickets", { title: "No severity" });
    expect(missing.status).toBe(400);
    expect(await missing.json()).toMatchObject({
      error: { code: "validation_error", details: [{ path: `customFields.${field.id}` }] },
    });
    expect(
      (await post("/tickets", { title: "Wrong type", customFields: { [field.id]: 3 } })).status,
    ).toBe(400);
    const created = await post("/tickets", {
      title: "Severe",
      customFields: { [field.id]: high?.id },
    });
    expect(created.status).toBe(200);
    const ticket = ticketSchema.parse(await created.json());
    expect(ticket.customFields).toEqual({ [field.id]: high?.id });
    const matching = async (option: string | undefined) =>
      z
        .object({ items: z.array(ticketSchema) })
        .parse(
          await (
            await request(
              `/api/v1/projects/${project.id}/tickets?customField=${field.id}:${option}`,
              { headers: sessionHeaders() },
            )
          ).json(),
        )
        .items.map((item) => item.id);
    expect(await matching(high?.id)).toEqual([ticket.id]);
    expect(await matching(low?.id)).toEqual([]);
  });
  it("moves a ticket to another project over HTTP while old keys, prefixes, and files resolve", async () => {
    const [source, destination] = [await newProject(), await newProject()],
      api = client(),
      ticket = await api.call("create_ticket", { projectId: source.id, title: "Relocated" }),
      uploaded = await api.call("upload_attachment", {
        projectId: source.id,
        ticketId: ticket.id,
        name: "diagram.bin",
        data: Buffer.from([1, 2, 3]).toString("base64"),
      }),
      embedded = `/api/v1/projects/${source.id}/attachments/${uploaded.id}/content`,
      bound = await credential(source.id);
    const moved = await request(`/api/v1/projects/${source.key}/tickets/${ticket.key}/relocate`, {
      method: "POST",
      headers: sessionHeaders(),
      body: JSON.stringify({
        expectedVersion: ticket.version,
        destinationProjectId: destination.id,
      }),
    });
    expect(moved.status).toBe(200);
    const relocated = ticketSchema.parse(await moved.json());
    expect(relocated).toMatchObject({ id: ticket.id, key: `${destination.key}-1` });
    // A file embedded in the description before the move still loads from its old address.
    const content = await request(embedded, { headers: sessionHeaders() });
    expect(content.status).toBe(200);
    expect(Buffer.from(await content.arrayBuffer())).toEqual(Buffer.from([1, 2, 3]));
    const resolved = await request(`/api/v1/tickets/resolve?ticketId=${ticket.key}`, {
      headers: sessionHeaders(),
    });
    expect(resolved.status).toBe(200);
    expect(await resolved.json()).toMatchObject({
      ticket: { id: ticket.id, key: relocated.key },
      project: { id: destination.id },
    });
    // A key bound to the source neither follows the ticket nor its file.
    const asBound = { Authorization: `Bearer ${bound.key}` };
    expect(
      (await request(`/api/v1/tickets/resolve?ticketId=${ticket.key}`, { headers: asBound }))
        .status,
    ).toBe(404);
    expect((await request(embedded, { headers: asBound })).status).toBe(404);
    const renamed = await api.call("update_project", {
      projectId: destination.id,
      expectedVersion: destination.version,
      name: destination.name,
      description: destination.description,
      key: `R${destination.key.slice(1)}`,
    });
    const byOldPrefix = await request(
      `/api/v1/projects/${destination.key}/tickets/${relocated.key}`,
      { headers: sessionHeaders() },
    );
    expect(byOldPrefix.status).toBe(200);
    expect(await byOldPrefix.json()).toMatchObject({
      ticket: { id: ticket.id, key: `${renamed.key}-1` },
    });
  });
  it("evaluates repeated filter parameters over HTTP", async () => {
    const project = await newProject(),
      api = client(),
      token = `h${crypto.randomUUID().slice(0, 8)}`;
    for (const status of ["todo", "in_progress", "done"] as const)
      await api.call("create_ticket", {
        projectId: project.id,
        title: `${token} ${status}`,
        status,
      });
    const total = async (query: string) => {
      const response = await request(`/api/v1/projects/${project.id}/tickets?${query}`, {
        headers: sessionHeaders(),
      });
      return response.ok
        ? z.object({ total: z.number() }).parse(await response.json()).total
        : response.status;
    };
    expect(await total("status=todo&status=in_progress")).toBe(2);
    expect(await total("status=todo")).toBe(1);
    expect(await total("statusNot=done")).toBe(2);
    expect(await total("status=todo&statusNot=todo")).toBe(400);
    expect(
      (await api.call("list_tickets", { projectId: project.id, status: ["todo", "done"] })).total,
    ).toBe(2);
  });
  it("serves workspace search over HTTP with the shared filters", async () => {
    const project = await newProject(),
      api = client(),
      token = `w${crypto.randomUUID().slice(0, 8)}`;
    for (const status of ["todo", "in_progress", "done"] as const)
      await api.call("create_ticket", {
        projectId: project.id,
        title: `${token} ${status}`,
        status,
      });
    const search = await request(
      `/api/v1/search?q=${token}&workspaceId=${project.workspaceId}&statusNot=done`,
      { headers: sessionHeaders() },
    );
    expect(search.status).toBe(200);
    expect(
      z
        .object({ total: z.number(), counts: z.record(z.string(), z.number()) })
        .parse(await search.json()),
    ).toMatchObject({ total: 2, counts: { ticket: 2 } });
    expect((await api.call("search_workspace", { q: token, type: "ticket" })).total).toBe(3);
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
  it("lets global credentials follow current account access while keeping machine and scope gates", async () => {
    const person = await fixture.auth.api.createUser({
      body: {
        name: "Global consumer",
        email: "global@example.test",
        password: "Global test password 42!",
        role: "user",
      },
    });
    const login = await request("/api/auth/sign-in/email", {
      method: "POST",
      headers: sessionHeaders(),
      body: JSON.stringify({ email: person.user.email, password: "Global test password 42!" }),
    });
    const personHeaders = {
      ...sessionHeaders(),
      Cookie: login.headers
        .getSetCookie()
        .map((value) => value.split(";")[0])
        .join("; "),
    };
    const create = async (permissions: string[]) => {
      const response = await request("/api/v1/credentials", {
        method: "POST",
        headers: personHeaders,
        body: JSON.stringify({ name: "Global consumer", projectIds: null, scopes: permissions }),
      });
      expect(response.status).toBe(201);
      return z.object({ id: z.string(), key: z.string() }).parse(await response.json());
    };
    // No projects exist for this account when its global keys are created.
    const token = await create(["read", "write"]),
      readOnly = await create(["read"]),
      administrator = await create(["admin"]);
    const machine = (key: string) =>
      createClient({
        baseUrl: fixture.config.KANVIL_URL,
        headers: () => ({ Authorization: `Bearer ${key}` }),
        fetch: async (input, init) => application.app.fetch(new Request(input, init)),
      });
    const api = machine(token.key),
      project = await newProject();
    expect(await api.call("list_projects", {})).toEqual([]);
    await expect(api.call("get_project", { projectId: project.id })).rejects.toMatchObject({
      status: 404,
    });
    await client().call("set_member", {
      projectId: project.id,
      email: person.user.email,
      role: "reader",
    });
    expect((await api.call("get_project", { projectId: project.id })).id).toBe(project.id);
    await expect(
      api.call("create_ticket", { projectId: project.id, title: "Role denied" }),
    ).rejects.toMatchObject({ status: 403 });
    await client().call("set_member", {
      projectId: project.id,
      email: person.user.email,
      role: "writer",
    });
    await api.call("create_ticket", { projectId: project.id, title: "Allowed after grant" });
    await expect(
      machine(readOnly.key).call("create_ticket", { projectId: project.id, title: "Scope denied" }),
    ).rejects.toMatchObject({ status: 403 });
    expect(
      (await request("/api/v1/credentials", { headers: { Authorization: `Bearer ${token.key}` } }))
        .status,
    ).toBe(403);
    await expect(api.call("get_account_impact", { userId: person.user.id })).rejects.toMatchObject({
      code: "session_required",
    });
    await client().call("set_member", {
      projectId: project.id,
      email: person.user.email,
      role: null,
    });
    expect(await api.call("list_projects", {})).toEqual([]);
    await expect(api.call("get_project", { projectId: project.id })).rejects.toMatchObject({
      status: 404,
    });
    const space = await api.call("create_workspace", {
      name: "Global workspace",
      slug: `global-${crypto.randomUUID()}`,
    });
    const future = await api.call("create_project", {
      workspaceId: space.id,
      key: "GLBL",
      name: "Future global project",
    });
    const update = {
      workspaceId: space.id,
      expectedVersion: space.version,
      name: "Updated global workspace",
      description: space.description,
    };
    await expect(api.call("update_workspace", update)).rejects.toMatchObject({ status: 403 });
    expect((await machine(administrator.key).call("update_workspace", update)).name).toBe(
      update.name,
    );
    expect((await api.call("list_projects", {})).map((row) => row.id)).toEqual([future.id]);
    await expect(
      machine(readOnly.key).call("create_project", {
        workspaceId: space.id,
        key: "NOPE",
        name: "Scope denied",
      }),
    ).rejects.toMatchObject({ status: 403 });
    await request(`/api/v1/credentials/${token.id}`, { method: "DELETE", headers: personHeaders });
    await expect(api.call("list_projects", {})).rejects.toMatchObject({ status: 401 });
    await fixture.database.pool.query('UPDATE "user" SET banned = true WHERE id = $1', [
      person.user.id,
    ]);
    await expect(machine(readOnly.key).call("list_projects", {})).rejects.toMatchObject({
      code: "account_disabled",
    });
  });
  it("applies deployment claim lease caps through HTTP clients and MCP", async () => {
    const api = client(),
      project = await newProject();
    const token = await credential(project.id, ["read", "claim"]);
    const claimApi = client(token.key);
    for (const maximum of [86400, 172800, 60]) {
      if (maximum !== 86400) {
        await application.close();
        application = await createApplication(fixture.database, {
          ...fixture.config,
          KANVIL_CLAIM_MAX_LEASE_SECONDS: maximum,
        });
      }
      const ticket = await api.call("create_ticket", {
        projectId: project.id,
        title: "Lease cap",
        description: "Exercise runtime claim policy",
        acceptanceCriteria: "Both transports honor the configured cap",
        difficulty: "med",
        automationReady: true,
      });
      const input = { projectId: project.id, ticketId: ticket.id };
      await expect(
        claimApi.call("claim_ticket", {
          ...input,
          expectedVersion: 1,
          workerId: "http-worker",
          leaseSeconds: maximum + 1,
        }),
      ).rejects.toMatchObject({ code: "validation_error" });
      const claim = await claimApi.call("claim_ticket", {
        ...input,
        expectedVersion: 1,
        workerId: "http-worker",
        leaseSeconds: maximum,
      });
      const sdk = new Client({ name: "claim-cap-test", version: "1.0.0" });
      const transport = new StreamableHTTPClientTransport(new URL(url("/mcp")), {
        requestInit: { headers: { Authorization: `Bearer ${token.key}` } },
        fetch: async (requestInput, init) => application.app.fetch(new Request(requestInput, init)),
      });
      try {
        await sdk.connect(transport);
        const args = { ...input, claimId: claim.id };
        expect(
          (
            await sdk.callTool({
              name: "renew_claim",
              arguments: { ...args, leaseSeconds: maximum + 1 },
            })
          ).isError,
        ).toBe(true);
        const renewed = await sdk.callTool({
          name: "renew_claim",
          arguments: { ...args, leaseSeconds: maximum },
        });
        expect(renewed.isError).not.toBe(true);
        expect(renewed.structuredContent).toMatchObject({ result: { id: claim.id } });
      } finally {
        await sdk.close();
      }
    }
  });
  it("lets administrators cancel a revoked worker's live claim and fence its old claim ID", async () => {
    const api = client(),
      project = await newProject();
    const token = await credential(project.id),
      worker = client(token.key);
    const ticket = await api.call("create_ticket", {
      projectId: project.id,
      title: "Revoked worker",
      description: "Recover stopped ownership after credential revocation",
      acceptanceCriteria: "A live lease cannot strand the project after revocation",
      difficulty: "med",
      automationReady: true,
    });
    const input = { projectId: project.id, ticketId: ticket.id };
    const claim = await worker.call("claim_ticket", {
      ...input,
      expectedVersion: 1,
      workerId: "revoked-worker",
      leaseSeconds: 86400,
    });
    expect(
      (
        await request(`/api/v1/credentials/${token.id}`, {
          method: "DELETE",
          headers: sessionHeaders(),
        })
      ).status,
    ).toBe(200);
    await expect(worker.call("renew_claim", { ...input, claimId: claim.id })).rejects.toMatchObject(
      { status: 401 },
    );
    const recover = {
      claimId: claim.id,
      reason: "Revoked credential and confirmed the worker stopped",
      confirmedStopped: true as const,
    };
    await expect(api.call("recover_claim", { ...input, ...recover })).rejects.toMatchObject({
      code: "claim_not_expired",
    });
    const cancellation = await request(
      `/api/v1/projects/${project.id}/tickets/${ticket.id}/claim/recover`,
      {
        method: "POST",
        headers: sessionHeaders(),
        body: JSON.stringify({
          ...recover,
          cancelActive: true,
          reschedule: true,
          expectedVersion: 2,
        }),
      },
    );
    expect(cancellation.status, await cancellation.clone().text()).toBe(200);
    expect(await cancellation.json()).toEqual({ ok: true });
    const recovered = await api.call("get_ticket", input);
    expect(recovered.claim).toBeNull();
    expect(recovered.ticket).toMatchObject({ status: "todo", version: 3 });
    expect((await api.call("get_project_impact", { projectId: project.id })).blockers).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "claim_conflict" })]),
    );
    expect((await api.call("list_activity", input)).items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "claim.recovered",
          data: expect.objectContaining({
            claimId: claim.id,
            cancelActive: true,
            confirmedStopped: true,
          }),
        }),
      ]),
    );
    const replacementToken = await credential(project.id),
      replacementWorker = client(replacementToken.key);
    const replacement = await replacementWorker.call("claim_ticket", {
      ...input,
      expectedVersion: 3,
      workerId: "replacement",
    });
    expect(replacement.id).not.toBe(claim.id);
    await expect(
      replacementWorker.call("update_ticket", {
        ...input,
        expectedVersion: 4,
        claimId: claim.id,
        changes: { title: "Stale ownership" },
      }),
    ).rejects.toMatchObject({ code: "claim_conflict" });
  });
  it.each([false, true])(
    "disables API-key rate limits for existing and new keys across HTTP and MCP, global=%s",
    async (global) => {
      const project = await newProject(),
        existing = await credential(global ? null : project.id);
      const read = (key: string) =>
        request("/api/v1/projects", { headers: { Authorization: `Bearer ${key}` } });
      const limit = async (id: string) => {
        await fixture.database.pool.query(
          "UPDATE apikey SET rate_limit_max = 1, request_count = 0 WHERE id = $1",
          [id],
        );
      };
      await limit(existing.id);
      expect((await read(existing.key)).status).toBe(200);
      expect((await read(existing.key)).status).toBe(401);

      await application.close();
      application = await createApplication(fixture.database, {
        ...fixture.config,
        KANVIL_API_KEY_RATE_LIMIT_ENABLED: false,
      });
      const created = await credential(global ? null : project.id);
      await limit(created.id);
      for (const token of [existing, created]) {
        expect((await read(token.key)).status).toBe(200);
        expect((await read(token.key)).status).toBe(200);
        const sdk = new Client({ name: "unlimited-key-test", version: "1.0.0" });
        const transport = new StreamableHTTPClientTransport(new URL(url("/mcp")), {
          requestInit: { headers: { Authorization: `Bearer ${token.key}` } },
          fetch: async (input, init) => application.app.fetch(new Request(input, init)),
        });
        try {
          await sdk.connect(transport);
          const result = await sdk.callTool({ name: "list_projects", arguments: {} });
          expect(result.isError).not.toBe(true);
        } finally {
          await sdk.close();
        }
      }
      await request(`/api/v1/credentials/${existing.id}`, {
        method: "DELETE",
        headers: sessionHeaders(),
      });
      expect((await read(existing.key)).status).toBe(401);

      await application.close();
      application = await createApplication(fixture.database, fixture.config);
      expect((await read(created.key)).status).toBe(200);
      expect((await read(created.key)).status).toBe(401);
    },
  );
  it("never treats missing or malformed credential project metadata as global access", async () => {
    const project = await newProject(),
      token = await credential(project.id);
    for (const metadata of [
      null,
      "not-json",
      {},
      { projectIds: "all" },
      { projectIds: ["invalid"] },
    ]) {
      await fixture.database.pool.query("UPDATE apikey SET metadata = $1 WHERE id = $2", [
        metadata === null ? null : JSON.stringify(metadata),
        token.id,
      ]);
      const response = await request(`/api/v1/projects/${project.id}/tickets`, {
        headers: { Authorization: `Bearer ${token.key}` },
      });
      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({ error: { code: "invalid_credential_scope" } });
    }
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
  it.each([false, true])(
    "counts an SSE connection once while rechecking credential revocation for every batch, global=%s",
    async (global) => {
      const project = await newProject(),
        token = await credential(global ? null : project.id, ["read"]);
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
        await client().call("create_ticket", {
          projectId: project.id,
          title: "Wake revoked stream",
        });
        expect(await readSseUntil(reader, '"status":401')).toContain("unauthorized");
      } finally {
        controller.abort();
        await reader.cancel().catch(() => {});
      }
    },
  );
  it.each([false, true])(
    "supports discovery and tool calls with the official MCP client, global=%s",
    async (global) => {
      const project = await newProject(),
        token = await credential(global ? null : project.id);
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
          "list_workspace_labels",
          "create_workspace_label",
          "update_workspace_label",
          "delete_workspace_label",
          "update_ticket_labels",
          "archive_project",
          "get_project_impact",
          "transfer_project",
          "delete_project",
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
        // Relabeling one ticket is label administration: a write credential cannot, a session can.
        const labeled = await client().call("create_ticket", {
          projectId: project.id,
          title: "Relabeled over HTTP",
          labels: ["before"],
        });
        const deniedRelabel = await sdk.callTool({
          name: "update_ticket_labels",
          arguments: {
            projectId: project.id,
            ticketId: labeled.id,
            expectedVersion: labeled.version,
            labels: ["denied"],
          },
        });
        expect(deniedRelabel.isError).toBe(true);
        expect(
          await client().call("update_ticket_labels", {
            projectId: project.id,
            ticketId: labeled.id,
            expectedVersion: labeled.version,
            labels: ["after"],
          }),
        ).toMatchObject({ labels: ["after"], version: labeled.version + 1 });
        const spaces = await sdk.callTool({ name: "list_workspaces", arguments: {} });
        const discovered = z
          .object({ result: z.array(z.object({ id: z.string(), role: z.string().nullable() })) })
          .parse(spaces.structuredContent);
        if (global)
          expect(discovered.result).toContainEqual({ id: project.workspaceId, role: "admin" });
        else expect(discovered.result).toEqual([{ id: project.workspaceId, role: null }]);
        const forbidden = await sdk.callTool({
          name: "list_workspace_members",
          arguments: { workspaceId: project.workspaceId },
        });
        expect(forbidden.isError ?? false).toBe(!global);

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
    },
  );
  it("serves editable ticket links over HTTP and MCP with versions and URL validation", async () => {
    const project = await newProject(),
      ticket = await client().call("create_ticket", { projectId: project.id, title: "Linked" });
    const base = `/api/v1/projects/${project.id}`;
    const send = (method: string, path: string, body?: unknown) =>
      request(`${base}${path}`, {
        method,
        headers: sessionHeaders(),
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    const created = await send("POST", `/tickets/${ticket.id}/resources`, {
      url: "https://gitlab.com/group/project/-/merge_requests/7",
      title: "Merge request",
    });
    expect(created.status).toBe(200);
    const resource = z
      .object({ id: z.uuid(), provider: z.string().nullable(), remoteState: z.null() })
      .parse(await created.json());
    expect(resource.provider).toBe("GitLab");
    expect(
      (await send("POST", `/tickets/${ticket.id}/resources`, { url: "javascript:alert(1)" }))
        .status,
    ).toBe(400);
    expect(
      (await send("PATCH", `/resources/${resource.id}`, { expectedVersion: 1, title: "Renamed" }))
        .status,
    ).toBe(200);
    const stale = await send("PATCH", `/resources/${resource.id}`, {
      expectedVersion: 1,
      title: "Stale",
    });
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({ error: { code: "version_conflict" } });

    const token = await credential(project.id, ["read"]);
    const sdk = new Client({ name: "kanvil-resource-test", version: "1.0.0" });
    await sdk.connect(
      new StreamableHTTPClientTransport(new URL(url("/mcp")), {
        requestInit: { headers: { Authorization: `Bearer ${token.key}` } },
        fetch: async (input, init) => application.app.fetch(new Request(input, init)),
      }),
    );
    try {
      const listed = await sdk.callTool({
        name: "list_resources",
        arguments: { projectId: project.id, ticketId: ticket.key },
      });
      expect(listed.structuredContent).toMatchObject({
        result: [{ id: resource.id, title: "Renamed", version: 2 }],
      });
      const denied = await sdk.callTool({
        name: "delete_resource",
        arguments: { projectId: project.id, resourceId: resource.id, expectedVersion: 2 },
      });
      expect(denied.isError).toBe(true);
    } finally {
      await sdk.close();
    }
    expect((await send("DELETE", `/resources/${resource.id}`, { expectedVersion: 2 })).status).toBe(
      200,
    );
    expect(
      await client().call("list_resources", { projectId: project.id, ticketId: ticket.id }),
    ).toEqual([]);
  });
  it("records observed time ranges through the ticket HTTP API", async () => {
    const project = await newProject(),
      ticket = await client().call("create_ticket", {
        projectId: project.id,
        title: "Observed work",
      });
    const response = await request(
      `/api/v1/projects/${project.id}/tickets/${ticket.id}/time-entries`,
      {
        method: "POST",
        headers: sessionHeaders(),
        body: JSON.stringify({
          startAt: "2026-10-01T09:00:00.000Z",
          endAt: "2026-10-01T09:01:30.250Z",
        }),
      },
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      ticketId: ticket.id,
      version: 1,
      durationMs: 90_250,
      startAt: "2026-10-01T09:00:00.000Z",
      endAt: "2026-10-01T09:01:30.250Z",
    });
    let interrupted = false;
    const api = createClient({
      baseUrl: fixture.config.KANVIL_URL,
      headers: sessionHeaders,
      fetch: async (input, init) => {
        const result = await application.app.fetch(new Request(input, init));
        if (!interrupted && init?.method === "POST") {
          interrupted = true;
          throw new TypeError("Lost response after commit");
        }
        return result;
      },
    });
    const subject = { projectId: project.id, ticketId: ticket.id };
    const running = await api.call("create_time_entry", {
      ...subject,
      startAt: "2026-10-01T10:00:00.000Z",
    });
    expect(running).toMatchObject({ endAt: null, durationMs: null, version: 1 });
    expect((await api.call("list_time_entries", subject)).total).toBe(2);
    const ended = await api.call("update_time_entry", {
      ...subject,
      timeEntryId: running.id,
      expectedVersion: 1,
      endAt: "2026-10-01T10:00:20.000Z",
    });
    expect(ended.durationMs).toBe(20_000);
    const token = await credential(project.id);
    const sdk = new Client({ name: "kanvil-time-entry-test", version: "1.0.0" });
    await sdk.connect(
      new StreamableHTTPClientTransport(new URL(url("/mcp")), {
        requestInit: { headers: { Authorization: `Bearer ${token.key}` } },
        fetch: async (input, init) => application.app.fetch(new Request(input, init)),
      }),
    );
    try {
      const tools = await sdk.listTools();
      expect(tools.tools.map((tool) => tool.name)).toEqual(
        expect.arrayContaining([
          "create_time_entry",
          "get_time_entry",
          "list_time_entries",
          "update_time_entry",
          "delete_time_entry",
        ]),
      );
      const created = z.object({ result: timeEntrySchema }).parse(
        (
          await sdk.callTool({
            name: "create_time_entry",
            arguments: { ...subject, startAt: "2026-10-01T11:00:00.000Z" },
          })
        ).structuredContent,
      ).result;
      expect(created.durationMs).toBeNull();
      expect(
        (
          await sdk.callTool({
            name: "update_time_entry",
            arguments: {
              ...subject,
              timeEntryId: created.id,
              expectedVersion: 1,
              endAt: "2026-10-01T11:00:30.000Z",
            },
          })
        ).structuredContent,
      ).toMatchObject({
        result: { id: created.id, version: 2, durationMs: 30_000, actorId: created.actorId },
      });
      expect(
        (
          await sdk.callTool({
            name: "get_time_entry",
            arguments: { ...subject, timeEntryId: created.id },
          })
        ).structuredContent,
      ).toMatchObject({ result: { version: 2, durationMs: 30_000 } });
      expect(
        (await sdk.callTool({ name: "list_time_entries", arguments: subject })).structuredContent,
      ).toMatchObject({ result: { total: 3 } });
      expect(
        (
          await sdk.callTool({
            name: "delete_time_entry",
            arguments: { ...subject, timeEntryId: created.id, expectedVersion: 2 },
          })
        ).structuredContent,
      ).toEqual({ result: { ok: true } });
    } finally {
      await sdk.close();
    }
    const readToken = await credential(project.id, ["read"]);
    expect(
      (
        await request(`/api/v1/projects/${project.id}/tickets/${ticket.id}/time-entries`, {
          method: "POST",
          headers: { Authorization: `Bearer ${readToken.key}`, "Content-Type": "application/json" },
          body: JSON.stringify({ startAt: "2026-10-01T12:00:00.000Z" }),
        })
      ).status,
    ).toBe(403);
    await api.call("delete_time_entry", {
      ...subject,
      timeEntryId: running.id,
      expectedVersion: 2,
    });
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
    for (const projectId of [project.id, null]) {
      const token = await credential(projectId, ["read"]);
      const download = await request(path, { headers: { Authorization: `Bearer ${token.key}` } });
      expect(download.status).toBe(200);
      expect(Buffer.from(await download.arrayBuffer())).toEqual(bytes);
    }
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
  it("serves a staged upload only to its uploader at the address it keeps once claimed", async () => {
    const project = await newProject(),
      api = client(),
      bytes = Buffer.from("staged inline image");
    const stage = () =>
      api.call("stage_upload", {
        projectId: project.id,
        name: "inline.png",
        contentType: "image/png",
        data: bytes.toString("base64"),
      });
    const [kept, dropped] = [await stage(), await stage()];
    const path = (id: string) => attachmentPath(project.id, id);
    expect((await request(path(kept.id))).status).toBe(401);
    const staged = await request(path(kept.id), { headers: sessionHeaders() });
    expect(staged.status).toBe(200);
    expect(Buffer.from(await staged.arrayBuffer())).toEqual(bytes);
    const ticket = await api.call("create_ticket", {
      projectId: project.id,
      title: "Composed with an inline image",
      uploads: [kept.id],
    });
    expect(
      await api.call("list_attachments", { projectId: project.id, ticketId: ticket.id }),
    ).toMatchObject([{ id: kept.id, name: "inline.png" }]);
    expect((await request(path(kept.id), { headers: sessionHeaders() })).status).toBe(200);
    await api.call("discard_upload", { projectId: project.id, uploadId: dropped.id });
    expect((await request(path(dropped.id), { headers: sessionHeaders() })).status).toBe(404);
  });
  it("archives, restores, previews, and deletes a project through HTTP", async () => {
    const project = await newProject();
    const send = (method: string, path: string, body?: unknown) =>
      request(`/api/v1/projects/${project.id}${path}`, {
        method,
        headers: sessionHeaders(),
        ...(body ? { body: JSON.stringify(body) } : {}),
      });

    const archived = await send("POST", "/archive", {
      expectedVersion: project.version,
      archived: true,
    });
    expect(archived.status).toBe(200);
    const { version } = z.object({ version: z.number() }).parse(await archived.json());
    expect(await listedProjects()).not.toContain(project.id);
    expect(await listedProjects("?archived=only")).toContain(project.id);
    const blocked = await send("POST", "/tickets", { title: "Not while archived" });
    expect(blocked.status).toBe(409);
    expect(await blocked.json()).toMatchObject({ error: { code: "project_archived" } });
    expect(
      (await send("POST", "/archive", { expectedVersion: version, archived: false })).status,
    ).toBe(200);
    expect(await listedProjects()).toContain(project.id);
    const impact = await send("GET", "/impact");
    expect(impact.status).toBe(200);
    expect(await impact.json()).toMatchObject({ tickets: 0, blockers: [], transfer: null });
    const current = z.object({ version: z.number() }).parse(await (await send("GET", "")).json());
    expect(
      (await send("DELETE", "", { expectedVersion: current.version, confirmKey: project.key }))
        .status,
    ).toBe(200);
    expect((await send("GET", "")).status).toBe(404);
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
    expect(await human.notificationPreferences().queryFn()).toMatchObject({
      inApp: true,
      push: false,
    });
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
      expect(await human.setNotificationPreferences({ inApp: false })).toMatchObject({
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
  it("marks Inbox entries unread and dismisses them while keeping their event", async () => {
    const project = await newProject(),
      human = client();
    const ticket = await human.call("create_ticket", {
      projectId: project.id,
      title: "Inbox management",
    });
    await human.call("set_subscription", {
      projectId: project.id,
      ticketId: ticket.id,
      enabled: true,
    });
    const issued = await credential(project.id);
    const machine = createClient({
      baseUrl: fixture.config.KANVIL_URL,
      headers: () => ({ Authorization: `Bearer ${issued.key}` }),
      fetch: async (input, init) => application.app.fetch(new Request(input, init)),
    });
    for (const body of ["First update", "Second update"])
      await machine.call("add_comment", { projectId: project.id, ticketId: ticket.id, body });
    const inbox = async () =>
      (await human.notifications().queryFn()).filter((row) => row.event.ticketId === ticket.id);
    const [second, first] = await inbox();
    if (!first || !second) throw new Error("Both updates should reach the Inbox");
    await human.markNotifications({ ids: [first.id, second.id] });
    expect((await inbox()).every((row) => row.readAt)).toBe(true);
    await human.markNotifications({ ids: [first.id], read: false });
    expect((await inbox()).map((row) => [row.id, row.readAt === null])).toEqual([
      [second.id, false],
      [first.id, true],
    ]);
    const asMachine = (path: string) =>
      request(path, {
        method: "POST",
        headers: { Authorization: `Bearer ${issued.key}`, "Content-Type": "application/json" },
        body: JSON.stringify({ ids: [second.id] }),
      });
    expect((await asMachine("/api/v1/notifications/dismiss")).status).toBe(403);
    await human.dismissNotifications({ ids: [second.id] });
    expect((await inbox()).map((row) => row.id)).toEqual([first.id]);
    const stored = await fixture.database.pool.query<{ event_id: string; dismissed: boolean }>(
      "SELECT event_id, dismissed_at IS NOT NULL AS dismissed FROM notifications WHERE id = $1",
      [second.id],
    );
    expect(stored.rows).toEqual([{ event_id: second.event.id, dismissed: true }]);
  });
  it("reads Linear for an import over HTTP without returning the credentials", async () => {
    const source = await startImportSources(),
      token = "lin_api_http_fixture_secret",
      linear = { provider: "linear", token };
    const sourced = await createApplication(fixture.database, {
      ...fixture.config,
      KANVIL_LINEAR_API_URL: source.linearUrl,
      KANVIL_DELIVERY_ALLOW_PRIVATE: true,
    });
    try {
      const { workspaceId } = await newProject();
      const call = (path: string, body: unknown) =>
        sourced.app.fetch(
          new Request(url(path), {
            method: "POST",
            headers: sessionHeaders(),
            body: JSON.stringify(body),
          }),
        );
      const listed = await call(`/api/v1/workspaces/${workspaceId}/import-sources/projects`, {
        source: linear,
      });
      expect(listed.status).toBe(200);
      const teams = await listed.text();
      expect(z.array(z.object({ key: z.string() })).parse(JSON.parse(teams))[0]?.key).toBe("ENG");
      expect(teams).not.toContain(token);
      const staged = await call(`/api/v1/workspaces/${workspaceId}/imports/source`, {
        key: "LINHTTP",
        name: "From Linear",
        source: linear,
        sourceProject: "lin-team",
        includeComments: false,
      });
      expect(staged.status).toBe(200);
      const run = await staged.text();
      expect(JSON.parse(run)).toMatchObject({ status: "previewed", counts: { tickets: 3 } });
      expect(run).not.toContain(token);
      expect(source.requests.every((sent) => sent.authorization === token)).toBe(true);
      const document = z
        .object({ paths: z.record(z.string(), z.unknown()) })
        .parse(await (await request("/api/openapi.json")).json());
      expect(document.paths["/api/v1/workspaces/{workspaceId}/imports/source"]).toBeDefined();
    } finally {
      await sourced.close();
      await source.close();
    }
  });
});
