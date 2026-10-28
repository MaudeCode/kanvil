import { afterAll, beforeAll, describe, expect, it, vi } from "vite-plus/test";
import { createFixture } from "./test-fixture.ts";
import { createApplication } from "./app.ts";
import type { Actor } from "./domain.ts";

const endpoint = process.env.TEST_ELASTICSEARCH_URL;
describe.skipIf(!endpoint)("external search against Elasticsearch", () => {
  let fixture: Awaited<ReturnType<typeof createFixture>>,
    app: Awaited<ReturnType<typeof createApplication>>,
    actor: Actor,
    index: string;
  beforeAll(async () => {
    fixture = await createFixture();
    app = await createApplication(fixture.database, fixture.config);
    const owner = await app.auth.api.createUser({
      body: {
        name: "Search owner",
        email: "search@example.test",
        password: "test-only-search-owner-password-234",
        role: "admin",
      },
    });
    actor = await app.domain.actor(owner.user.id);
    index = `kanvil_test_${crypto.randomUUID().replaceAll("-", "")}`;
    const settings = await app.instance.read();
    await app.instance.update({
      expectedVersion: settings.version,
      name: settings.name,
      description: settings.description,
      storage: { provider: "local" },
      search: { provider: "elasticsearch", url: endpoint, index },
    });
  });
  afterAll(async () => {
    await app?.close();
    if (endpoint && index) await fetch(`${endpoint}/${index}`, { method: "DELETE" });
    await fixture?.close();
  });
  it("indexes durable changes, filters permissions in PostgreSQL, and falls back on lag or outage", async () => {
    const a = await app.domain.execute(
        "create_project",
        { key: "SEARCHA", name: "Search A" },
        actor,
      ),
      b = await app.domain.execute("create_project", { key: "SEARCHB", name: "Search B" }, actor);
    const first = await app.domain.execute(
      "create_ticket",
      { projectId: a.id, title: "Recover durable checkpoint" },
      actor,
    );
    const other = await app.domain.execute(
      "create_ticket",
      { projectId: b.id, title: "Private payroll document" },
      actor,
    );
    await app.search.sync();
    expect(await app.search.status()).toMatchObject({ status: "ready" });
    const fuzzy = await app.domain.execute(
      "list_tickets",
      { projectId: a.id, q: "recoverr" },
      actor,
    );
    expect(fuzzy.items.map((row) => row.id)).toEqual([first.id]);
    const readerUser = await app.auth.api.createUser({
      body: {
        name: "Reader",
        email: "reader-search@example.test",
        password: "test-only-reader-password-234",
        role: "user",
      },
    });
    await app.domain.execute(
      "set_member",
      { projectId: a.id, email: readerUser.user.email, role: "reader" },
      actor,
    );
    const reader = await app.domain.actor(readerUser.user.id);
    await expect(
      app.domain.execute("list_tickets", { projectId: b.id, q: "payroll" }, reader),
    ).rejects.toMatchObject({ status: 404 });
    await app.search.sync();
    const instance = await app.instance.read();
    const forged = await fetch(`${endpoint}/${index}/_doc/${other.id}?refresh=true`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: other.id,
        projectId: a.id,
        instanceId: instance.identity,
        title: "Forged search result",
      }),
    });
    expect(forged.ok).toBe(true);
    expect(
      (await app.domain.execute("list_tickets", { projectId: a.id, q: "Forged" }, reader)).total,
    ).toBe(0);
    const newest = await app.domain.execute(
      "create_ticket",
      { projectId: a.id, title: "New searchable title" },
      actor,
    );
    expect(
      (
        await app.domain.execute("list_tickets", { projectId: a.id, q: "New searchable" }, reader)
      ).items.map((row) => row.id),
    ).toEqual([newest.id]);
    await app.search.sync();
    vi.stubGlobal("fetch", () => {
      throw new TypeError("simulated unavailable search service");
    });
    try {
      expect(
        (
          await app.domain.execute("list_tickets", { projectId: a.id, q: "durable" }, reader)
        ).items.map((row) => row.id),
      ).toEqual([first.id]);
    } finally {
      vi.unstubAllGlobals();
    }
    await app.domain.execute(
      "delete_ticket",
      { projectId: a.id, ticketId: first.id, expectedVersion: first.version },
      actor,
    );
    await app.search.sync();
    expect(
      (await app.domain.execute("list_tickets", { projectId: a.id, q: "recoverr" }, reader)).total,
    ).toBe(0);
  });
  it("orders index matches by relevance and matches quoted phrases exactly", async () => {
    const project = await app.domain.execute(
      "create_project",
      { key: "SEARCHD", name: "Search D" },
      actor,
    );
    const create = (title: string, description = "") =>
      app.domain.execute("create_ticket", { projectId: project.id, title, description }, actor);
    const exact = await create("Calibrate zephyrine sensors");
    const fuzzy = await create("Calibrate zephyrina sensors");
    const live = await create("Mark sessions done", "Leave the live activity after acknowledge.");
    const titled = await create("End the live activity on completion");
    const native = await create("Refine native activity screens");
    const like = await create("Feels like activity tracking");
    await app.search.sync();
    const scope = { workspaceId: project.workspaceId };
    const ranked = await app.domain.execute("search_tickets", { q: "zephyrine", ...scope }, actor);
    expect(ranked.items.map((item) => item.ticket.id)).toEqual([exact.id, fuzzy.id]);
    const results = await app.domain.execute(
      "search_workspace",
      { q: "zephyrine", type: "ticket", ...scope },
      actor,
    );
    expect(results.engine).toBe("index");
    expect(results.items.map((item) => item.id)).toEqual([exact.id, fuzzy.id]);
    const found = async (q: string) =>
      (
        await app.domain.execute(
          "list_tickets",
          { projectId: project.id, q, sort: "number" },
          actor,
        )
      ).items.map((row) => row.id);
    expect(await found('"live activity"')).toEqual([live.id, titled.id]);
    expect(await found('"live activity" acknowledge')).toEqual([live.id]);
    // Outside quotes terms stay fuzzy; an unpaired quote is a literal character.
    expect(await found("live activity")).toEqual([live.id, titled.id, like.id]);
    expect(await found('live "activity')).toEqual([live.id, titled.id, like.id]);
    expect(await found('"activity"')).toContain(native.id);
  });
  it("reindexes every ticket of a project whose prefix changes", async () => {
    const project = await app.domain.execute(
      "create_project",
      { key: "RENAMEFROM", name: "Search C" },
      actor,
    );
    const ticket = await app.domain.execute(
      "create_ticket",
      { projectId: project.id, title: "Renamed prefix" },
      actor,
    );
    await app.search.sync();
    await app.domain.execute(
      "update_project",
      {
        projectId: project.id,
        expectedVersion: project.version,
        name: project.name,
        description: project.description,
        key: "QWERTZ",
      },
      actor,
    );
    await app.search.sync();
    const found = await app.domain.execute(
      "search_workspace",
      { q: "QWERTZ", workspaceId: project.workspaceId, type: "ticket" },
      actor,
    );
    expect(found.engine).toBe("index");
    expect(found.items.map((item) => item.id)).toEqual([ticket.id]);
  });
});
