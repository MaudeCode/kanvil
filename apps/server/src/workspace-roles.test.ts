import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vite-plus/test";
import { and, eq } from "drizzle-orm";
import type { Permission, Workspace } from "@kanvil/contracts";
import { createFixture } from "./test-fixture.ts";
import { createDomain, requireRow, type Actor, type Domain } from "./domain.ts";
import { members, workspaceMembers } from "./schema.ts";

const email = (name: string) => `${name}@roles.test`;
describe("custom workspace roles", () => {
  let fixture: Awaited<ReturnType<typeof createFixture>>,
    domain: Domain,
    owner: Actor,
    deputy: Actor,
    member: Actor,
    other: Actor,
    workspace: Workspace;
  beforeAll(async () => {
    fixture = await createFixture();
    domain = createDomain(fixture.database);
    const people = await Promise.all(
      ["owner", "deputy", "member", "other"].map((name) =>
        fixture.auth.api.createUser({
          body: {
            name,
            email: email(name),
            password: "Isolated roles password 42!",
            role: "user",
          },
        }),
      ),
    );
    const actors = await Promise.all(people.map((person) => domain.actor(person.user.id)));
    owner = requireRow(actors[0]);
    deputy = requireRow(actors[1]);
    member = requireRow(actors[2]);
    other = requireRow(actors[3]);
  });
  afterAll(async () => {
    await fixture?.close();
  });
  beforeEach(async () => {
    workspace = await domain.execute(
      "create_workspace",
      { name: "Roles", slug: `r-${crypto.randomUUID()}` },
      owner,
    );
  });
  const role = (name: string, permissions: Permission[], actor = owner) =>
    domain.execute(
      "create_workspace_role",
      { workspaceId: workspace.id, name, permissions },
      actor,
    );
  const join = (person: string, roleId: string | null, actor = owner) =>
    domain.execute(
      "set_workspace_member",
      { workspaceId: workspace.id, email: email(person), role: roleId },
      actor,
    );
  const project = (visibility: "workspace" | "private" = "workspace") =>
    domain.execute(
      "create_project",
      {
        workspaceId: workspace.id,
        visibility,
        key: `R${crypto.randomUUID().slice(0, 8).toUpperCase()}`,
        name: "Roles project",
      },
      owner,
    );
  const workspaceAs = async (actor: Actor) =>
    requireRow(
      (await domain.execute("list_workspaces", {}, actor)).find((row) => row.id === workspace.id),
    );
  const projectAs = async (actor: Actor, projectId: string) =>
    requireRow(
      (await domain.execute("list_projects", { workspaceId: workspace.id }, actor)).find(
        (row) => row.id === projectId,
      ),
    );

  it("lists the seeded roles and resolves memberships that predate custom roles", async () => {
    await join("member", "writer");
    const roles = await domain.execute(
      "list_workspace_roles",
      { workspaceId: workspace.id },
      member,
    );
    expect(roles.map((row) => [row.id, row.seeded, row.assigned])).toEqual([
      ["reader", true, 0],
      ["writer", true, 1],
      ["admin", true, 1],
    ]);
    expect(requireRow(roles[2]).permissions).toContain("workspace.manage");
    // A membership stored before custom roles carries only the seeded name.
    const [stored] = await fixture.database.db
      .select()
      .from(workspaceMembers)
      .where(eq(workspaceMembers.userId, member.id));
    expect(stored).toMatchObject({ role: "writer", roleId: null });
    expect(await workspaceAs(member)).toMatchObject({
      role: "writer",
      roleId: "writer",
      capabilities: ["ticket.write"],
    });
  });

  it("assigns a custom role through the member editor and enforces its actions", async () => {
    const shared = await project();
    const triage = await role("Triage", ["ticket.delete", "ticket.write"]);
    // Actions come back in catalog order.
    expect(triage).toMatchObject({ permissions: ["ticket.write", "ticket.delete"], seeded: false });
    await join("member", triage.id);
    const people = await domain.execute(
      "list_workspace_members",
      { workspaceId: workspace.id },
      owner,
    );
    // Older clients read the seeded stand-in; newer ones the role itself.
    expect(people.find((person) => person.userId === member.id)).toMatchObject({
      role: "writer",
      roleId: triage.id,
    });
    expect(await projectAs(member, shared.id)).toMatchObject({
      role: "writer",
      roleId: triage.id,
      capabilities: ["ticket.write", "ticket.delete"],
    });
    const ticket = await domain.execute(
      "create_ticket",
      { projectId: shared.id, title: "Triaged" },
      member,
    );
    await domain.execute(
      "delete_ticket",
      { projectId: shared.id, ticketId: ticket.id, expectedVersion: ticket.version },
      member,
    );
    await expect(
      domain.execute(
        "update_project",
        { projectId: shared.id, expectedVersion: shared.version, name: "Renamed", description: "" },
        member,
      ),
    ).rejects.toMatchObject({ status: 403, code: "forbidden" });
    expect(
      requireRow(
        (await domain.execute("list_workspace_roles", { workspaceId: workspace.id }, owner)).find(
          (row) => row.id === triage.id,
        ),
      ).assigned,
    ).toBe(1);
  });

  it("caps capabilities at the credential's scopes", async () => {
    const shared = await project();
    const manager = await role("Manager", ["ticket.write", "member.manage"]);
    await join("member", manager.id);
    const credential = await domain.actor(member.id, {
      ownerId: crypto.randomUUID(),
      scopes: ["read", "write"],
    });
    expect((await projectAs(credential, shared.id)).capabilities).toEqual(["ticket.write"]);
    await expect(
      domain.execute(
        "set_member",
        { projectId: shared.id, email: email("other"), role: "reader" },
        credential,
      ),
    ).rejects.toMatchObject({ status: 403, code: "insufficient_scope" });
  });

  it("never grants more than the acting role holds", async () => {
    const shared = await project();
    const manager = await role("Member manager", ["ticket.write", "member.manage"]);
    const delegate = await role("Delegate", ["workspace.manage"]);
    await join("member", manager.id);
    await join("deputy", "admin");
    await join("other", delegate.id);
    // Seeded and custom roles beyond the manager's own are refused.
    await expect(join("other", "admin", member)).rejects.toMatchObject({
      status: 403,
      code: "forbidden",
    });
    const wider = await role("Wider", ["ticket.write", "ticket.delete"]);
    await expect(join("other", wider.id, member)).rejects.toMatchObject({ code: "forbidden" });
    // Nor can the manager change or remove someone who holds more than they do.
    await expect(join("deputy", "reader", member)).rejects.toMatchObject({ code: "forbidden" });
    await expect(join("other", null, member)).rejects.toMatchObject({ code: "forbidden" });
    await join("other", "reader");
    await expect(
      domain.execute(
        "set_member",
        { projectId: shared.id, email: email("deputy"), role: "writer" },
        member,
      ),
    ).rejects.toMatchObject({ code: "forbidden" });
    // Within their own actions they manage members, on the workspace and its projects.
    await join("other", "writer", member);
    await domain.execute(
      "set_member",
      { projectId: shared.id, email: email("other"), role: manager.id },
      member,
    );
    // A role editor cannot define or widen a role past their own actions.
    await join("other", delegate.id);
    await expect(role("Escalated", ["ticket.delete"], other)).rejects.toMatchObject({
      code: "forbidden",
    });
    await expect(
      domain.execute(
        "update_workspace_role",
        {
          workspaceId: workspace.id,
          roleId: manager.id,
          expectedVersion: manager.version,
          name: manager.name,
          permissions: ["member.manage"],
        },
        other,
      ),
    ).rejects.toMatchObject({ code: "forbidden" });
    // Invitations follow the same ceiling.
    const inviter = await role("Inviter", ["invitation.manage", "ticket.write"]);
    await join("member", inviter.id);
    await expect(
      domain.execute(
        "create_invitation",
        { workspaceId: workspace.id, email: "new@roles.test", role: "admin" },
        member,
      ),
    ).rejects.toMatchObject({ code: "forbidden" });
    await domain.execute(
      "create_invitation",
      { workspaceId: workspace.id, email: "new@roles.test", role: "writer" },
      member,
    );
  });

  it("refuses to remove a workspace member whose project roles exceed the caller", async () => {
    const hidden = await project("private");
    const manager = await role("Member manager", ["ticket.write", "member.manage"]);
    await join("member", manager.id);
    await join("other", "reader");
    await domain.execute(
      "set_member",
      { projectId: hidden.id, email: email("other"), role: "admin" },
      owner,
    );
    // Removal also drops every direct project role in the workspace, so each must be grantable.
    await expect(join("other", null, member)).rejects.toMatchObject({
      status: 403,
      code: "forbidden",
    });
    const people = await domain.execute("list_members", { projectId: hidden.id }, owner);
    expect(people.find((person) => person.userId === other.id)).toMatchObject({ role: "admin" });
  });

  it("revokes a removed action at once and rewrites the seeded stand-in", async () => {
    const shared = await project();
    const editor = await role("Editor", ["ticket.write"]);
    await join("member", editor.id);
    await domain.execute("create_ticket", { projectId: shared.id, title: "Allowed" }, member);
    const narrowed = await domain.execute(
      "update_workspace_role",
      {
        workspaceId: workspace.id,
        roleId: editor.id,
        expectedVersion: editor.version,
        name: "Viewer plus",
        permissions: ["sharing.manage"],
      },
      owner,
    );
    expect(narrowed).toMatchObject({ name: "Viewer plus", version: 2, assigned: 1 });
    await expect(
      domain.execute("create_ticket", { projectId: shared.id, title: "Refused" }, member),
    ).rejects.toMatchObject({ status: 403, code: "forbidden" });
    expect(await projectAs(member, shared.id)).toMatchObject({
      role: "reader",
      capabilities: ["sharing.manage"],
    });
    // Sharing is its own action: the public link, but not the project's details.
    const current = await domain.execute("get_project", { projectId: shared.id }, member);
    const shared2 = await domain.execute(
      "update_project",
      {
        projectId: shared.id,
        expectedVersion: current.version,
        name: current.name,
        description: current.description,
        publicReadEnabled: true,
      },
      member,
    );
    expect(shared2.publicReadEnabled).toBe(true);
    await expect(
      domain.execute(
        "update_project",
        {
          projectId: shared.id,
          expectedVersion: shared2.version,
          name: "Renamed",
          description: "",
        },
        member,
      ),
    ).rejects.toMatchObject({ code: "forbidden" });
  });

  it("rejects a stale role edit", async () => {
    const editor = await role("Editor", ["ticket.write"]);
    const edit = {
      workspaceId: workspace.id,
      roleId: editor.id,
      expectedVersion: editor.version,
      name: "Editor",
    };
    await domain.execute("update_workspace_role", { ...edit, permissions: [] }, owner);
    await expect(
      domain.execute(
        "update_workspace_role",
        { ...edit, permissions: ["ticket.write", "ticket.delete"] },
        owner,
      ),
    ).rejects.toMatchObject({ status: 409, code: "version_conflict" });
  });

  it("keeps names unique and the seeded names reserved", async () => {
    await role("Triage", []);
    await expect(role("triage", [])).rejects.toMatchObject({ status: 409, code: "duplicate_role" });
    await expect(role("Admin", [])).rejects.toMatchObject({ code: "duplicate_role" });
    await expect(role("writer", [])).rejects.toMatchObject({ code: "duplicate_role" });
    await expect(role("Can edit", [])).rejects.toMatchObject({ code: "duplicate_role" });
  });

  it("deletes an assigned role only with a reassignment", async () => {
    const shared = await project();
    const triage = await role("Triage", ["ticket.write"]);
    await join("member", triage.id);
    await domain.execute(
      "set_member",
      { projectId: shared.id, email: email("other"), role: triage.id },
      owner,
    );
    const remove = { workspaceId: workspace.id, roleId: triage.id, expectedVersion: 1 };
    await expect(domain.execute("delete_workspace_role", remove, owner)).rejects.toMatchObject({
      status: 409,
      code: "role_in_use",
      details: { assigned: 2 },
    });
    await expect(
      domain.execute("delete_workspace_role", { ...remove, reassignTo: triage.id }, owner),
    ).rejects.toMatchObject({ code: "validation_error" });
    await domain.execute("delete_workspace_role", { ...remove, reassignTo: "reader" }, owner);
    const rows = [
      ...(await fixture.database.db
        .select()
        .from(workspaceMembers)
        .where(
          and(
            eq(workspaceMembers.workspaceId, workspace.id),
            eq(workspaceMembers.userId, member.id),
          ),
        )),
      ...(await fixture.database.db
        .select()
        .from(members)
        .where(and(eq(members.projectId, shared.id), eq(members.userId, other.id)))),
    ];
    expect(rows.map((row) => [row.role, row.roleId])).toEqual([
      ["reader", null],
      ["reader", null],
    ]);
    const roles = await domain.execute(
      "list_workspace_roles",
      { workspaceId: workspace.id },
      owner,
    );
    expect(roles.map((row) => row.id)).toEqual(["reader", "writer", "admin"]);
    // A role no one holds goes without one.
    const unused = await role("Unused", []);
    await domain.execute(
      "delete_workspace_role",
      { workspaceId: workspace.id, roleId: unused.id, expectedVersion: unused.version },
      owner,
    );
  });

  it("keeps private projects to their members and the seeded administrators", async () => {
    const hidden = await project("private");
    const manager = await role("Project manager", ["ticket.write", "project.manage"]);
    await join("member", manager.id);
    expect(
      (await domain.execute("list_projects", { workspaceId: workspace.id }, member)).map(
        (row) => row.id,
      ),
    ).not.toContain(hidden.id);
    await expect(
      domain.execute("get_project", { projectId: hidden.id }, member),
    ).rejects.toMatchObject({ status: 404 });
    await domain.execute(
      "set_member",
      { projectId: hidden.id, email: email("member"), role: manager.id },
      owner,
    );
    expect(await projectAs(member, hidden.id)).toMatchObject({
      roleId: manager.id,
      capabilities: ["ticket.write", "project.manage"],
    });
    const people = await domain.execute("list_members", { projectId: hidden.id }, member);
    expect(people.find((person) => person.userId === member.id)).toMatchObject({
      source: "project",
      roleId: manager.id,
      inheritedRoleId: null,
    });
    // A role from another workspace is never assignable here.
    const elsewhere = await domain.execute(
      "create_workspace",
      { name: "Elsewhere", slug: `e-${crypto.randomUUID()}` },
      owner,
    );
    const foreign = await domain.execute(
      "create_workspace_role",
      { workspaceId: elsewhere.id, name: "Foreign", permissions: [] },
      owner,
    );
    await expect(
      domain.execute(
        "set_member",
        { projectId: hidden.id, email: email("other"), role: foreign.id },
        owner,
      ),
    ).rejects.toMatchObject({ status: 404, code: "not_found" });
    expect(
      (await domain.execute("list_project_roles", { projectId: hidden.id }, member)).map(
        (row) => row.name,
      ),
    ).toEqual(["Read only", "Can edit", "Admin", "Project manager"]);
  });

  it("keeps the owner and the last administrator on the seeded Admin role", async () => {
    const helper = await role("Helper", ["ticket.write"]);
    await expect(join("owner", helper.id)).rejects.toMatchObject({
      status: 409,
      code: "workspace_owner",
    });
    await join("deputy", "admin");
    await domain.execute(
      "set_workspace_member",
      { workspaceId: workspace.id, email: email("deputy"), role: helper.id },
      owner,
    );
    expect(await workspaceAs(deputy)).toMatchObject({ role: "writer", roleId: helper.id });
    // A custom role never stands in for an administrator, so the owner stays the last one.
    const all = await role("Everything but admin", [
      "ticket.write",
      "ticket.delete",
      "project.manage",
      "member.manage",
      "invitation.manage",
      "sharing.manage",
      "workspace.manage",
    ]);
    await join("deputy", all.id);
    await expect(
      domain.execute(
        "set_workspace_member",
        { workspaceId: workspace.id, email: email("deputy"), role: "admin" },
        deputy,
      ),
    ).rejects.toMatchObject({ code: "forbidden" });
    await expect(
      domain.execute(
        "transfer_workspace",
        { workspaceId: workspace.id, expectedVersion: workspace.version, userId: deputy.id },
        owner,
      ),
    ).rejects.toMatchObject({ code: "owner_ineligible" });
  });

  it("clears custom roles from direct members when a project changes workspace", async () => {
    const moving = await project("private");
    const triage = await role("Triage", ["ticket.write"]);
    await domain.execute(
      "set_member",
      { projectId: moving.id, email: email("member"), role: triage.id },
      owner,
    );
    const destination = await domain.execute(
      "create_workspace",
      { name: "Destination", slug: `d-${crypto.randomUUID()}` },
      owner,
    );
    await domain.execute(
      "transfer_project",
      { projectId: moving.id, expectedVersion: moving.version, workspaceId: destination.id },
      owner,
    );
    const [moved] = await fixture.database.db
      .select()
      .from(members)
      .where(and(eq(members.projectId, moving.id), eq(members.userId, member.id)));
    expect(moved).toMatchObject({ role: "writer", roleId: null });
  });
});
