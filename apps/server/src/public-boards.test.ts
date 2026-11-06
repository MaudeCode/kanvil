import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { eventLabels } from "@kanvil/contracts";
import { createApplication } from "./app.ts";
import { createFixture } from "./test-fixture.ts";
import type { Actor } from "./domain.ts";

const publishedColumns = [
  "project_id",
  "key",
  "title",
  "kind",
  "status",
  "created_at",
  "updated_at",
];

describe("public boards", () => {
  let fixture: Awaited<ReturnType<typeof createFixture>>,
    application: Awaited<ReturnType<typeof createApplication>>,
    owner: Actor,
    writer: Actor,
    writerEmail: string;
  const execute: typeof application.domain.execute = (...call) =>
    application.domain.execute(...call);
  const query = <Row extends Record<string, unknown>>(statement: string, values: unknown[] = []) =>
    fixture.database.pool.query<Row>(statement, values).then((result) => result.rows);
  const request = (path: string) =>
    application.app.fetch(new Request(`${fixture.config.KANVIL_URL}${path}`));

  beforeAll(async () => {
    fixture = await createFixture();
    application = await createApplication(fixture.database, fixture.config);
    const people = await Promise.all(
      ["owner", "writer"].map((name) =>
        fixture.auth.api.createUser({
          body: {
            name,
            email: `board-${name}@example.test`,
            password: "Isolated board password 42!",
            role: name === "owner" ? "admin" : "user",
          },
        }),
      ),
    );
    owner = await application.domain.actor(people[0]!.user.id);
    writer = await application.domain.actor(people[1]!.user.id);
    writerEmail = people[1]!.user.email;
  });
  afterAll(async () => {
    await application?.close();
    await fixture?.close();
  });

  const newProject = () =>
    execute(
      "create_project",
      { key: `B${crypto.randomUUID().slice(0, 8).toUpperCase()}`, name: "Board project" },
      owner,
    );
  const newTicket = (projectId: string, labels: string[], fields: object = {}) =>
    execute("create_ticket", { projectId, title: "Published title", labels, ...fields }, owner);
  const save = (
    projectId: string,
    expectedVersion: number | null,
    fields: { enabled?: boolean; labels?: string[]; excludedLabels?: string[] } = {},
    actor = owner,
  ) =>
    execute(
      "update_project_board",
      {
        projectId,
        expectedVersion,
        title: "Accepted reports",
        enabled: true,
        labels: ["published"],
        excludedLabels: ["private"],
        ...fields,
      },
      actor,
    );
  const published = (projectId: string) =>
    query<{ key: string }>(`SELECT * FROM public_board_tickets WHERE project_id = $1`, [projectId]);
  const summaries = (projectId: string) =>
    query<{ title: string }>(`SELECT * FROM public_board_summaries WHERE project_id = $1`, [
      projectId,
    ]);
  const board = async (projectId: string) =>
    (await execute("get_project_board", { projectId }, owner)).board;
  const newLabel = (projectId: string, name: string) =>
    execute("create_project_label", { projectId, name, color: "red" }, owner);

  it("publishes only the metadata columns, through security-barrier views", async () => {
    const project = await newProject();
    await save(project.id, null);
    await newTicket(project.id, ["published", "marker-label"], {
      description: "marker-description",
      acceptanceCriteria: "marker-acceptance",
      scopes: ["marker-scope"],
    });
    const columns = async (view: string) =>
      (
        await query<{ column_name: string }>(
          `SELECT column_name FROM information_schema.columns WHERE table_name = $1`,
          [view],
        )
      )
        .map((row) => row.column_name)
        .toSorted();
    expect(await columns("public_board_tickets")).toEqual(publishedColumns.toSorted());
    expect(await columns("public_board_candidates")).toEqual(publishedColumns.toSorted());
    expect(await columns("public_board_summaries")).toEqual(["project_id", "title"]);
    const rows = await published(project.id);
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows)).not.toContain("marker-");
    const barriers = await query<{ relname: string }>(
      `SELECT relname FROM pg_class
        WHERE relname LIKE 'public_board\\_%' AND relkind = 'v'
          AND 'security_barrier=true' = ANY(reloptions)`,
    );
    expect(barriers.map((row) => row.relname).toSorted()).toEqual([
      "public_board_candidates",
      "public_board_summaries",
      "public_board_tickets",
    ]);
  });

  // Each case starts from a published ticket, so its absence afterwards is the change's doing.
  type Published = {
    project: Awaited<ReturnType<typeof newProject>>;
    ticket: Awaited<ReturnType<typeof newTicket>>;
  };
  const relabel = ({ project, ticket }: Published, labels: string[]) =>
    execute(
      "update_ticket_labels",
      { projectId: project.id, ticketId: ticket.id, expectedVersion: ticket.version, labels },
      owner,
    );
  const change = ({ project, ticket }: Published, changes: object) =>
    execute(
      "update_ticket",
      { projectId: project.id, ticketId: ticket.id, expectedVersion: ticket.version, changes },
      owner,
    );
  it.each<[string, (state: Published) => Promise<unknown>, { summary: boolean }]>([
    ["lacks every board label", (state) => relabel(state, ["other"]), { summary: true }],
    [
      "carries an excluded label too",
      (state) => relabel(state, ["published", "private"]),
      { summary: true },
    ],
    ["is archived", (state) => change(state, { archived: true }), { summary: true }],
    ["is held", (state) => change(state, { holdReason: "Under review" }), { summary: true }],
    [
      "moved to another project",
      async ({ project, ticket }) => {
        const destination = await newProject();
        await execute(
          "relocate_ticket",
          {
            projectId: project.id,
            ticketId: ticket.id,
            expectedVersion: ticket.version,
            destinationProjectId: destination.id,
          },
          owner,
        );
      },
      { summary: true },
    ],
    [
      "is in an archived project",
      ({ project }) =>
        execute(
          "archive_project",
          { projectId: project.id, expectedVersion: project.version, archived: true },
          owner,
        ),
      { summary: false },
    ],
    [
      "is in a deleted project",
      ({ project }) => query(`UPDATE projects SET deleted_at = now() WHERE id = $1`, [project.id]),
      { summary: false },
    ],
    [
      "is on a disabled board",
      ({ project }) => save(project.id, 1, { enabled: false }),
      { summary: false },
    ],
    [
      "is on a board with no labels",
      ({ project }) =>
        query(`UPDATE public_boards SET labels = '{}' WHERE project_id = $1`, [project.id]),
      { summary: true },
    ],
  ])("keeps a ticket off the board when it %s", async (_name, apply, { summary }) => {
    const project = await newProject();
    await save(project.id, null);
    const ticket = await newTicket(project.id, ["published"]);
    expect(await published(project.id)).toHaveLength(1);
    expect(await summaries(project.id)).toHaveLength(1);
    await apply({ project, ticket });
    expect(await published(project.id)).toEqual([]);
    expect(await summaries(project.id)).toHaveLength(summary ? 1 : 0);
  });

  it("lets a role granted only the views read them and nothing underneath", async () => {
    const project = await newProject();
    await save(project.id, null);
    await newTicket(project.id, ["published"]);
    const client = await fixture.database.pool.connect();
    const denied = async (relation: string) => {
      await client.query("SAVEPOINT attempt");
      await expect(client.query(`SELECT * FROM ${relation} LIMIT 1`)).rejects.toThrow(
        "permission denied",
      );
      await client.query("ROLLBACK TO SAVEPOINT attempt");
    };
    try {
      // Roles belong to the server, so this one rolls back with the transaction.
      await client.query("BEGIN");
      await client.query("CREATE ROLE board_reader NOLOGIN");
      await client.query(
        "GRANT SELECT ON public_board_tickets, public_board_summaries TO board_reader",
      );
      await client.query("SET LOCAL ROLE board_reader");
      for (const view of ["public_board_tickets", "public_board_summaries"])
        expect(
          (await client.query(`SELECT * FROM ${view} WHERE project_id = $1`, [project.id]))
            .rowCount,
        ).toBe(1);
      for (const relation of [
        "tickets",
        "projects",
        "public_boards",
        "public_board_candidates",
        '"user"',
        '"session"',
      ])
        await denied(relation);
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
  });

  it("guards the operations with sharing permission, versions, and validation", async () => {
    const project = await newProject();
    await execute(
      "set_member",
      { projectId: project.id, email: writerEmail, role: "writer" },
      owner,
    );
    await expect(
      execute("get_project_board", { projectId: project.id }, writer),
    ).rejects.toMatchObject({ status: 403 });
    await expect(save(project.id, null, {}, writer)).rejects.toMatchObject({ status: 403 });
    await expect(save(project.id, null, { labels: [] })).rejects.toMatchObject({
      status: 400,
      code: "validation_error",
    });
    expect(await board(project.id)).toBeNull();
    const created = await save(project.id, null);
    expect(created.version).toBe(1);
    await expect(save(project.id, null)).rejects.toMatchObject({
      status: 409,
      code: "version_conflict",
    });
    await expect(save(project.id, 5)).rejects.toMatchObject({
      status: 409,
      code: "version_conflict",
    });
    const updated = await save(project.id, created.version, { excludedLabels: [] });
    expect(updated).toMatchObject({ version: 2, excludedLabels: [] });
    // An archived project still lets an administrator turn the board off before restoring it.
    const { version } = await execute("get_project", { projectId: project.id }, owner);
    await execute(
      "archive_project",
      { projectId: project.id, expectedVersion: version, archived: true },
      owner,
    );
    await expect(save(project.id, 2, { enabled: false })).resolves.toMatchObject({
      enabled: false,
    });
  });

  it("previews a disabled board and adds no anonymous route", async () => {
    const project = await newProject();
    await expect(execute("get_project_board", { projectId: project.id }, owner)).resolves.toEqual({
      board: null,
      tickets: [],
    });
    await save(project.id, null, { enabled: false });
    const ticket = await newTicket(project.id, ["published"], {
      description: "marker-description",
    });
    await newTicket(project.id, ["published", "private"]);
    const preview = await execute("get_project_board", { projectId: project.id }, owner);
    expect(preview.board).toMatchObject({ enabled: false, title: "Accepted reports" });
    expect(preview.tickets).toEqual([
      {
        projectId: project.id,
        key: ticket.key,
        title: "Published title",
        kind: ticket.kind,
        status: ticket.status,
        createdAt: ticket.createdAt,
        updatedAt: ticket.updatedAt,
      },
    ]);
    expect(await published(project.id)).toEqual([]);
    // An enabled board publishes through its own process, never through these routes.
    await save(project.id, 1);
    expect((await request(`/api/v1/projects/${project.id}/public-board`)).status).toBe(401);
    for (const path of ["", "/public-board", "/tickets"])
      expect((await request(`/api/public/projects/${project.id}${path}`)).status).toBe(404);
  });

  it("carries label renames and merges into both filters", async () => {
    const project = await newProject();
    const kept = await newLabel(project.id, "published");
    const hidden = await newLabel(project.id, "private");
    await save(project.id, null);
    await execute(
      "update_project_label",
      {
        projectId: project.id,
        labelId: kept.id,
        name: "accepted",
        color: "red",
        expectedVersion: kept.version,
      },
      owner,
    );
    await execute(
      "update_project_label",
      {
        projectId: project.id,
        labelId: hidden.id,
        name: "restricted",
        color: "red",
        expectedVersion: hidden.version,
      },
      owner,
    );
    // Two renames, so an administrator's edit from before them is stale.
    expect(await board(project.id)).toMatchObject({
      labels: ["accepted"],
      excludedLabels: ["restricted"],
      version: 3,
    });
    // A workspace label adopting the name merges the two names into one entry.
    const shared = await execute(
      "create_workspace_label",
      { workspaceId: project.workspaceId, name: "shared", color: "red" },
      owner,
    );
    await save(project.id, 3, { labels: ["accepted", "shared"], excludedLabels: [] });
    await execute(
      "update_workspace_label",
      {
        workspaceId: project.workspaceId,
        labelId: shared.id,
        name: "accepted",
        color: "red",
        expectedVersion: shared.version,
        adopt: true,
      },
      owner,
    );
    expect((await board(project.id))?.labels).toEqual(["accepted"]);
  });

  it("refuses to delete a label an enabled board excludes", async () => {
    const project = await newProject();
    const hidden = await newLabel(project.id, "private");
    const shown = await newLabel(project.id, "published");
    await save(project.id, null);
    const ticket = await newTicket(project.id, ["published", "private"]);
    const remove = (label: typeof hidden) =>
      execute(
        "delete_project_label",
        { projectId: project.id, labelId: label.id, expectedVersion: label.version },
        owner,
      );
    await expect(remove(hidden)).rejects.toMatchObject({ status: 409, code: "label_in_use" });
    expect(await published(project.id)).toEqual([]);
    expect(
      (await execute("get_ticket", { projectId: project.id, ticketId: ticket.id }, owner)).ticket
        .labels,
    ).toEqual(["published", "private"]);
    // An included name stays and matches nothing, and a disabled board publishes nothing to widen.
    await remove(shown);
    expect((await board(project.id))?.labels).toEqual(["published"]);
    await save(project.id, 1, { enabled: false });
    await expect(remove(hidden)).resolves.toEqual({ ok: true });
  });

  it("rolls back a workspace label deletion that an enabled board blocks", async () => {
    const projects = [await newProject(), await newProject()];
    // In the order label changes visit projects, so the ticket is rewritten before the board refuses.
    const [first, second] = await query<{ id: string }>(
      `SELECT id FROM projects WHERE id = ANY($1::uuid[]) ORDER BY position, id`,
      [projects.map((project) => project.id)],
    );
    const workspaceId = projects[0]!.workspaceId;
    const label = await execute(
      "create_workspace_label",
      { workspaceId, name: "workspace-private", color: "red" },
      owner,
    );
    const ticket = await newTicket(first!.id, ["workspace-private"]);
    await save(second!.id, null, { excludedLabels: ["workspace-private"] });
    await expect(
      execute(
        "delete_workspace_label",
        { workspaceId, labelId: label.id, expectedVersion: label.version },
        owner,
      ),
    ).rejects.toMatchObject({ status: 409, code: "label_in_use" });
    const after = await execute("get_ticket", { projectId: first!.id, ticketId: ticket.id }, owner);
    expect(after.ticket).toMatchObject({ labels: ["workspace-private"], version: ticket.version });
    const names = await execute("list_workspace_labels", { workspaceId }, owner);
    expect(names.map((row) => row.name)).toContain("workspace-private");
  });

  it("publishes its event with the write, and only then", async () => {
    const project = await newProject();
    const events = () =>
      query<{ type: string; ticket_id: string | null; data: object }>(
        `SELECT type, ticket_id, data FROM events
          WHERE project_id = $1 AND type = 'public_board.updated'`,
        [project.id],
      );
    await save(project.id, null);
    await expect(save(project.id, 9)).rejects.toMatchObject({ code: "version_conflict" });
    expect(await events()).toEqual([
      {
        type: "public_board.updated",
        ticket_id: null,
        data: expect.objectContaining({
          enabled: true,
          title: "Accepted reports",
          labels: ["published"],
          excludedLabels: ["private"],
          version: 1,
        }),
      },
    ]);
    expect(eventLabels["public_board.updated"]).toBe("Public board updated");
  });

  it("removes the board with its project and names it as left out of exports", async () => {
    const project = await newProject();
    await save(project.id, null);
    const bundle = await execute("export_project", { projectId: project.id }, owner);
    expect(bundle.completeness.omitted).toContainEqual(
      expect.objectContaining({
        content: "project settings",
        reason: expect.stringContaining("public board"),
      }),
    );
    await execute(
      "delete_project",
      { projectId: project.id, expectedVersion: project.version, confirmKey: project.key },
      owner,
    );
    expect(await query(`SELECT 1 FROM public_boards WHERE project_id = $1`, [project.id])).toEqual(
      [],
    );
  });
});
