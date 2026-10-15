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
});
