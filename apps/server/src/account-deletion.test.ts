import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { and, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import { createFixture } from "./test-fixture.ts";
import { createApplication } from "./app.ts";
import { account, apikey, session, user } from "./auth-schema.ts";
import { claims, events, importRuns, members, workspaceMembers, workspaces } from "./schema.ts";
import { requireRow } from "./domain.ts";
import { recoverLocalPassword } from "./recover-account.ts";

const created = z.object({ id: z.string(), version: z.number().optional() });
async function parsed(response: Promise<Response>) {
  const result = await response;
  expect(result.status).toBe(200);
  return created.parse(await result.json());
}
describe("account deletion", () => {
  let fixture: Awaited<ReturnType<typeof createFixture>>,
    application: Awaited<ReturnType<typeof createApplication>>;
  let owner: { id: string; email: string },
    peer: { id: string; email: string },
    person: { id: string; email: string },
    ownerCookie: string;
  const password = "Isolated deletion password 234!";
  async function request(path: string, method = "GET", body?: unknown, cookie = ownerCookie) {
    return application.app.fetch(
      new Request(`http://localhost:5180${path}`, {
        method,
        headers: {
          Cookie: cookie,
          Origin: "http://localhost:5180",
          "Content-Type": "application/json",
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    );
  }
  async function signIn(email: string) {
    return request("/api/auth/sign-in/email", "POST", { email, password }, "");
  }
  async function login(email: string) {
    const result = await signIn(email);
    expect(result.status).toBe(200);
    return result.headers
      .getSetCookie()
      .map((value) => value.split(";")[0])
      .join("; ");
  }

  const remove = (id: string, confirmEmail: string, cookie = ownerCookie) =>
    request(`/api/v1/accounts/${id}`, "DELETE", { confirmEmail }, cookie);
  const row = async (id: string) =>
    (await fixture.database.db.select().from(user).where(eq(user.id, id)))[0];
  beforeEach(async () => {
    fixture = await createFixture();
    application = await createApplication(fixture.database, fixture.config);
    const make = async (name: string, email: string, role: "admin" | "user") =>
      (await fixture.auth.api.createUser({ body: { name, email, password, role } })).user;
    owner = await make("Instance owner", "owner@deletion.test", "admin");
    peer = await make("Second administrator", "peer@deletion.test", "admin");
    person = await make("Alex Engineer", "person@deletion.test", "user");
    ownerCookie = await login(owner.email);
  });
  afterEach(async () => {
    await application?.close();
    await fixture?.close();
  });

  it("erases a person's access and identity and keeps their ticket history under a tombstone", async () => {
    const space = await parsed(
      request("/api/v1/workspaces", "POST", { name: "Erasure", slug: "erasure" }),
    );
    expect(
      (
        await request(`/api/v1/workspaces/${space.id}/members`, "POST", {
          email: person.email,
          role: "writer",
        })
      ).status,
    ).toBe(200);
    const project = await parsed(
      request("/api/v1/projects", "POST", {
        workspaceId: space.id,
        visibility: "workspace",
        key: "ERA",
        name: "Erasure",
      }),
    );
    const personCookie = await login(person.email);
    const tickets = `/api/v1/projects/${project.id}/tickets`;
    const ticket = await parsed(request(tickets, "POST", { title: "Authored work" }, personCookie));
    await parsed(
      request(`${tickets}/${ticket.id}/comments`, "POST", { body: "Signed note" }, personCookie),
    );
    await parsed(
      request(
        `${tickets}/${ticket.id}/evidence`,
        "POST",
        { kind: "test", title: "Suite", url: "https://ci.deletion.test/1" },
        personCookie,
      ),
    );
    await fixture.database.db.insert(account).values({
      id: crypto.randomUUID(),
      accountId: "synthetic-oidc-subject",
      providerId: "oidc",
      userId: person.id,
      updatedAt: new Date(),
    });
    const key = await fixture.auth.api.createApiKey({
      body: {
        userId: person.id,
        name: "Agent",
        metadata: { projectIds: [project.id] },
        permissions: { kanvil: ["read"] },
      },
    });
    const bearer = () =>
      application.app.fetch(
        new Request(`http://localhost:5180/api/v1/workspaces`, {
          headers: { Authorization: `Bearer ${key.key}` },
        }),
      );
    expect((await bearer()).status).toBe(200);
    // An agent working for the account holds a claim.
    await fixture.database.db.insert(claims).values({
      projectId: project.id,
      ticketId: ticket.id,
      actorId: person.id,
      ownerId: key.id,
      workerId: "agent-1",
      expiresAt: new Date(Date.now() + 300_000),
    });
    // An import the account started is still running.
    const [run] = await fixture.database.db
      .insert(importRuns)
      .values({
        workspaceId: space.id,
        actorId: person.id,
        key: "IMP",
        name: "Imported",
        visibility: "workspace",
        status: "running",
        counts: {},
        members: [],
        issues: [],
      })
      .returning();
    // Only the account itself and instance administrators preview its deletion.
    expect(
      (await request(`/api/v1/accounts/${owner.id}/impact`, "GET", undefined, personCookie)).status,
    ).toBe(403);
    const preview = await request(
      `/api/v1/accounts/${person.id}/impact`,
      "GET",
      undefined,
      personCookie,
    );
    expect(await preview.json()).toEqual({
      userId: person.id,
      name: "Alex Engineer",
      email: person.email,
      providers: ["credential", "oidc"],
      sessions: 1,
      credentials: 1,
      devices: 0,
      workspaces: 1,
      projects: 0,
      claims: 1,
      imports: 1,
      tickets: 1,
      comments: 1,
      events: expect.any(Number),
      blockers: [],
    });

    // A mistyped confirmation changes nothing.
    expect((await remove(person.id, "someone@deletion.test", personCookie)).status).toBe(400);
    expect((await request("/api/v1/workspaces", "GET", undefined, personCookie)).status).toBe(200);

    expect((await remove(person.id, person.email.toUpperCase(), personCookie)).status).toBe(200);

    // Sign-in, sessions, API credentials, provider bindings, and memberships are gone.
    expect((await request("/api/v1/workspaces", "GET", undefined, personCookie)).status).toBe(401);
    expect((await bearer()).status).toBe(401);
    expect((await signIn(person.email)).status).not.toBe(200);
    const db = fixture.database.db;
    expect(await db.select().from(account).where(eq(account.userId, person.id))).toHaveLength(0);
    expect(await db.select().from(session).where(eq(session.userId, person.id))).toHaveLength(0);
    expect(await db.select().from(apikey).where(eq(apikey.referenceId, person.id))).toHaveLength(0);
    expect(
      await db.select().from(workspaceMembers).where(eq(workspaceMembers.userId, person.id)),
    ).toHaveLength(0);
    expect(await db.select().from(members).where(eq(members.userId, person.id))).toHaveLength(0);
    const tombstone = await row(person.id);
    expect(tombstone).toMatchObject({ name: "Deleted account", image: null, banned: true });
    expect(tombstone?.role).toBeNull();
    expect(tombstone?.email).not.toContain("person");
    expect(tombstone?.deletedAt).toBeInstanceOf(Date);

    // The shared history keeps its author, and clients learn the author is a deleted account.
    const kept = await request(`${tickets}/${ticket.id}`);
    expect(await kept.json()).toMatchObject({ ticket: { createdBy: person.id } });
    expect(await (await request(`${tickets}/${ticket.id}/comments`)).json()).toMatchObject({
      items: [{ actorId: person.id, body: "Signed note" }],
    });
    expect(await (await request(`${tickets}/${ticket.id}/evidence`)).json()).toEqual([
      expect.objectContaining({ actorId: person.id }),
    ]);
    expect(await (await request("/api/v1/accounts/deleted")).json()).toEqual([person.id]);
    // The released claim and the membership change are in the project's history.
    const published = await db
      .select({ type: events.type, data: events.data })
      .from(events)
      .where(eq(events.projectId, project.id));
    expect(published).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "claim.released",
          data: expect.objectContaining({ reason: "account_deleted" }),
        }),
        expect.objectContaining({
          type: "membership.updated",
          data: expect.objectContaining({ userId: person.id, role: null }),
        }),
      ]),
    );
    expect(await db.select().from(claims)).toHaveLength(0);
    expect(
      (
        await db
          .select()
          .from(importRuns)
          .where(eq(importRuns.id, requireRow(run).id))
      )[0]?.status,
    ).toBe("cancelled");

    // No administrator action or recovery path brings the erased account back.
    for (const [path, extra] of [
      ["/api/auth/admin/unban-user", {}],
      ["/api/auth/admin/impersonate-user", {}],
      ["/api/auth/admin/set-role", { role: "admin" }],
      ["/api/auth/admin/update-user", { data: { email: "person@deletion.test" } }],
    ] as const)
      expect((await request(path, "POST", { userId: person.id, ...extra })).status).toBe(404);
    expect(
      (
        await request(`/api/v1/admin/users/${person.id}/password`, "POST", {
          password: "Replacement password 345!",
        })
      ).status,
    ).toBe(404);
    await expect(
      recoverLocalPassword(
        fixture.database,
        fixture.config,
        requireEmail(tombstone?.email),
        "Replacement password 345!",
      ),
    ).rejects.toMatchObject({ status: 404 });
    expect(await db.select().from(account).where(eq(account.userId, person.id))).toHaveLength(0);
    expect((await request(`/api/v1/admin/users/${person.id}`)).status).toBe(404);
  });

  it("lets an administrator delete another account only after its blockers are resolved", async () => {
    const personCookie = await login(person.email);
    const space = await parsed(
      request("/api/v1/workspaces", "POST", { name: "Owned", slug: "owned" }, personCookie),
    );
    // An ordinary account cannot delete someone else.
    expect((await remove(owner.id, owner.email, personCookie)).status).toBe(403);
    const preview = await request(`/api/v1/accounts/${person.id}/impact`);
    expect(preview.status).toBe(200);
    expect(await preview.json()).toMatchObject({
      blockers: [expect.objectContaining({ code: "workspace_owner" })],
    });
    const refused = await remove(person.id, person.email);
    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({ error: { code: "workspace_owner" } });
    expect(await row(person.id)).toMatchObject({ name: "Alex Engineer", deletedAt: null });
    expect((await request("/api/v1/workspaces", "GET", undefined, personCookie)).status).toBe(200);

    expect(
      (
        await request(`/api/v1/workspaces/${space.id}/members`, "POST", {
          email: owner.email,
          role: "admin",
        })
      ).status,
    ).toBe(200);
    const workspace = z
      .array(z.object({ id: z.string(), version: z.number() }))
      .parse(await (await request("/api/v1/workspaces")).json())
      .find((item) => item.id === space.id);
    await parsed(
      request(`/api/v1/workspaces/${space.id}/owner`, "POST", {
        userId: owner.id,
        expectedVersion: workspace?.version,
      }),
    );
    expect((await remove(person.id, person.email)).status).toBe(200);
    expect(await row(person.id)).toMatchObject({ name: "Deleted account" });

    // The last active instance administrator, who now owns the workspace too, stays.
    expect((await remove(peer.id, peer.email)).status).toBe(200);
    const last = await remove(owner.id, owner.email);
    expect(last.status).toBe(409);
    expect(await last.json()).toMatchObject({
      error: {
        details: {
          blockers: expect.arrayContaining([
            expect.objectContaining({ code: "last_administrator" }),
          ]),
        },
      },
    });
    // Removal through the authentication library would drop the history this tombstone keeps.
    expect(
      (await request("/api/auth/admin/remove-user", "POST", { userId: owner.id })).status,
    ).toBe(403);
  });

  it("keeps one administrator when the last two delete each other at once", async () => {
    const peerCookie = await login(peer.email);
    const results = await Promise.all([
      remove(peer.id, peer.email, ownerCookie),
      remove(owner.id, owner.email, peerCookie),
    ]);
    // The loser was deleted first: its session or its account no longer authorizes anything.
    const [won, lost] = results.map((result) => result.status).toSorted((a, b) => a - b);
    expect(won).toBe(200);
    expect([401, 403]).toContain(lost);
    const remaining = await fixture.database.db
      .select({ id: user.id })
      .from(user)
      .where(and(eq(user.role, "admin"), isNull(user.deletedAt)));
    expect(remaining).toHaveLength(1);
  });

  it("never treats an impersonated session as a fresh sign-in and revokes it with its administrator", async () => {
    const peerCookie = await login(peer.email);
    const impersonate = async (cookie: string) => {
      const result = await request(
        "/api/auth/admin/impersonate-user",
        "POST",
        { userId: person.id },
        cookie,
      );
      expect(result.status).toBe(200);
      // The response clears the administrator's cookie before setting the impersonated one.
      const jar = new Map(
        result.headers.getSetCookie().map((value) => {
          const [pair = ""] = value.split(";");
          return [pair.slice(0, pair.indexOf("=")), pair] as const;
        }),
      );
      return [...jar.values()].join("; ");
    };
    // A brand-new impersonation session cannot stand in for the person's own recent sign-in.
    const asPerson = await impersonate(ownerCookie);
    const refused = await remove(person.id, person.email, asPerson);
    expect(refused.status).toBe(403);
    expect(await refused.json()).toMatchObject({ error: { code: "reauthentication_required" } });
    expect(await row(person.id)).toMatchObject({ deletedAt: null });

    // Deleting an administrator ends the sessions it opened as someone else.
    const borrowed = await impersonate(peerCookie);
    expect((await request("/api/v1/workspaces", "GET", undefined, borrowed)).status).toBe(200);
    // The preview counts it with the administrator's own session.
    expect(await (await request(`/api/v1/accounts/${peer.id}/impact`)).json()).toMatchObject({
      sessions: 2,
    });
    expect((await remove(peer.id, peer.email)).status).toBe(200);
    expect((await request("/api/v1/workspaces", "GET", undefined, borrowed)).status).toBe(401);
    expect(
      await fixture.database.db.select().from(session).where(eq(session.impersonatedBy, peer.id)),
    ).toHaveLength(0);
  });

  it("does not count a disabled administrator as another workspace administrator", async () => {
    const personCookie = await login(person.email);
    const space = await parsed(
      request("/api/v1/workspaces", "POST", { name: "Unowned", slug: "unowned" }, personCookie),
    );
    expect(
      (
        await request(
          `/api/v1/workspaces/${space.id}/members`,
          "POST",
          { email: peer.email, role: "admin" },
          personCookie,
        )
      ).status,
    ).toBe(200);
    // A workspace from before ownership, whose other administrator is disabled.
    await fixture.database.db
      .update(workspaces)
      .set({ ownerId: null })
      .where(eq(workspaces.id, space.id));
    expect((await request("/api/auth/admin/ban-user", "POST", { userId: peer.id })).status).toBe(
      200,
    );
    const refused = await remove(person.id, person.email);
    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({
      error: { code: "last_administrator", message: expect.stringContaining("Unowned") },
    });
  });

  it("lets a disabled sole administrator of an ownerless workspace go", async () => {
    const personCookie = await login(person.email);
    const space = await parsed(
      request("/api/v1/workspaces", "POST", { name: "Dormant", slug: "dormant" }, personCookie),
    );
    await fixture.database.db
      .update(workspaces)
      .set({ ownerId: null })
      .where(eq(workspaces.id, space.id));
    expect((await request("/api/auth/admin/ban-user", "POST", { userId: person.id })).status).toBe(
      200,
    );
    expect(await (await request(`/api/v1/accounts/${person.id}/impact`)).json()).toMatchObject({
      blockers: [],
    });
    expect((await remove(person.id, person.email)).status).toBe(200);
  });

  it("announces the deletion where only the account's history remains", async () => {
    const space = await parsed(
      request("/api/v1/workspaces", "POST", { name: "History", slug: "history" }),
    );
    const access = `/api/v1/workspaces/${space.id}/members`;
    expect((await request(access, "POST", { email: person.email, role: "writer" })).status).toBe(
      200,
    );
    const project = await parsed(
      request("/api/v1/projects", "POST", {
        workspaceId: space.id,
        visibility: "workspace",
        key: "HIST",
        name: "History",
      }),
    );
    await parsed(
      request(
        `/api/v1/projects/${project.id}/tickets`,
        "POST",
        { title: "Left behind" },
        await login(person.email),
      ),
    );
    expect((await request(access, "POST", { email: person.email, role: null })).status).toBe(200);
    const before = await fixture.database.db
      .select({ id: events.id })
      .from(events)
      .where(and(eq(events.projectId, project.id), eq(events.type, "membership.updated")));
    expect((await remove(person.id, person.email)).status).toBe(200);
    const after = await fixture.database.db
      .select({ data: events.data })
      .from(events)
      .where(and(eq(events.projectId, project.id), eq(events.type, "membership.updated")));
    expect(after.length).toBe(before.length + 1);
    expect(after).toContainEqual({
      data: expect.objectContaining({ userId: person.id, deleted: true }),
    });
  });

  it("asks for a recent sign-in before deleting", async () => {
    const personCookie = await login(person.email);
    await fixture.database.db
      .update(session)
      .set({ createdAt: new Date(Date.now() - 16 * 60_000) })
      .where(eq(session.userId, person.id));
    const stale = await remove(person.id, person.email, personCookie);
    expect(stale.status).toBe(403);
    expect(await stale.json()).toMatchObject({ error: { code: "reauthentication_required" } });
    expect(await row(person.id)).toMatchObject({ deletedAt: null });
  });
});
function requireEmail(value: string | undefined) {
  if (!value) throw new Error("The tombstone has no address");
  return value;
}
