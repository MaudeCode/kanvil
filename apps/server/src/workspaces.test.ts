import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vite-plus/test";
import { createFixture } from "./test-fixture.ts";
import { createDomain, requireRow, type Actor, type Domain } from "./domain.ts";
import type { Workspace } from "@kanvil/contracts";

describe("workspace boundaries and inherited project access", () => {
  let fixture: Awaited<ReturnType<typeof createFixture>>,
    domain: Domain,
    owner: Actor,
    member: Actor,
    outsider: Actor,
    workspace: Workspace;
  beforeAll(async () => {
    fixture = await createFixture();
    domain = createDomain(fixture.database);
    const people = await Promise.all(
      ["owner", "member", "outsider"].map((name) =>
        fixture.auth.api.createUser({
          body: {
            name,
            email: `${name}@workspace.test`,
            password: "Isolated workspace password 42!",
            role: "user",
          },
        }),
      ),
    );
    const actors = await Promise.all(people.map((person) => domain.actor(person.user.id)));
    owner = requireRow(actors[0]);
    member = requireRow(actors[1]);
    outsider = requireRow(actors[2]);
  });
  afterAll(async () => {
    await fixture?.close();
  });
  beforeEach(async () => {
    workspace = await domain.execute(
      "create_workspace",
      { name: "Workspace boundary", slug: `w-${crypto.randomUUID()}` },
      owner,
    );
  });
  const project = (visibility: "workspace" | "private" = "workspace") =>
    domain.execute(
      "create_project",
      {
        workspaceId: workspace.id,
        visibility,
        key: `W${crypto.randomUUID().slice(0, 8).toUpperCase()}`,
        name: "Workspace project",
      },
      owner,
    );
  const membership = (role: "reader" | "writer" | "admin" | null) =>
    domain.execute(
      "set_workspace_member",
      { workspaceId: workspace.id, email: "member@workspace.test", role },
      owner,
    );
  it("inherits reader and writer roles while private projects stay hidden", async () => {
    const shared = await project(),
      privateProject = await project("private");
    await membership("reader");
    const listed = async () =>
      (await domain.execute("list_projects", { workspaceId: workspace.id }, member)).map(
        ({ id, role }) => ({ id, role }),
      );
    expect(await listed()).toEqual([{ id: shared.id, role: "reader" }]);
    await expect(
      domain.execute("list_tickets", { projectId: privateProject.id }, member),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      domain.execute("create_ticket", { projectId: shared.id, title: "Forbidden" }, member),
    ).rejects.toMatchObject({ status: 403 });
    await membership("writer");
    expect(await listed()).toEqual([{ id: shared.id, role: "writer" }]);
    const ticket = await domain.execute(
      "create_ticket",
      { projectId: shared.id, title: "Inherited write access" },
      member,
    );
    expect(ticket.projectId).toBe(shared.id);
    expect(await domain.execute("list_members", { projectId: shared.id }, member)).toContainEqual(
      expect.objectContaining({ userId: member.id, source: "workspace", role: "writer" }),
    );
    await domain.execute(
      "set_member",
      { projectId: shared.id, email: "member@workspace.test", role: "reader" },
      owner,
    );
    await expect(
      domain.execute(
        "create_ticket",
        { projectId: shared.id, title: "Explicit restriction" },
        member,
      ),
    ).rejects.toMatchObject({ status: 403 });
  });
  it("keeps project guests and project-bound keys out of workspace administration", async () => {
    const privateProject = await project("private"),
      other = await project();
    await domain.execute(
      "set_member",
      { projectId: privateProject.id, email: "outsider@workspace.test", role: "writer" },
      owner,
    );
    expect(await domain.execute("list_workspaces", {}, outsider)).toContainEqual(
      expect.objectContaining({ id: workspace.id, role: null }),
    );
    await expect(
      domain.execute("list_workspace_members", { workspaceId: workspace.id }, outsider),
    ).rejects.toMatchObject({ status: 404 });
    expect((await domain.execute("list_projects", {}, outsider)).map((row) => row.id)).toEqual([
      privateProject.id,
    ]);
    const scoped = await domain.actor(owner.id, {
      ownerId: "bounded",
      scopes: ["admin"],
      projectIds: [privateProject.id],
    });
    expect((await domain.execute("list_projects", {}, scoped)).map((row) => row.id)).toEqual([
      privateProject.id,
    ]);
    expect(await domain.execute("list_workspaces", {}, scoped)).toEqual([
      expect.objectContaining({ id: workspace.id, role: null }),
    ]);
    await expect(
      domain.execute("get_ticket", { projectId: other.id, ticketId: crypto.randomUUID() }, scoped),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      domain.execute(
        "set_workspace_member",
        { workspaceId: workspace.id, email: "outsider@workspace.test", role: "admin" },
        scoped,
      ),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      domain.execute("create_workspace", { name: "Escalation", slug: "escalation" }, scoped),
    ).rejects.toMatchObject({ status: 403 });
  });
  it("removes all workspace grants and rechecks idempotent writes and replay", async () => {
    const shared = await project(),
      privateProject = await project("private");
    await membership("writer");
    await domain.execute(
      "set_member",
      { projectId: privateProject.id, email: "member@workspace.test", role: "writer" },
      owner,
    );
    const input = {
      projectId: shared.id,
      title: "Accepted before access removal",
      requestId: crypto.randomUUID(),
    };
    await domain.execute("create_ticket", input, member);
    await membership(null);
    expect(await domain.execute("list_projects", { workspaceId: workspace.id }, member)).toEqual(
      [],
    );
    await expect(domain.execute("create_ticket", input, member)).rejects.toMatchObject({
      status: 404,
    });
    await expect(domain.readEvents(member, 0n, shared.id)).rejects.toMatchObject({ status: 404 });
    await expect(
      domain.execute("list_tickets", { projectId: privateProject.id }, member),
    ).rejects.toMatchObject({ status: 404 });
  });
  it("serializes administrator changes and protects the last administrator", async () => {
    await membership("admin");
    const results = await Promise.allSettled([
      domain.execute(
        "set_workspace_member",
        { workspaceId: workspace.id, email: "owner@workspace.test", role: "writer" },
        owner,
      ),
      domain.execute(
        "set_workspace_member",
        { workspaceId: workspace.id, email: "member@workspace.test", role: "writer" },
        member,
      ),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const winner = results[0]?.status === "fulfilled" ? member : owner;
    const people = await domain.execute(
      "list_workspace_members",
      { workspaceId: workspace.id },
      winner,
    );
    expect(people.filter((person) => person.role === "admin")).toHaveLength(1);
  });
  it("keeps workspace creation retries and settings versions safe", async () => {
    const input = {
      name: "Retry",
      slug: `retry-${crypto.randomUUID()}`,
      requestId: crypto.randomUUID(),
    };
    const first = await domain.execute("create_workspace", input, owner);
    expect(await domain.execute("create_workspace", input, owner)).toEqual(first);
    const next = await domain.execute(
      "update_workspace",
      { workspaceId: first.id, expectedVersion: 1, name: "Renamed", description: "Reviewed" },
      owner,
    );
    expect(next.version).toBe(2);
    await expect(
      domain.execute(
        "update_workspace",
        { workspaceId: first.id, expectedVersion: 1, name: "Stale", description: "" },
        owner,
      ),
    ).rejects.toMatchObject({ status: 409 });
  });
  it("notifies followers who inherited access and returns workspace changes in project replay", async () => {
    const shared = await project();
    await membership("writer");
    const ticket = await domain.execute(
      "create_ticket",
      { projectId: shared.id, title: "Inherited follower" },
      owner,
    );
    await domain.execute(
      "set_subscription",
      { projectId: shared.id, ticketId: ticket.id, enabled: true },
      member,
    );
    await domain.execute(
      "add_comment",
      { projectId: shared.id, ticketId: ticket.id, body: "Update for workspace member" },
      owner,
    );
    const notices = await fixture.database.pool.query(
      "SELECT id FROM notifications WHERE user_id = $1 AND project_id = $2",
      [member.id, shared.id],
    );
    expect(notices.rowCount).toBe(1);
    await domain.execute(
      "update_workspace",
      { workspaceId: workspace.id, expectedVersion: 1, name: "Changed", description: "" },
      owner,
    );
    expect((await domain.readEvents(member, 0n, shared.id)).items.at(-1)?.type).toBe(
      "workspace.updated",
    );
  });
});

it("upgrades populated project data without widening private access", async () => {
  const { mkdtemp, mkdir, readFile, writeFile, copyFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { fileURLToPath } = await import("node:url");
  const { migrate } = await import("drizzle-orm/node-postgres/migrator");
  const { drizzle } = await import("drizzle-orm/node-postgres");
  const folder = await mkdtemp(join(tmpdir(), "kanvil-workspace-upgrade-"));
  let fixture: Awaited<ReturnType<typeof createFixture>> | undefined;
  try {
    const source = fileURLToPath(new URL("../drizzle/", import.meta.url));
    const journal = JSON.parse(await readFile(join(source, "meta/_journal.json"), "utf8"));
    journal.entries = journal.entries.filter((entry: { idx: number }) => entry.idx < 8);
    await mkdir(join(folder, "meta"));
    await writeFile(join(folder, "meta/_journal.json"), JSON.stringify(journal));
    for (const entry of journal.entries)
      await copyFile(join(source, `${entry.tag}.sql`), join(folder, `${entry.tag}.sql`));
    fixture = await createFixture({
      beforeMigrate: async (database) => {
        await migrate(drizzle(database.pool), { migrationsFolder: folder });
        await database.pool.query(
          `INSERT INTO "user" (id, name, email, role) VALUES ('first', 'First', 'first@upgrade.test', 'user'), ('second', 'Second', 'second@upgrade.test', 'user')`,
        );
        await database.pool.query(
          `INSERT INTO projects (id, key, name) VALUES ('00000000-0000-4000-8000-000000000011', 'FIRST', 'First project'), ('00000000-0000-4000-8000-000000000012', 'SECOND', 'Second project')`,
        );
        await database.pool.query(
          `INSERT INTO project_members (project_id, user_id, role) VALUES ('00000000-0000-4000-8000-000000000011', 'first', 'admin'), ('00000000-0000-4000-8000-000000000012', 'second', 'admin')`,
        );
      },
    });
    const domain = createDomain(fixture.database),
      first = await domain.actor("first");
    const projects = await domain.execute("list_projects", {}, first);
    expect(projects.map((project) => project.key)).toEqual(["FIRST"]);
    expect(projects[0]).toMatchObject({
      id: "00000000-0000-4000-8000-000000000011",
      visibility: "private",
    });
    expect(await domain.execute("list_workspaces", {}, first)).toEqual([
      expect.objectContaining({ slug: "kanvil", role: "reader" }),
    ]);
    await expect(
      domain.execute("list_tickets", { projectId: "SECOND" }, first),
    ).rejects.toMatchObject({ status: 404 });
  } finally {
    await fixture?.close();
    await rm(folder, { recursive: true, force: true });
  }
});

it("restores inherited roles while a workspace administrator keeps the project manageable", async () => {
  const fixture = await createFixture();
  try {
    const domain = createDomain(fixture.database),
      people = await Promise.all(
        ["admin", "creator"].map((name) =>
          fixture.auth.api.createUser({
            body: {
              name,
              email: `${name}@override.test`,
              password: "Isolated override password 234!",
              role: "user",
            },
          }),
        ),
      );
    const admin = await domain.actor(people[0]!.user.id),
      creator = await domain.actor(people[1]!.user.id);
    const workspace = await domain.execute(
      "create_workspace",
      { name: "Inherited administration", slug: "inherited-administration" },
      admin,
    );
    await domain.execute(
      "set_workspace_member",
      { workspaceId: workspace.id, email: people[1]!.user.email, role: "writer" },
      admin,
    );
    const project = await domain.execute(
      "create_project",
      {
        workspaceId: workspace.id,
        visibility: "workspace",
        key: "OVERRIDE",
        name: "Project override",
      },
      creator,
    );
    await domain.execute(
      "set_member",
      { projectId: project.id, email: people[1]!.user.email, role: null },
      admin,
    );
    expect(await domain.execute("list_members", { projectId: project.id }, creator)).toContainEqual(
      expect.objectContaining({
        userId: creator.id,
        role: "writer",
        source: "workspace",
        inheritedRole: "writer",
      }),
    );
    await expect(
      domain.execute(
        "update_project",
        { projectId: project.id, expectedVersion: 1, name: "Restricted", description: "" },
        creator,
      ),
    ).rejects.toMatchObject({ status: 403 });
    expect(
      (
        await domain.execute(
          "update_project",
          { projectId: project.id, expectedVersion: 1, name: "Still manageable", description: "" },
          admin,
        )
      ).name,
    ).toBe("Still manageable");
  } finally {
    await fixture.close();
  }
});

it("reauthorizes workspace receipts after membership revocation and credential narrowing", async () => {
  const fixture = await createFixture();
  try {
    const domain = createDomain(fixture.database),
      people = await Promise.all(
        ["creator", "successor"].map((name) =>
          fixture.auth.api.createUser({
            body: {
              name,
              email: `${name}@receipts.test`,
              password: "Isolated receipt password 234!",
              role: "user",
            },
          }),
        ),
      );
    const creator = await domain.actor(people[0]!.user.id),
      successor = await domain.actor(people[1]!.user.id);
    const creation = {
      name: "Receipt workspace",
      slug: "receipt-workspace",
      requestId: crypto.randomUUID(),
    };
    const space = await domain.execute("create_workspace", creation, creator);
    const projectInput = {
      workspaceId: space.id,
      key: "RECEIPT",
      name: "Receipt project",
      requestId: crypto.randomUUID(),
    };
    const project = await domain.execute("create_project", projectInput, creator);
    const scoped = await domain.actor(creator.id, {
      ownerId: "project-bound",
      scopes: ["admin"],
      projectIds: [project.id],
    });
    await expect(domain.execute("create_workspace", creation, scoped)).rejects.toMatchObject({
      status: 403,
    });
    await expect(domain.execute("create_project", projectInput, scoped)).rejects.toMatchObject({
      status: 403,
    });
    const edit = {
      workspaceId: space.id,
      expectedVersion: 1,
      name: "Saved settings",
      description: "Authorized at first write",
      requestId: crypto.randomUUID(),
    };
    await domain.execute("update_workspace", edit, creator);
    await domain.execute(
      "set_workspace_member",
      { workspaceId: space.id, email: people[1]!.user.email, role: "admin" },
      creator,
    );
    await domain.execute(
      "set_workspace_member",
      { workspaceId: space.id, email: people[0]!.user.email, role: null },
      successor,
    );
    await expect(domain.execute("update_workspace", edit, creator)).rejects.toMatchObject({
      status: 403,
    });
    await expect(domain.execute("create_workspace", creation, creator)).rejects.toMatchObject({
      status: 404,
    });
    await expect(domain.execute("create_project", projectInput, creator)).rejects.toMatchObject({
      status: 404,
    });
  } finally {
    await fixture.close();
  }
});
