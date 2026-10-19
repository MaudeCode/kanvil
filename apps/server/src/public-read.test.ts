import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { createClient } from "@kanvil/client";
import { mentionLink } from "@kanvil/contracts";
import { z } from "zod";
import { createApplication } from "./app.ts";
import { createFixture } from "./test-fixture.ts";
import type { Actor } from "./domain.ts";

describe("public read-only project views", () => {
  let fixture: Awaited<ReturnType<typeof createFixture>>,
    application: Awaited<ReturnType<typeof createApplication>>,
    cookie: string,
    outsider: Actor;
  const url = (path: string) => `${fixture.config.KANVIL_URL}${path}`;
  const request = (path: string, init?: RequestInit) =>
    application.app.fetch(new Request(url(path), init));
  const anonymous = (path: string) => request(`/api/public${path}`);
  const sessionHeaders = () => ({
    Cookie: cookie,
    Origin: fixture.config.KANVIL_URL,
    "Content-Type": "application/json",
  });
  const client = () =>
    createClient({
      baseUrl: fixture.config.KANVIL_URL,
      headers: sessionHeaders,
      fetch: async (input, init) => application.app.fetch(new Request(input, init)),
    });
  beforeAll(async () => {
    fixture = await createFixture();
    application = await createApplication(fixture.database, fixture.config);
    const input = {
      email: "owner@example.test",
      name: "Instance owner",
      password: "Isolated public password 42!",
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
    const created = await fixture.auth.api.createUser({
      body: {
        name: "Outsider",
        email: "outsider@example.test",
        password: "Isolated public password 42!",
        role: "user",
      },
    });
    outsider = await application.domain.actor(created.user.id);
  });
  afterAll(async () => {
    await application?.close();
    await fixture?.close();
  });
  const newProject = (visibility: "workspace" | "private" = "private") =>
    client().call("create_project", {
      key: `P${crypto.randomUUID().slice(0, 8).toUpperCase()}`,
      name: "Published project",
      description: "Roadmap shared with readers.",
      visibility,
    });
  // Sends the toggle as raw JSON so an unsupported field reads as a status, not a client error.
  const share = async (
    project: { id: string; name: string; description: string; version: number },
    enabled: boolean,
  ) => {
    const response = await request(`/api/v1/projects/${project.id}`, {
      method: "PATCH",
      headers: sessionHeaders(),
      body: JSON.stringify({
        expectedVersion: project.version,
        name: project.name,
        description: project.description,
        publicReadEnabled: enabled,
      }),
    });
    return response;
  };
  const publicProject = z.object({ id: z.string(), name: z.string() }).loose();

  it("serves an enabled project's public projection to anonymous readers only after sharing", async () => {
    const project = await newProject(),
      api = client();
    const ticket = await api.call("create_ticket", {
      projectId: project.id,
      title: "Public requirement",
      description: "Readers see this description.",
      acceptanceCriteria: "Readers see the acceptance criteria.",
      labels: ["roadmap"],
      dueAt: "2030-01-01T23:59:59.000Z",
    });
    expect((await anonymous(`/projects/${project.id}`)).status).toBe(404);

    const shared = await share(project, true);
    expect(shared.status).toBe(200);
    expect(await shared.json()).toMatchObject({ publicReadEnabled: true });
    // Projects start private.
    expect(project.publicReadEnabled).toBe(false);

    const read = await anonymous(`/projects/${project.id}`);
    expect(read.status).toBe(200);
    expect(read.headers.get("Cache-Control")).toBe("no-store");
    const body = publicProject.parse(await read.json());
    expect(body).toMatchObject({ id: project.id, name: "Published project" });

    const list = await anonymous(`/projects/${project.id}/tickets`);
    expect(list.status).toBe(200);
    expect(await list.json()).toMatchObject({
      total: 1,
      items: [{ id: ticket.id, title: "Public requirement", labels: ["roadmap"] }],
    });
    const detail = await anonymous(`/projects/${project.id}/tickets/${ticket.key}`);
    expect(detail.status).toBe(200);
    expect(await detail.json()).toMatchObject({
      ticket: {
        id: ticket.id,
        acceptanceCriteria: "Readers see the acceptance criteria.",
        dueAt: "2030-01-01T23:59:59.000Z",
      },
    });
  });

  it("projects only published fields and relationships inside the project", async () => {
    const project = await newProject(),
      other = await newProject(),
      api = client();
    const owner = await api.call("list_members", { projectId: project.id });
    const parent = await api.call("create_ticket", { projectId: project.id, title: "Parent" });
    const ticket = await api.call("create_ticket", {
      projectId: project.id,
      title: "Leak probe",
      parentId: parent.id,
      assigneeId: owner[0]!.userId,
      holdReason: "SECRET-HOLD-REASON",
      description: `Ask ${mentionLink("Instance owner", owner[0]!.userId)} before release.`,
      labels: ["published"],
    });
    await api.call("create_workspace_label", {
      workspaceId: project.workspaceId,
      name: "SECRET-WORKSPACE-LABEL",
    });
    const sibling = await api.call("create_ticket", { projectId: project.id, title: "Sibling" });
    await api.call("add_relation", {
      projectId: project.id,
      ticketId: ticket.id,
      targetId: sibling.id,
      type: "blocks",
    });
    await api.call("add_comment", {
      projectId: project.id,
      ticketId: ticket.id,
      body: "SECRET-COMMENT-BODY",
    });
    await api.call("add_evidence", {
      projectId: project.id,
      ticketId: ticket.id,
      kind: "test",
      title: "SECRET-EVIDENCE",
      url: "https://ci.example.test/run/1",
    });
    await api.call("upload_attachment", {
      projectId: project.id,
      ticketId: ticket.id,
      name: "secret-file.txt",
      contentType: "text/plain",
      data: btoa("SECRET-BYTES"),
    });
    expect((await share(project, true)).status).toBe(200);
    const texts = await Promise.all(
      [
        `/projects/${project.id}`,
        `/projects/${project.id}/tickets`,
        `/projects/${project.id}/tickets/${ticket.id}`,
      ].map(async (path) => {
        const response = await anonymous(path);
        expect(response.status).toBe(200);
        return response.text();
      }),
    );
    for (const text of texts)
      for (const secret of [
        "owner@example.test",
        owner[0]!.userId,
        "SECRET-HOLD-REASON",
        "SECRET-COMMENT-BODY",
        "SECRET-EVIDENCE",
        "secret-file.txt",
        "SECRET-WORKSPACE-LABEL",
        "mention:",
        "assigneeId",
        "createdBy",
        "version",
        "workspaceId",
      ])
        expect(text).not.toContain(secret);
    const detail = z
      .object({
        parent: z.object({ id: z.string(), title: z.string() }).nullable(),
        relations: z.array(z.object({ sourceId: z.string(), targetId: z.string() })),
      })
      .parse(JSON.parse(texts[2]!));
    expect(detail.parent).toMatchObject({ id: parent.id, title: "Parent" });
    expect(JSON.parse(texts[2]!)).toMatchObject({
      ticket: { description: "Ask @Instance owner before release." },
    });
    expect(JSON.parse(texts[0]!)).toMatchObject({ labels: [{ name: "published" }] });
    expect(detail.relations).toMatchObject([{ sourceId: ticket.id, targetId: sibling.id }]);
    const parentDetail = await anonymous(`/projects/${project.id}/tickets/${parent.id}`);
    expect(await parentDetail.json()).toMatchObject({ children: [{ id: ticket.id }] });

    // Archiving withdraws a ticket from the list, its own page, and every reference to it.
    const current = await api.call("get_ticket", { projectId: project.id, ticketId: sibling.id });
    await api.call("update_ticket", {
      projectId: project.id,
      ticketId: sibling.id,
      expectedVersion: current.ticket.version,
      changes: { archived: true },
    });
    expect((await anonymous(`/projects/${project.id}/tickets/${sibling.key}`)).status).toBe(404);
    const listed = z
      .object({ items: z.array(z.object({ id: z.string() })) })
      .parse(await (await anonymous(`/projects/${project.id}/tickets`)).json());
    expect(listed.items.map((item) => item.id).toSorted()).toEqual(
      [parent.id, ticket.id].toSorted(),
    );
    expect(
      await (await anonymous(`/projects/${project.id}/tickets/${ticket.id}`)).json(),
    ).toMatchObject({ relations: [] });

    // A ticket of another, unshared project is not reachable through the shared project's path.
    const hidden = await api.call("create_ticket", { projectId: other.id, title: "Hidden" });
    expect((await anonymous(`/projects/${project.id}/tickets/${hidden.id}`)).status).toBe(404);
    expect((await anonymous(`/projects/${other.id}/tickets/${hidden.id}`)).status).toBe(404);
  });

  it("answers guessed and unshared identifiers alike and offers no public writes", async () => {
    const shared = await newProject(),
      unshared = await newProject("workspace");
    expect((await share(shared, true)).status).toBe(200);
    const missing = [
      `/projects/${crypto.randomUUID()}`,
      `/projects/${unshared.id}`,
      `/projects/${unshared.id}/tickets`,
      `/projects/${shared.id}/tickets/${crypto.randomUUID()}`,
      `/projects/${shared.id}/tickets/${shared.key}-999`,
    ];
    for (const path of missing) {
      const response = await anonymous(path);
      expect(response.status, path).toBe(404);
      expect(await response.json()).toMatchObject({ error: { code: "not_found" } });
    }
    // A project key is not a public address.
    expect((await anonymous(`/projects/${shared.key}`)).status).toBe(400);
    for (const method of ["POST", "PATCH", "DELETE"])
      expect(
        (
          await request(`/api/public/projects/${shared.id}/tickets`, {
            method,
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ title: "Anonymous write" }),
          })
        ).status,
      ).toBe(404);
    // Sharing grants nothing to the authenticated API without a session.
    expect((await request(`/api/v1/projects/${shared.id}`)).status).toBe(401);
    expect(
      (
        await request(`/api/v1/projects/${shared.id}/tickets`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Origin: fixture.config.KANVIL_URL },
          body: JSON.stringify({ title: "Anonymous write" }),
        })
      ).status,
    ).toBe(401);
  });

  it("revokes reads at once and never widens authenticated access", async () => {
    const project = await newProject(),
      api = client();
    const ticket = await api.call("create_ticket", {
      projectId: project.id,
      title: "Searchable public ticket",
    });
    const attachment = await api.call("upload_attachment", {
      projectId: project.id,
      ticketId: ticket.id,
      name: "notes.txt",
      contentType: "text/plain",
      data: btoa("bytes"),
    });
    const shared = await share(project, true);
    expect(shared.status).toBe(200);
    const version = z.object({ version: z.number() }).parse(await shared.json()).version;
    // A signed-in non-member gains nothing from public sharing.
    await expect(
      application.domain.execute("get_project", { projectId: project.id }, outsider),
    ).rejects.toMatchObject({ code: "not_found" });
    await expect(
      application.domain.execute(
        "list_tickets",
        { projectId: project.id, limit: 10, offset: 0 },
        outsider,
      ),
    ).rejects.toMatchObject({ code: "not_found" });
    const found = await application.domain.execute(
      "search_tickets",
      { q: "Searchable", limit: 10 },
      outsider,
    );
    expect(found.items).toEqual([]);
    expect(
      (await request(`/api/v1/projects/${project.id}/attachments/${attachment.id}/content`)).status,
    ).toBe(401);
    // Attachments are not part of the public projection, even by guessing their address.
    expect(
      (await anonymous(`/projects/${project.id}/attachments/${attachment.id}/content`)).status,
    ).toBe(404);

    const revoked = await share({ ...project, version }, false);
    expect(revoked.status).toBe(200);
    expect(await revoked.json()).toMatchObject({ publicReadEnabled: false });
    for (const path of [
      `/projects/${project.id}`,
      `/projects/${project.id}/tickets`,
      `/projects/${project.id}/tickets/${ticket.id}`,
    ])
      expect((await anonymous(path)).status, path).toBe(404);
  });

  it("keeps public reads independent of disabled members and authenticated sessions", async () => {
    const project = await newProject(),
      api = client();
    const editor = await fixture.auth.api.createUser({
      body: {
        name: "Editor",
        email: "editor@example.test",
        password: "Isolated public password 42!",
        role: "user",
      },
    });
    await api.call("set_member", {
      projectId: project.id,
      email: "editor@example.test",
      role: "writer",
    });
    const ticket = await api.call("create_ticket", {
      projectId: project.id,
      title: "Assigned to a disabled member",
      assigneeId: editor.user.id,
    });
    expect((await share(project, true)).status).toBe(200);
    await fixture.database.pool.query(`UPDATE "user" SET banned = true WHERE id = $1`, [
      editor.user.id,
    ]);
    await expect(application.domain.actor(editor.user.id)).rejects.toMatchObject({
      code: "account_disabled",
    });
    const detail = await anonymous(`/projects/${project.id}/tickets/${ticket.id}`);
    expect(detail.status).toBe(200);
    const text = await detail.text();
    expect(text).not.toContain(editor.user.id);
    expect(text).not.toContain("editor@example.test");
  });

  it("serializes concurrent visibility changes so each read sees one committed policy", async () => {
    const project = await newProject();
    const ticket = await client().call("create_ticket", {
      projectId: project.id,
      title: "Concurrent",
    });
    const [first, second] = await Promise.all([share(project, true), share(project, true)]);
    expect([first.status, second.status].toSorted((a, b) => a - b)).toEqual([200, 409]);
    const winner = z
      .object({ version: z.number() })
      .parse(await (first.status === 200 ? first : second).json());
    const [revoked, ...reads] = await Promise.all([
      share({ ...project, version: winner.version }, false),
      ...Array.from({ length: 8 }, () => anonymous(`/projects/${project.id}/tickets/${ticket.id}`)),
    ]);
    expect(revoked.status).toBe(200);
    for (const read of reads) {
      expect([200, 404]).toContain(read.status);
      const body = z.unknown().parse(await read.json());
      if (read.status === 200) expect(body).toMatchObject({ ticket: { id: ticket.id } });
      else expect(body).toMatchObject({ error: { code: "not_found" } });
    }
    expect((await anonymous(`/projects/${project.id}/tickets/${ticket.id}`)).status).toBe(404);
  });
});
