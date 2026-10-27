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
  it("orders projects within their workspace and lets only project administrators move them", async () => {
    const first = await project(),
      second = await project(),
      hidden = await project("private"),
      third = await project();
    const order = async (actor = owner) =>
      (await domain.execute("list_projects", { workspaceId: workspace.id }, actor)).map(
        (row) => row.id,
      );
    expect(await order()).toEqual([first.id, second.id, hidden.id, third.id]);
    const moved = await domain.execute(
      "move_project",
      { projectId: third.id, expectedVersion: third.version, before: first.key },
      owner,
    );
    expect(moved.version).toBe(third.version + 1);
    expect(await order()).toEqual([third.id, first.id, second.id, hidden.id]);
    await membership("admin");
    // A workspace administrator sees the private project too; a writer sees only the others.
    expect(await order(member)).toEqual([third.id, first.id, second.id, hidden.id]);
    await membership("writer");
    expect(await order(member)).toEqual([third.id, first.id, second.id]);
    await expect(
      domain.execute(
        "move_project",
        { projectId: first.id, expectedVersion: first.version, after: second.id },
        member,
      ),
    ).rejects.toMatchObject({ status: 403 });
    await domain.execute(
      "set_member",
      { projectId: first.id, email: "member@workspace.test", role: "admin" },
      owner,
    );
    // The hidden project cannot serve as a neighbor for someone who cannot see it.
    await expect(
      domain.execute(
        "move_project",
        { projectId: first.id, expectedVersion: first.version, after: hidden.id },
        member,
      ),
    ).rejects.toMatchObject({ code: "not_found" });
    await domain.execute(
      "move_project",
      { projectId: first.id, expectedVersion: first.version, after: second.id },
      member,
    );
    expect(await order()).toEqual([third.id, second.id, first.id, hidden.id]);
    // Projects of another workspace are never neighbors, and its order is untouched.
    const other = await domain.execute(
      "create_workspace",
      { name: "Other workspace", slug: `w-${crypto.randomUUID()}` },
      owner,
    );
    const elsewhere = await domain.execute(
      "create_project",
      {
        workspaceId: other.id,
        key: `W${crypto.randomUUID().slice(0, 8).toUpperCase()}`,
        name: "Elsewhere",
      },
      owner,
    );
    await expect(
      domain.execute(
        "move_project",
        { projectId: second.id, expectedVersion: second.version, before: elsewhere.id },
        owner,
      ),
    ).rejects.toMatchObject({ code: "not_found" });
    await expect(
      domain.execute(
        "move_project",
        { projectId: second.id, expectedVersion: second.version + 5, before: third.id },
        owner,
      ),
    ).rejects.toMatchObject({ code: "version_conflict" });
    expect(await order()).toEqual([third.id, second.id, first.id, hidden.id]);
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
  it("shares workspace labels with every project while project labels stay local", async () => {
    const first = await project(),
      second = await project(),
      hidden = await project("private");
    await membership("writer");
    const local = await domain.execute(
      "create_project_label",
      { projectId: first.id, name: "local", color: "green" },
      owner,
    );
    await expect(
      domain.execute(
        "create_workspace_label",
        { workspaceId: workspace.id, name: "shared", color: "blue" },
        owner,
      ),
    ).resolves.toMatchObject({ workspaceId: workspace.id, name: "shared", color: "blue" });
    const catalog = async (projectId: string, actor = owner) =>
      (await domain.execute("list_project_labels", { projectId }, actor)).map(
        ({ scope, name, color, count }) => ({ scope, name, color, count }),
      );
    expect(await catalog(first.id)).toEqual([
      { scope: "project", name: "local", color: "green", count: 0 },
      { scope: "workspace", name: "shared", color: "blue", count: 0 },
    ]);
    expect(await catalog(second.id, member)).toEqual([
      { scope: "workspace", name: "shared", color: "blue", count: 0 },
    ]);
    // Choosing a workspace label on a ticket never registers a same-name project label.
    await domain.execute(
      "create_ticket",
      { projectId: second.id, title: "Shared and freeform", labels: ["shared", "fresh"] },
      member,
    );
    await domain.execute(
      "create_ticket",
      { projectId: hidden.id, title: "Private usage", labels: ["shared"] },
      owner,
    );
    expect(await catalog(second.id)).toEqual([
      { scope: "project", name: "fresh", color: "gray", count: 1 },
      { scope: "workspace", name: "shared", color: "blue", count: 1 },
    ]);
    // Counts follow the reader's actual project access, so private usage stays hidden.
    const counts = async (actor: Actor) =>
      (await domain.execute("list_workspace_labels", { workspaceId: workspace.id }, actor)).map(
        ({ name, count }) => ({ name, count }),
      );
    expect(await counts(owner)).toEqual([{ name: "shared", count: 2 }]);
    expect(await counts(member)).toEqual([{ name: "shared", count: 1 }]);
    await expect(counts(outsider)).rejects.toMatchObject({ status: 404 });
    await membership("admin");
    expect(await counts(member)).toEqual([{ name: "shared", count: 2 }]);
    await membership("writer");
    expect(await counts(member)).toEqual([{ name: "shared", count: 1 }]);
    // Same names never silently merge across scopes.
    await expect(
      domain.execute("create_project_label", { projectId: first.id, name: "shared" }, owner),
    ).rejects.toMatchObject({ status: 409, code: "duplicate_label" });
    await expect(
      domain.execute(
        "update_project_label",
        {
          projectId: first.id,
          labelId: local.id,
          expectedVersion: 1,
          name: "shared",
          color: "green",
        },
        owner,
      ),
    ).rejects.toMatchObject({ status: 409, code: "duplicate_label" });
    await expect(
      domain.execute("create_workspace_label", { workspaceId: workspace.id, name: "local" }, owner),
    ).rejects.toMatchObject({
      status: 409,
      code: "label_conflict",
      details: { projects: [first.key] },
    });
    await expect(
      domain.execute("create_workspace_label", { workspaceId: workspace.id, name: "x" }, member),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      domain.execute(
        "update_project_label",
        {
          projectId: first.id,
          labelId: requireRow(
            (await domain.execute("list_project_labels", { projectId: first.id }, owner)).find(
              (label) => label.scope === "workspace",
            ),
          ).id,
          expectedVersion: 1,
          name: "renamed",
          color: "red",
        },
        owner,
      ),
    ).rejects.toMatchObject({ status: 404 });
  });
  it.each(["project", "workspace"] as const)(
    "administers %s labels without taking ticket worker claims",
    async (scope) => {
      const first = await project(),
        second = scope === "workspace" ? await project() : first;
      const label =
        scope === "workspace"
          ? await domain.execute(
              "create_workspace_label",
              { workspaceId: workspace.id, name: "managed" },
              owner,
            )
          : await domain.execute(
              "create_project_label",
              { projectId: first.id, name: "managed" },
              owner,
            );
      const admin = await domain.actor(owner.id, { ownerId: "label-admin", scopes: ["admin"] }),
        worker = await domain.actor(owner.id, { ownerId: "ticket-worker", scopes: ["admin"] });
      const rename = (actor: Actor, expectedVersion: number, name: string) =>
        scope === "workspace"
          ? domain.execute(
              "update_workspace_label",
              {
                workspaceId: workspace.id,
                labelId: label.id,
                expectedVersion,
                name,
                color: "blue",
              },
              actor,
            )
          : domain.execute(
              "update_project_label",
              { projectId: first.id, labelId: label.id, expectedVersion, name, color: "blue" },
              actor,
            );
      const remove = (actor: Actor, expectedVersion: number) =>
        scope === "workspace"
          ? domain.execute(
              "delete_workspace_label",
              { workspaceId: workspace.id, labelId: label.id, expectedVersion },
              actor,
            )
          : domain.execute(
              "delete_project_label",
              { projectId: first.id, labelId: label.id, expectedVersion },
              actor,
            );
      const selected = [];
      for (const state of ["completed", "live", "expired"]) {
        const projectId = state === "completed" ? first.id : second.id;
        const ticket = await domain.execute(
          "create_ticket",
          {
            projectId,
            title: state,
            labels: ["managed", "keep"],
            description: "Synthetic claim-protected work.",
            acceptanceCriteria: "Keep ownership and readiness.",
            difficulty: "low",
            automationReady: true,
          },
          owner,
        );
        const claim = await domain.execute(
          "claim_ticket",
          {
            projectId,
            ticketId: ticket.id,
            expectedVersion: ticket.version,
            workerId: `worker-${state}`,
          },
          worker,
        );
        if (state === "completed") {
          const claimed = await domain.execute(
            "get_ticket",
            { projectId, ticketId: ticket.id },
            owner,
          );
          await domain.execute(
            "update_ticket",
            {
              projectId,
              ticketId: ticket.id,
              expectedVersion: claimed.ticket.version,
              changes: { status: "done" },
              claimId: claim.id,
            },
            worker,
          );
          await domain.execute(
            "release_claim",
            { projectId, ticketId: ticket.id, claimId: claim.id },
            worker,
          );
        } else if (state === "expired") {
          await fixture.database.pool.query(
            "UPDATE claims SET expires_at = '2000-01-01' WHERE id = $1",
            [claim.id],
          );
        }
        selected.push(
          await domain.execute("get_ticket", { projectId, ticketId: ticket.id }, owner),
        );
      }
      const view = await domain.execute(
        "save_view",
        {
          projectId: second.id,
          name: "Managed work",
          filters: { label: ["managed", "keep"], labelNot: ["ignore"], status: "todo" },
        },
        owner,
      );
      const feed = await domain.execute(
        "create_calendar_feed",
        {
          projectId: second.id,
          name: "Managed schedule",
          labels: ["managed"],
          timeZone: "UTC",
        },
        owner,
      );
      const cursors = await Promise.all(
        [...new Set([first.id, second.id])].map(async (projectId) => ({
          projectId,
          cursor: BigInt((await domain.snapshot(owner, projectId)).cursor),
        })),
      );
      await membership("writer");
      const denied = await domain.actor(member.id, {
        ownerId: "not-a-label-admin",
        scopes: ["admin"],
      });
      await expect(rename(denied, label.version, "forbidden")).rejects.toMatchObject({
        status: 403,
      });
      await expect(remove(denied, label.version)).rejects.toMatchObject({ status: 403 });
      await expect(rename(admin, label.version + 1, "stale")).rejects.toMatchObject({
        code: "version_conflict",
      });
      const renamed = await rename(admin, label.version, "renamed");
      for (const before of selected) {
        const after = await domain.execute(
          "get_ticket",
          { projectId: before.ticket.projectId, ticketId: before.ticket.id },
          owner,
        );
        expect(after.ticket).toEqual({
          ...before.ticket,
          labels: ["renamed", "keep"],
          version: before.ticket.version + 1,
          updatedAt: after.ticket.updatedAt,
        });
        expect(after.claim).toEqual(before.claim);
        await expect(
          domain.execute(
            "update_ticket",
            {
              projectId: after.ticket.projectId,
              ticketId: after.ticket.id,
              expectedVersion: after.ticket.version,
              changes: { labels: ["worker-edit"] },
            },
            admin,
          ),
        ).rejects.toMatchObject({ code: "claim_conflict" });
        await expect(
          domain.execute(
            "bulk_update_tickets",
            {
              projectId: after.ticket.projectId,
              tickets: [{ ticketId: after.ticket.id, expectedVersion: after.ticket.version }],
              changes: { labels: ["worker-edit"] },
            },
            admin,
          ),
        ).rejects.toMatchObject({ code: "claim_conflict" });
      }
      expect(
        (await domain.execute("list_views", { projectId: second.id }, owner)).find(
          (row) => row.id === view.id,
        )?.filters,
      ).toMatchObject({ label: ["renamed", "keep"], labelNot: ["ignore"], status: "todo" });
      expect(
        (await domain.execute("list_calendar_feeds", { projectId: second.id }, owner)).find(
          (row) => row.id === feed.id,
        )?.labels,
      ).toEqual(["renamed"]);
      await expect(remove(admin, label.version)).rejects.toMatchObject({
        code: "version_conflict",
      });
      await remove(admin, renamed.version);
      for (const before of selected) {
        const after = await domain.execute(
          "get_ticket",
          { projectId: before.ticket.projectId, ticketId: before.ticket.id },
          owner,
        );
        expect(after.ticket).toEqual({
          ...before.ticket,
          labels: ["keep"],
          version: before.ticket.version + 2,
          updatedAt: after.ticket.updatedAt,
        });
        expect(after.claim).toEqual(before.claim);
      }
      expect(
        (await domain.execute("list_views", { projectId: second.id }, owner)).find(
          (row) => row.id === view.id,
        )?.filters,
      ).toMatchObject({ label: ["keep"], labelNot: ["ignore"], status: "todo" });
      // Deleting a feed label never widens the schedule it shares.
      expect(
        (await domain.execute("list_calendar_feeds", { projectId: second.id }, owner)).find(
          (row) => row.id === feed.id,
        )?.labels,
      ).toEqual(["renamed"]);
      for (const { projectId, cursor } of cursors) {
        const events = (await domain.readEvents(owner, cursor, projectId)).items;
        const changed = events.filter((event) => event.type === "ticket.updated");
        expect(changed).toHaveLength(
          selected.filter((row) => row.ticket.projectId === projectId).length * 2,
        );
        expect(
          changed.every(
            (event) => JSON.stringify(event.data.changedFields) === JSON.stringify(["labels"]),
          ),
        ).toBe(true);
        expect(
          events.filter((event) => event.type.startsWith("label.")).map((event) => event.type),
        ).toEqual(["label.updated", "label.deleted"]);
      }
    },
  );
  it("relabels one ticket for label administrators without taking worker claims", async () => {
    const shared = await project(),
      foreign = await project();
    const admin = await domain.actor(owner.id, { ownerId: "label-admin", scopes: ["admin"] }),
      worker = await domain.actor(owner.id, { ownerId: "ticket-worker", scopes: ["admin"] });
    const selected = [];
    for (const state of ["completed", "live", "expired"]) {
      const ticket = await domain.execute(
        "create_ticket",
        {
          projectId: shared.id,
          title: state,
          labels: ["managed", "keep"],
          scopes: ["server"],
          description: "Synthetic claim-protected work.",
          acceptanceCriteria: "Keep ownership and readiness.",
          difficulty: "low",
          automationReady: true,
        },
        owner,
      );
      const claim = await domain.execute(
        "claim_ticket",
        {
          projectId: shared.id,
          ticketId: ticket.id,
          expectedVersion: ticket.version,
          workerId: `worker-${state}`,
        },
        worker,
      );
      if (state === "completed") {
        const claimed = await domain.execute(
          "get_ticket",
          { projectId: shared.id, ticketId: ticket.id },
          owner,
        );
        await domain.execute(
          "update_ticket",
          {
            projectId: shared.id,
            ticketId: ticket.id,
            expectedVersion: claimed.ticket.version,
            changes: { status: "done" },
            claimId: claim.id,
          },
          worker,
        );
        await domain.execute(
          "release_claim",
          { projectId: shared.id, ticketId: ticket.id, claimId: claim.id },
          worker,
        );
      } else if (state === "expired") {
        await fixture.database.pool.query(
          "UPDATE claims SET expires_at = '2000-01-01' WHERE id = $1",
          [claim.id],
        );
      }
      selected.push(
        await domain.execute("get_ticket", { projectId: shared.id, ticketId: ticket.id }, owner),
      );
    }
    const read = (ticketId: string) =>
      domain.execute("get_ticket", { projectId: shared.id, ticketId }, owner);
    const relabel = (
      actor: Actor,
      ticket: { id: string; version: number },
      labels: string[],
      extra: Record<string, unknown> = {},
    ) =>
      domain.execute(
        "update_ticket_labels",
        {
          projectId: shared.id,
          ticketId: ticket.id,
          expectedVersion: ticket.version,
          labels,
          ...extra,
        },
        actor,
      );
    const cursor = BigInt((await domain.snapshot(owner, shared.id)).cursor);
    const target = requireRow(selected[1]).ticket;
    await membership("writer");
    const writer = await domain.actor(member.id, { ownerId: "writer", scopes: ["admin"] }),
      narrow = await domain.actor(owner.id, { ownerId: "narrow", scopes: ["write", "claim"] }),
      elsewhere = await domain.actor(owner.id, {
        ownerId: "elsewhere",
        scopes: ["admin"],
        projectIds: [foreign.id],
      });
    await expect(relabel(writer, target, ["denied"])).rejects.toMatchObject({ status: 403 });
    await expect(relabel(narrow, target, ["denied"])).rejects.toMatchObject({
      status: 403,
      code: "insufficient_scope",
    });
    await expect(relabel(elsewhere, target, ["denied"])).rejects.toMatchObject({ status: 404 });
    await expect(relabel(outsider, target, ["denied"])).rejects.toMatchObject({ status: 404 });
    await expect(
      domain.execute(
        "update_ticket_labels",
        { projectId: foreign.id, ticketId: target.id, expectedVersion: target.version, labels: [] },
        admin,
      ),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      relabel(admin, { ...target, version: target.version + 1 }, ["stale"]),
    ).rejects.toMatchObject({ code: "version_conflict" });
    // Labels are the only change this operation carries.
    for (const extra of [
      { status: "done" },
      { automationReady: false },
      { holdReason: "Not mine to hold" },
      { scopes: [] },
      { title: "Renamed" },
      { changes: { labels: ["denied"] } },
      { claimId: crypto.randomUUID() },
    ])
      await expect(relabel(admin, target, ["denied"], extra)).rejects.toMatchObject({
        name: "ZodError",
      });
    expect(await read(target.id)).toEqual(selected[1]);
    for (const before of selected) {
      const requestId = crypto.randomUUID();
      const relabeled = await relabel(admin, before.ticket, ["relabeled", "keep"], { requestId });
      // A retry returns the committed result instead of conflicting on the old version.
      expect(await relabel(admin, before.ticket, ["relabeled", "keep"], { requestId })).toEqual(
        relabeled,
      );
      const after = await read(before.ticket.id);
      expect(after.ticket).toEqual({
        ...before.ticket,
        labels: ["relabeled", "keep"],
        version: before.ticket.version + 1,
        updatedAt: after.ticket.updatedAt,
      });
      expect(relabeled).toEqual(after.ticket);
      expect(after.claim).toEqual(before.claim);
      expect(after.readiness).toEqual(before.readiness);
      const cleared = await relabel(admin, after.ticket, []);
      expect(cleared).toEqual({
        ...after.ticket,
        labels: [],
        version: after.ticket.version + 1,
        updatedAt: cleared.updatedAt,
      });
      expect((await read(before.ticket.id)).claim).toEqual(before.claim);
      // Ordinary edits keep enforcing worker ownership, even for labels alone.
      await expect(
        domain.execute(
          "update_ticket",
          {
            projectId: shared.id,
            ticketId: cleared.id,
            expectedVersion: cleared.version,
            changes: { labels: ["worker-edit"] },
          },
          admin,
        ),
      ).rejects.toMatchObject({ code: "claim_conflict" });
      await expect(
        domain.execute(
          "bulk_update_tickets",
          {
            projectId: shared.id,
            tickets: [{ ticketId: cleared.id, expectedVersion: cleared.version }],
            changes: { labels: ["worker-edit"] },
          },
          admin,
        ),
      ).rejects.toMatchObject({ code: "claim_conflict" });
    }
    expect(
      (await domain.execute("list_project_labels", { projectId: shared.id }, owner)).map(
        (label) => label.name,
      ),
    ).toContain("relabeled");
    const changed = (await domain.readEvents(owner, cursor, shared.id)).items.filter(
      (event) => event.type === "ticket.updated",
    );
    expect(changed).toHaveLength(selected.length * 2);
    expect(
      changed.every(
        (event) => JSON.stringify(event.data.changedFields) === JSON.stringify(["labels"]),
      ),
    ).toBe(true);
  });
  it("renames, adopts, and deletes workspace labels across projects in one versioned write", async () => {
    const first = await project(),
      second = await project();
    const creation = {
      workspaceId: workspace.id,
      name: "shared",
      color: "blue",
      requestId: crypto.randomUUID(),
    };
    const shared = await domain.execute("create_workspace_label", creation, owner);
    expect(await domain.execute("create_workspace_label", creation, owner)).toEqual(shared);
    const one = await domain.execute(
      "create_ticket",
      { projectId: first.id, title: "First", labels: ["shared", "local"] },
      owner,
    );
    const two = await domain.execute(
      "create_ticket",
      {
        projectId: second.id,
        title: "Second",
        labels: ["shared"],
        description: "Claimable work.",
        acceptanceCriteria: "The claim holds.",
        difficulty: "low",
        automationReady: true,
      },
      owner,
    );
    await domain.execute(
      "save_view",
      { projectId: second.id, name: "Shared work", filters: { label: ["shared"] } },
      owner,
    );
    const cursor = BigInt((await domain.snapshot(owner, second.id)).cursor);
    const renamed = await domain.execute(
      "update_workspace_label",
      {
        workspaceId: workspace.id,
        labelId: shared.id,
        expectedVersion: 1,
        name: "common",
        color: "orange",
      },
      owner,
    );
    expect(renamed).toMatchObject({ name: "common", color: "orange", version: 2 });
    const read = async (projectId: string, ticketId: string) =>
      (await domain.execute("get_ticket", { projectId, ticketId }, owner)).ticket;
    expect(await read(first.id, one.id)).toMatchObject({
      labels: ["common", "local"],
      version: 2,
    });
    expect(await read(second.id, two.id)).toMatchObject({ labels: ["common"], version: 2 });
    expect(
      (await domain.execute("list_views", { projectId: second.id }, owner))[0]?.filters,
    ).toMatchObject({ label: ["common"] });
    expect(
      (await domain.readEvents(owner, cursor, second.id)).items.map((event) => event.type),
    ).toEqual(["ticket.updated", "label.updated"]);
    await expect(
      domain.execute(
        "update_workspace_label",
        {
          workspaceId: workspace.id,
          labelId: shared.id,
          expectedVersion: 1,
          name: "stale",
          color: "red",
        },
        owner,
      ),
    ).rejects.toMatchObject({ code: "version_conflict" });
    // Ticket ownership does not grant label administration; a missing admin scope rolls back.
    const claimer = await domain.actor(owner.id, { ownerId: "agent-a", scopes: ["admin"] });
    const other = await domain.actor(owner.id, { ownerId: "agent-b", scopes: ["write", "claim"] });
    const claim = await domain.execute(
      "claim_ticket",
      { projectId: second.id, ticketId: two.id, workerId: "a", expectedVersion: 2 },
      claimer,
    );
    await expect(
      domain.execute(
        "update_workspace_label",
        {
          workspaceId: workspace.id,
          labelId: shared.id,
          expectedVersion: 2,
          name: "blocked",
          color: "red",
        },
        other,
      ),
    ).rejects.toMatchObject({ status: 403, code: "insufficient_scope" });
    expect(await read(first.id, one.id)).toMatchObject({ labels: ["common", "local"], version: 2 });
    expect(
      (await domain.execute("list_workspace_labels", { workspaceId: workspace.id }, owner))[0],
    ).toMatchObject({ name: "common", version: 2 });
    await domain.execute(
      "release_claim",
      { projectId: second.id, ticketId: two.id, claimId: claim.id },
      claimer,
    );
    // Renaming onto a project label needs explicit adoption; the project definition is replaced.
    const adopt = {
      workspaceId: workspace.id,
      labelId: shared.id,
      expectedVersion: 2,
      name: "local",
      color: "purple",
    };
    await expect(domain.execute("update_workspace_label", adopt, owner)).rejects.toMatchObject({
      code: "label_conflict",
      details: { projects: [first.key] },
    });
    await domain.execute("update_workspace_label", { ...adopt, adopt: true }, owner);
    expect(await read(first.id, one.id)).toMatchObject({ labels: ["local"], version: 3 });
    expect(
      (await domain.execute("list_project_labels", { projectId: first.id }, owner)).map(
        ({ scope, name, color, count }) => ({ scope, name, color, count }),
      ),
    ).toEqual([{ scope: "workspace", name: "local", color: "purple", count: 1 }]);
    await domain.execute(
      "delete_workspace_label",
      { workspaceId: workspace.id, labelId: shared.id, expectedVersion: 3 },
      owner,
    );
    expect(await read(first.id, one.id)).toMatchObject({ labels: [], version: 4 });
    expect((await read(second.id, two.id)).labels).toEqual([]);
    expect(await domain.execute("list_project_labels", { projectId: second.id }, owner)).toEqual(
      [],
    );
    expect(
      (await domain.execute("list_views", { projectId: second.id }, owner))[0]?.filters,
    ).not.toHaveProperty("label");
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
    // The creator owns the workspace and hands it on before leaving.
    await domain.execute(
      "transfer_workspace",
      { workspaceId: space.id, userId: successor.id, expectedVersion: 2 },
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
