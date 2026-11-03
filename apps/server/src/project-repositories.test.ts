import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import type { Project, Workspace } from "@kanvil/contracts";
import { createFixture } from "./test-fixture.ts";
import { createDomain, requireRow, type Actor, type Domain } from "./domain.ts";

const remote = (name: string) => ({
  stored: `github.com/acme/${name}`,
  spellings: [
    `https://github.com/Acme/${name}.git`,
    `git@github.com:acme/${name}.git`,
    `ssh://git@github.com:22/acme/${name}`,
    `https://user:token@github.com/acme/${name}/`,
    `github.com/acme/${name}`,
  ],
});

const unique = () => crypto.randomUUID().slice(0, 8);

describe("project repositories", () => {
  let fixture: Awaited<ReturnType<typeof createFixture>>,
    domain: Domain,
    owner: Actor,
    other: Actor;
  beforeAll(async () => {
    fixture = await createFixture();
    domain = createDomain(fixture.database);
    const actors = await Promise.all(
      ["owner", "other"].map(async (name) => {
        const { user } = await fixture.auth.api.createUser({
          body: {
            name,
            email: `${name}@repositories.test`,
            password: "Isolated repositories password 42!",
            role: "user",
          },
        });
        return requireRow(await domain.actor(user.id));
      }),
    );
    owner = requireRow(actors[0]);
    other = requireRow(actors[1]);
  });
  afterAll(async () => {
    await fixture?.close();
  });
  const space = (actor = owner): Promise<Workspace> =>
    domain.execute(
      "create_workspace",
      { name: "Repositories", slug: `r-${crypto.randomUUID()}` },
      actor,
    );
  const newProject = (workspace: Workspace, actor = owner) =>
    domain.execute(
      "create_project",
      {
        workspaceId: workspace.id,
        key: `R${crypto.randomUUID().slice(0, 8).toUpperCase()}`,
        name: "Repositories project",
        visibility: "workspace",
      },
      actor,
    );
  const link = async (project: Project, repositories: string[], actor = owner) =>
    domain.execute(
      "update_project",
      {
        projectId: project.id,
        expectedVersion: (await domain.execute("get_project", { projectId: project.id }, actor))
          .version,
        name: project.name,
        description: project.description,
        repositories,
      },
      actor,
    );
  const linked = async (name: string, workspace?: Workspace, actor = owner) => {
    const project = await newProject(workspace ?? (await space(actor)), actor),
      { stored, spellings } = remote(name);
    await link(project, [stored], actor);
    return { project, stored, spellings };
  };

  it("stores normalized remotes and publishes the update in the same write", async () => {
    const project = await newProject(await space()),
      name = unique();
    const updated = await link(project, [`git@github.com:Acme/${name}.git`]);
    expect(updated.repositories).toEqual([`github.com/acme/${name}`]);
    expect(updated.version).toBe(project.version + 1);
    expect(
      (await domain.execute("get_project", { projectId: project.id }, owner)).repositories,
    ).toEqual([`github.com/acme/${name}`]);
    const { items } = await domain.readEvents(owner, 0n);
    expect(
      items.filter((event) => event.projectId === project.id && event.type === "project.updated"),
    ).toHaveLength(1);
    // Omitting the field leaves the list alone; a client can send the stored spelling back.
    const renamed = await domain.execute(
      "update_project",
      {
        projectId: project.id,
        expectedVersion: updated.version,
        name: "Renamed",
        description: "",
      },
      owner,
    );
    expect(renamed.repositories).toEqual(updated.repositories);
    expect((await link(project, renamed.repositories)).repositories).toEqual(updated.repositories);
    await expect(link(project, ["not a url"])).rejects.toMatchObject({ name: "ZodError" });
  });

  it("gives a remote to one unarchived project per workspace", async () => {
    const workspace = await space(),
      { project, stored } = await linked(unique(), workspace),
      rival = await newProject(workspace);
    await expect(link(rival, [stored])).rejects.toMatchObject({
      status: 409,
      code: "duplicate_repository",
    });
    // A project keeps its own remote through later saves.
    await expect(link(project, [stored])).resolves.toMatchObject({ repositories: [stored] });
    // Another workspace can link the same remote.
    const elsewhere = await newProject(await space());
    await expect(link(elsewhere, [stored])).resolves.toMatchObject({ repositories: [stored] });
  });

  it("frees a remote while its holder is archived and refuses a restore or move that would clash", async () => {
    const workspace = await space(),
      { project: archived, stored, spellings } = await linked(unique(), workspace);
    const held = await domain.execute(
      "archive_project",
      {
        projectId: archived.id,
        expectedVersion: (await domain.execute("get_project", { projectId: archived.id }, owner))
          .version,
        archived: true,
      },
      owner,
    );
    const successor = await newProject(workspace);
    await link(successor, [stored]);
    // The live project wins over an archived one, which still answers by ID.
    await expect(
      domain.execute("get_project", { projectId: requireRow(spellings[0]) }, owner),
    ).resolves.toMatchObject({ id: successor.id });
    await expect(
      domain.execute(
        "archive_project",
        { projectId: archived.id, expectedVersion: held.version, archived: false },
        owner,
      ),
    ).rejects.toMatchObject({ status: 409, code: "duplicate_repository" });

    const destination = await space(),
      { stored: taken } = await linked(unique(), destination),
      mover = await newProject(workspace);
    const moving = await link(mover, [taken]);
    const move = { projectId: mover.id, workspaceId: destination.id };
    await expect(domain.execute("get_project_impact", move, owner)).rejects.toMatchObject({
      code: "duplicate_repository",
    });
    await expect(
      domain.execute("transfer_project", { ...move, expectedVersion: moving.version }, owner),
    ).rejects.toMatchObject({ code: "duplicate_repository" });
  });

  it("names a project by any spelling of its remote wherever projectId is accepted", async () => {
    const { project, spellings } = await linked(unique());
    for (const projectId of spellings) {
      await expect(domain.execute("get_project", { projectId }, owner)).resolves.toMatchObject({
        id: project.id,
      });
      const ticket = await domain.execute(
        "create_ticket",
        { projectId, title: `By ${projectId}` },
        owner,
      );
      expect(ticket.projectId).toBe(project.id);
      const { items } = await domain.execute("list_tickets", { projectId }, owner);
      expect(items.map((item) => item.id)).toContain(ticket.id);
    }
    expect(
      (await domain.readEvents(owner, 0n, requireRow(spellings[0]))).items.length,
    ).toBeGreaterThan(0);
  });

  it("answers an unreachable remote like an unknown one", async () => {
    const hidden = await linked(unique());
    const asked = [
      ...hidden.spellings,
      "git@github.com:acme/nothing-links-this.git",
      "a@b",
      "x/ y",
    ];
    for (const projectId of asked) {
      await expect(domain.execute("get_project", { projectId }, other)).rejects.toMatchObject({
        status: 404,
        code: "not_found",
      });
      await expect(domain.readEvents(other, 0n, projectId)).rejects.toMatchObject({
        status: 404,
        code: "not_found",
      });
    }
    // A credential bound to other projects cannot reach it through its remote either.
    const bound = { ...owner, projectIds: [crypto.randomUUID()] };
    await expect(
      domain.execute("get_project", { projectId: requireRow(hidden.spellings[0]) }, bound),
    ).rejects.toMatchObject({ code: "not_found" });
  });

  it("refuses to guess between accessible projects in two workspaces", async () => {
    const name = unique(),
      first = await linked(name),
      second = await linked(name);
    const projectId = requireRow(first.spellings[0]);
    await expect(domain.execute("get_project", { projectId }, owner)).rejects.toMatchObject({
      status: 409,
      code: "ambiguous_project",
      details: { projects: expect.arrayContaining([first.project.key, second.project.key]) },
    });
    // Someone who can reach only one of them gets that one, and a bound credential likewise.
    const theirs = await linked(name, undefined, other);
    await expect(domain.execute("get_project", { projectId }, other)).resolves.toMatchObject({
      id: theirs.project.id,
    });
    await expect(
      domain.execute("get_project", { projectId }, { ...owner, projectIds: [first.project.id] }),
    ).resolves.toMatchObject({ id: first.project.id });
  });
});
