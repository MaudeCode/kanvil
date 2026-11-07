import { afterAll, beforeAll, describe, expect, it, vi } from "vite-plus/test";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import type { Workspace } from "@kanvil/contracts";
import { z } from "zod";
import { createApplication } from "./app.ts";
import { requireRow, type Actor } from "./domain.ts";
import { createFixture } from "./test-fixture.ts";

const resultOf = (response: Awaited<ReturnType<Client["callTool"]>>) => {
  expect(response.isError, JSON.stringify(response.content)).toBeFalsy();
  return z.object({ result: z.unknown() }).parse(response.structuredContent).result;
};
const uuid = () => crypto.randomUUID();
const projectKey = () => `E${uuid().slice(0, 8).toUpperCase()}`;

describe("Epics", () => {
  let fixture: Awaited<ReturnType<typeof createFixture>>,
    application: Awaited<ReturnType<typeof createApplication>>,
    owner: Actor,
    colleague: Actor,
    guest: Actor,
    colleagueEmail: string,
    guestEmail: string;
  const execute: typeof application.domain.execute = (...call) =>
    application.domain.execute(...call);

  beforeAll(async () => {
    fixture = await createFixture();
    application = await createApplication(fixture.database, fixture.config);
    // An OAuth token is verified against the issuer's published keys, which this application serves.
    vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) =>
      application.app.fetch(new Request(input, init)),
    );
    const people = await Promise.all(
      ["owner", "colleague", "guest"].map((name) =>
        fixture.auth.api.createUser({
          body: {
            name,
            email: `${name}-${uuid()}@epics.test`,
            password: "Isolated epic password 42!",
            role: "user",
          },
        }),
      ),
    );
    owner = await application.domain.actor(requireRow(people[0]).user.id);
    colleague = await application.domain.actor(requireRow(people[1]).user.id);
    guest = await application.domain.actor(requireRow(people[2]).user.id);
    colleagueEmail = requireRow(people[1]).user.email;
    guestEmail = requireRow(people[2]).user.email;
  });
  afterAll(async () => {
    vi.unstubAllGlobals();
    await application?.close();
    await fixture?.close();
  });

  const newWorkspace = () =>
    execute("create_workspace", { name: "Epic workspace", slug: `e-${uuid()}` }, owner);
  const newProject = (workspace: Workspace, visibility: "workspace" | "private" = "workspace") =>
    execute(
      "create_project",
      { workspaceId: workspace.id, visibility, key: projectKey(), name: "Epic project" },
      owner,
    );
  const newEpic = (workspace: Workspace, title = "Launch") =>
    execute("create_epic", { workspaceId: workspace.id, title }, owner);
  const newTicket = (projectId: string, epicId: string | null = null, fields: object = {}) =>
    execute(
      "create_ticket",
      { projectId, title: "Member", ...(epicId && { epicId }), ...fields },
      owner,
    );
  const events = async (projectId: string, type: string) =>
    (
      await fixture.database.pool.query<{ ticket_id: string | null; data: object }>(
        `SELECT ticket_id, data FROM events WHERE project_id = $1 AND type = $2 ORDER BY id`,
        [projectId, type],
      )
    ).rows;

  it("lets an MCP client create an Epic, add tickets from two projects, and read them back", async () => {
    const workspace = await newWorkspace(),
      first = await newProject(workspace),
      second = await newProject(workspace),
      elsewhere = await newTicket(second.id);
    const { key } = await fixture.auth.api.createApiKey({
      body: {
        userId: owner.id,
        name: "Epic agent",
        metadata: { projectIds: null },
        permissions: { kanvil: ["read", "write"] },
        expiresIn: 3600,
        rateLimitEnabled: false,
      },
    });
    const agent = new Client({ name: "kanvil-epic-test", version: "1.0.0" });
    await agent.connect(
      new StreamableHTTPClientTransport(new URL("/mcp", fixture.config.KANVIL_URL), {
        requestInit: { headers: { Authorization: `Bearer ${key}` } },
        fetch: async (input, init) => application.app.fetch(new Request(input, init)),
      }),
    );
    try {
      const run = async (tool: string, name: string, input: Record<string, unknown>) =>
        resultOf(await agent.callTool({ name: tool, arguments: { name, input } }));
      const epic = z.object({ id: z.uuid(), workspaceId: z.uuid(), title: z.string() }).parse(
        await run("run_operation", "create_epic", {
          workspaceId: workspace.id,
          title: "Launch",
          description: "Everything launch needs.",
        }),
      );
      expect(epic).toMatchObject({ workspaceId: workspace.id, title: "Launch" });
      const created = z.object({ id: z.uuid() }).parse(
        resultOf(
          await agent.callTool({
            name: "create_ticket",
            arguments: { projectId: first.id, title: "Inside at birth", epicId: epic.id },
          }),
        ),
      );
      resultOf(
        await agent.callTool({
          name: "update_ticket",
          arguments: {
            projectId: second.id,
            ticketId: elsewhere.id,
            expectedVersion: elsewhere.version,
            changes: { epicId: epic.id },
          },
        }),
      );
      const page = z
        .object({
          items: z.array(z.object({ id: z.uuid(), projectId: z.uuid(), epicId: z.uuid() }).loose()),
          total: z.number(),
          restrictedCount: z.number().optional(),
        })
        .parse(
          await run("read_operation", "list_epic_tickets", {
            workspaceId: workspace.id,
            epicId: epic.id,
          }),
        );
      expect(page.total).toBe(2);
      expect(page.restrictedCount ?? 0).toBe(0);
      expect(page.items.map((row) => row.id).toSorted()).toEqual(
        [created.id, elsewhere.id].toSorted(),
      );
      expect(new Set(page.items.map((row) => row.projectId))).toEqual(
        new Set([first.id, second.id]),
      );
      // MCP lists answer summary rows, which still carry the membership.
      expect(page.items[0]).not.toHaveProperty("description");
      expect(page.items.every((row) => row.epicId === epic.id)).toBe(true);
    } finally {
      await agent.close();
    }
  });

  it("filters ticket lists by Epic and accepts it through bulk edits and summary rows", async () => {
    const workspace = await newWorkspace(),
      project = await newProject(workspace),
      epic = await newEpic(workspace),
      inside = await newTicket(project.id, epic.id),
      moved = await newTicket(project.id),
      outside = await newTicket(project.id);
    expect(inside.epicId).toBe(epic.id);
    expect(outside.epicId).toBeNull();
    await execute(
      "bulk_update_tickets",
      {
        projectId: project.id,
        tickets: [{ ticketId: moved.id, expectedVersion: moved.version }],
        changes: { epicId: epic.id },
      },
      owner,
    );
    const filtered = await execute(
      "list_tickets",
      { projectId: project.id, epicId: epic.id, view: "summary" },
      owner,
    );
    expect(filtered.total).toBe(2);
    expect(filtered.items.map((row) => row.id).toSorted()).toEqual(
      [inside.id, moved.id].toSorted(),
    );
    expect(filtered.items.map((row) => row.epicId)).toEqual([epic.id, epic.id]);
    // Setting it replaces the one Epic a ticket holds, and null leaves it in none.
    const other = await newEpic(workspace, "Other");
    const replaced = await execute(
      "update_ticket",
      {
        projectId: project.id,
        ticketId: inside.id,
        expectedVersion: inside.version,
        changes: { epicId: other.id },
      },
      owner,
    );
    expect(replaced.epicId).toBe(other.id);
    expect(
      (await execute("list_tickets", { projectId: project.id, epicId: epic.id }, owner)).items.map(
        (row) => row.id,
      ),
    ).toEqual([moved.id]);
    const cleared = await execute(
      "update_ticket",
      {
        projectId: project.id,
        ticketId: replaced.id,
        expectedVersion: replaced.version,
        changes: { epicId: null },
      },
      owner,
    );
    expect(cleared.epicId).toBeNull();
    // The change is an ordinary ticket update in the ticket's own project feed.
    expect((await events(project.id, "ticket.updated")).at(-1)).toMatchObject({
      ticket_id: inside.id,
      data: { changedFields: ["epicId"], epicId: null, version: cleared.version },
    });
  });

  it("refuses an Epic the caller cannot read or another workspace owns as not found", async () => {
    const workspace = await newWorkspace(),
      foreignWorkspace = await newWorkspace(),
      privateProject = await newProject(workspace, "private"),
      epic = await newEpic(workspace),
      foreign = await newEpic(foreignWorkspace);
    const notFound = { status: 404, code: "not_found" };
    await expect(newTicket(privateProject.id, foreign.id)).rejects.toMatchObject(notFound);
    await expect(newTicket(privateProject.id, uuid())).rejects.toMatchObject(notFound);
    // A direct project writer outside the workspace can write the ticket but cannot read its Epics.
    await execute(
      "set_member",
      { projectId: privateProject.id, email: guestEmail, role: "writer" },
      owner,
    );
    await expect(
      execute(
        "create_ticket",
        { projectId: privateProject.id, title: "Guest", epicId: epic.id },
        guest,
      ),
    ).rejects.toMatchObject(notFound);
    // So does a credential bound to the project, whoever owns it.
    const bound = await application.domain.actor(owner.id, {
      ownerId: "bound",
      scopes: ["write"],
      projectIds: [privateProject.id],
    });
    const ticket = await execute(
      "create_ticket",
      { projectId: privateProject.id, title: "Bound" },
      bound,
    );
    await expect(
      execute(
        "update_ticket",
        {
          projectId: privateProject.id,
          ticketId: ticket.id,
          expectedVersion: ticket.version,
          changes: { epicId: epic.id },
        },
        bound,
      ),
    ).rejects.toMatchObject(notFound);
    await expect(execute("list_epics", { workspaceId: workspace.id }, bound)).rejects.toMatchObject(
      { status: 403, code: "workspace_scope_required" },
    );
    await expect(
      execute("get_epic", { workspaceId: foreignWorkspace.id, epicId: epic.id }, owner),
    ).rejects.toMatchObject(notFound);
    // Reading needs membership; creating needs ticket.write in the workspace.
    await expect(execute("list_epics", { workspaceId: workspace.id }, guest)).rejects.toMatchObject(
      { status: 404 },
    );
    await execute(
      "set_workspace_member",
      { workspaceId: workspace.id, email: colleagueEmail, role: "reader" },
      owner,
    );
    expect((await execute("list_epics", { workspaceId: workspace.id }, colleague)).total).toBe(1);
    await expect(
      execute("create_epic", { workspaceId: workspace.id, title: "Mine" }, colleague),
    ).rejects.toMatchObject({ status: 403, code: "forbidden" });
    await expect(
      execute(
        "update_epic",
        { workspaceId: workspace.id, epicId: epic.id, expectedVersion: 1, archived: true },
        colleague,
      ),
    ).rejects.toMatchObject({ status: 403, code: "forbidden" });
  });

  it("keeps an archived Epic's members and refuses new ones", async () => {
    const workspace = await newWorkspace(),
      project = await newProject(workspace),
      epic = await newEpic(workspace),
      member = await newTicket(project.id, epic.id),
      other = await newTicket(project.id);
    const archived = await execute(
      "update_epic",
      { workspaceId: workspace.id, epicId: epic.id, expectedVersion: epic.version, archived: true },
      owner,
    );
    expect(archived).toMatchObject({ archived: true, version: epic.version + 1 });
    const refused = { status: 400, code: "validation_error" };
    await expect(newTicket(project.id, epic.id)).rejects.toMatchObject(refused);
    await expect(
      execute(
        "update_ticket",
        {
          projectId: project.id,
          ticketId: other.id,
          expectedVersion: other.version,
          changes: { epicId: epic.id },
        },
        owner,
      ),
    ).rejects.toMatchObject(refused);
    // An existing member stays, and saving it with the same value is not a new membership.
    const saved = await execute(
      "update_ticket",
      {
        projectId: project.id,
        ticketId: member.id,
        expectedVersion: member.version,
        changes: { title: "Renamed", epicId: epic.id },
      },
      owner,
    );
    expect(saved.epicId).toBe(epic.id);
    // A copy would be a new member, so it starts outside the Epic rather than failing.
    const copy = await execute(
      "duplicate_ticket",
      { projectId: project.id, ticketId: saved.id },
      owner,
    );
    expect(copy.epicId).toBeNull();
    const listed = async (archivedFilter?: "include" | "only") =>
      (
        await execute(
          "list_epics",
          { workspaceId: workspace.id, ...(archivedFilter && { archived: archivedFilter }) },
          owner,
        )
      ).items.map((row) => row.id);
    expect(await listed()).toEqual([]);
    expect(await listed("only")).toEqual([epic.id]);
    expect(await listed("include")).toEqual([epic.id]);
  });

  it("shows only tickets of readable projects, counting the rest without naming them", async () => {
    const workspace = await newWorkspace(),
      shared = await newProject(workspace),
      hidden = await newProject(workspace, "private"),
      epic = await newEpic(workspace);
    const open = await newTicket(shared.id, epic.id),
      closed = await newTicket(shared.id, epic.id, { status: "done" }),
      secret = await newTicket(hidden.id, epic.id, { title: "Secret title" });
    await newTicket(shared.id, epic.id, { status: "cancelled", archived: true });
    await execute(
      "set_workspace_member",
      { workspaceId: workspace.id, email: colleagueEmail, role: "writer" },
      owner,
    );
    const seen = await execute(
      "list_epic_tickets",
      { workspaceId: workspace.id, epicId: epic.id },
      colleague,
    );
    expect(seen.items.map((row) => row.id).toSorted()).toEqual([open.id, closed.id].toSorted());
    expect(seen).toMatchObject({ total: 2, restrictedCount: 1 });
    expect(JSON.stringify(seen)).not.toContain(secret.key);
    expect(JSON.stringify(seen)).not.toContain("Secret title");
    const everything = await execute(
      "list_epic_tickets",
      { workspaceId: workspace.id, epicId: epic.id },
      owner,
    );
    expect(everything).toMatchObject({ total: 3, restrictedCount: 0 });
    const paged = await execute(
      "list_epic_tickets",
      { workspaceId: workspace.id, epicId: epic.id, limit: 1, offset: 1, view: "summary" },
      owner,
    );
    expect(paged.total).toBe(3);
    expect(paged.items).toHaveLength(1);
    expect(paged.items[0]).not.toHaveProperty("description");
    // Rollups follow the same access; archived tickets stay out of them, as in list_projects.
    const counts = async (actor: Actor) =>
      (await execute("list_epics", { workspaceId: workspace.id }, actor)).items[0];
    expect(await counts(colleague)).toMatchObject({ openTickets: 1, closedTickets: 1 });
    expect(await counts(owner)).toMatchObject({ openTickets: 2, closedTickets: 1 });
    expect(
      await execute("get_epic", { workspaceId: workspace.id, epicId: epic.id }, colleague),
    ).toMatchObject({ id: epic.id, openTickets: 1, closedTickets: 1 });
  });

  it("publishes writes atomically to every project and honors requestId and expectedVersion", async () => {
    const workspace = await newWorkspace(),
      first = await newProject(workspace),
      second = await newProject(workspace);
    const requestId = uuid(),
      input = { workspaceId: workspace.id, title: "Launch", requestId };
    const epic = await execute("create_epic", input, owner);
    expect(await execute("create_epic", input, owner)).toEqual(epic);
    for (const project of [first, second])
      expect(await events(project.id, "epic.created")).toMatchObject([
        {
          ticket_id: null,
          data: { workspaceId: workspace.id, epicId: epic.id, version: epic.version },
        },
      ]);
    await expect(
      execute("create_epic", { ...input, title: "Different" }, owner),
    ).rejects.toMatchObject({ status: 409, code: "idempotency_conflict" });
    const updated = await execute(
      "update_epic",
      { workspaceId: workspace.id, epicId: epic.id, expectedVersion: epic.version, title: "Moved" },
      owner,
    );
    expect(updated).toMatchObject({ title: "Moved", version: epic.version + 1 });
    await expect(
      execute(
        "update_epic",
        { workspaceId: workspace.id, epicId: epic.id, expectedVersion: epic.version, title: "No" },
        owner,
      ),
    ).rejects.toMatchObject({ status: 409, code: "version_conflict" });
    // The refused write left neither a change nor an event.
    expect((await events(first.id, "epic.updated")).length).toBe(1);
    expect(
      await execute("get_epic", { workspaceId: workspace.id, epicId: epic.id }, owner),
    ).toMatchObject({ title: "Moved" });
  });

  it("follows a ticket through a move and a copy, and drops out with a project transfer", async () => {
    const workspace = await newWorkspace(),
      destination = await newWorkspace(),
      project = await newProject(workspace),
      neighbor = await newProject(workspace),
      epic = await newEpic(workspace);
    const staying = await newTicket(project.id, epic.id),
      outside = await newTicket(project.id);
    const copy = await execute(
      "duplicate_ticket",
      { projectId: project.id, ticketId: staying.id },
      owner,
    );
    expect(copy.epicId).toBe(epic.id);
    const moving = await newTicket(project.id, epic.id);
    const moved = await execute(
      "relocate_ticket",
      {
        projectId: project.id,
        ticketId: moving.id,
        expectedVersion: moving.version,
        destinationProjectId: neighbor.id,
      },
      owner,
    );
    expect(moved).toMatchObject({ projectId: neighbor.id, epicId: epic.id });

    const preview = await execute(
      "get_project_impact",
      { projectId: project.id, workspaceId: destination.id },
      owner,
    );
    expect(preview.transfer?.epicTickets).toBe(2);
    await execute(
      "transfer_project",
      { projectId: project.id, expectedVersion: project.version, workspaceId: destination.id },
      owner,
    );
    const after = await execute(
      "get_ticket",
      { projectId: project.id, ticketId: staying.id },
      owner,
    );
    expect(after.ticket).toMatchObject({ epicId: null, version: staying.version + 1 });
    // A ticket that held no Epic is not touched.
    expect(
      (await execute("get_ticket", { projectId: project.id, ticketId: outside.id }, owner)).ticket
        .version,
    ).toBe(outside.version);
    expect((await events(project.id, "ticket.updated")).at(-1)).toMatchObject({
      data: { changedFields: ["epicId"], epicId: null },
    });
    // What stayed in the workspace keeps its Epic.
    expect(
      (
        await execute("list_epic_tickets", { workspaceId: workspace.id, epicId: epic.id }, owner)
      ).items.map((row) => row.id),
    ).toEqual([moved.id]);
  });

  it("counts Epics as omitted from exports and removes them with their workspace", async () => {
    const workspace = await newWorkspace(),
      project = await newProject(workspace),
      epic = await newEpic(workspace),
      other = await newEpic(workspace, "Other");
    await newTicket(project.id, epic.id);
    await newTicket(project.id, epic.id);
    await newTicket(project.id, other.id);
    const bundle = await execute("export_project", { projectId: project.id }, owner);
    expect(bundle.completeness.omitted).toContainEqual(
      expect.objectContaining({ content: "epics", count: 2 }),
    );
    expect(JSON.stringify(bundle.tickets)).not.toContain(epic.id);
    expect(
      (await execute("get_workspace_impact", { workspaceId: workspace.id }, owner)).epics,
    ).toBe(2);
    const { slug, version } = workspace;
    await execute(
      "delete_workspace",
      { workspaceId: workspace.id, expectedVersion: version, confirmSlug: slug },
      { ...owner, signedInAt: new Date() },
    );
    const { rows } = await fixture.database.pool.query(
      `SELECT id FROM epics WHERE workspace_id = $1`,
      [workspace.id],
    );
    expect(rows).toEqual([]);
  });

  it("leaves readiness, eligibility, and claims unchanged", async () => {
    const workspace = await newWorkspace(),
      project = await newProject(workspace),
      epic = await newEpic(workspace);
    const ready = {
      description: "Ready work",
      acceptanceCriteria: "It works",
      difficulty: "low",
      automationReady: true,
    };
    const member = await newTicket(project.id, epic.id, ready),
      plain = await newTicket(project.id, null, ready);
    const readiness = async (ticketId: string) =>
      (await execute("get_ticket", { projectId: project.id, ticketId }, owner)).readiness;
    expect(await readiness(member.id)).toEqual(await readiness(plain.id));
    const eligible = await execute("list_eligible_tickets", { projectId: project.id }, owner);
    expect(
      eligible.items
        .filter((row) => row.readiness.ready)
        .map((row) => row.ticket.id)
        .toSorted(),
    ).toEqual([member.id, plain.id].toSorted());
    expect(
      await execute(
        "claim_ticket",
        { projectId: project.id, ticketId: member.id, workerId: "epic-worker" },
        owner,
      ),
    ).toMatchObject({ ticket: { status: "in_progress", epicId: epic.id } });
  });

  it("keeps Epics out of public project reads", async () => {
    const workspace = await newWorkspace(),
      project = await newProject(workspace),
      epic = await newEpic(workspace),
      member = await newTicket(project.id, epic.id);
    await execute(
      "update_project",
      {
        projectId: project.id,
        expectedVersion: project.version,
        name: project.name,
        description: project.description,
        publicReadEnabled: true,
      },
      owner,
    );
    for (const path of ["/tickets", `/tickets/${member.id}`]) {
      const response = await application.app.fetch(
        new Request(
          new URL(`/api/public/projects/${project.id}${path}`, fixture.config.KANVIL_URL),
        ),
      );
      expect(response.status).toBe(200);
      const body = await response.text();
      expect(body).toContain(member.key);
      expect(body).not.toContain("epicId");
      expect(body).not.toContain(epic.id);
    }
  });

  it("serves the Epic operations and the ticket filter over HTTP", async () => {
    const workspace = await newWorkspace(),
      project = await newProject(workspace);
    const { key } = await fixture.auth.api.createApiKey({
      body: {
        userId: owner.id,
        name: "Epic HTTP",
        metadata: { projectIds: null },
        permissions: { kanvil: ["read", "write"] },
        expiresIn: 3600,
        rateLimitEnabled: false,
      },
    });
    const call = (method: string, path: string, body?: object) =>
      application.app.fetch(
        new Request(new URL(`/api/v1${path}`, fixture.config.KANVIL_URL), {
          method,
          headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
          ...(body && { body: JSON.stringify(body) }),
        }),
      );
    const base = `/workspaces/${workspace.id}/epics`;
    const created = await call("POST", base, { title: "Over HTTP" });
    expect(created.status).toBe(200);
    const epic = z.object({ id: z.uuid(), version: z.number() }).parse(await created.json());
    const ticket = z.object({ id: z.uuid() }).parse(
      await (
        await call("POST", `/projects/${project.id}/tickets`, {
          title: "Member over HTTP",
          epicId: epic.id,
        })
      ).json(),
    );
    const stale = await call("PATCH", `${base}/${epic.id}`, {
      expectedVersion: epic.version + 5,
      title: "Late",
    });
    expect(stale.status).toBe(409);
    const list = z
      .object({ items: z.array(z.object({ id: z.uuid(), openTickets: z.number() })) })
      .parse(await (await call("GET", base)).json());
    expect(list.items).toEqual([expect.objectContaining({ id: epic.id, openTickets: 1 })]);
    const members = z
      .object({ items: z.array(z.object({ id: z.uuid() })), restrictedCount: z.number() })
      .parse(await (await call("GET", `${base}/${epic.id}/tickets`)).json());
    expect(members.items.map((row) => row.id)).toEqual([ticket.id]);
    const filtered = z
      .object({ total: z.number() })
      .parse(await (await call("GET", `/projects/${project.id}/tickets?epicId=${uuid()}`)).json());
    expect(filtered.total).toBe(0);
  });
});
