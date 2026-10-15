import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vite-plus/test";
import { createFixture } from "./test-fixture.ts";
import { createDomain, type Actor, type Domain } from "./domain.ts";
import type { Project } from "@kanvil/contracts";

describe("ticket operations on PostgreSQL", () => {
  let fixture: Awaited<ReturnType<typeof createFixture>>,
    domain: Domain,
    owner: Actor,
    writer: Actor,
    outsider: Actor,
    project: Project;
  beforeAll(async () => {
    fixture = await createFixture();
    domain = createDomain(fixture.database);
    const people = await Promise.all(
      ["Owner", "Writer", "Outsider"].map((name) =>
        fixture.auth.api.createUser({
          body: {
            name,
            email: `${name.toLowerCase()}@example.test`,
            password: "Isolated fixture password 42!",
            role: "user",
          },
        }),
      ),
    );
    owner = await domain.actor(people[0]!.user.id);
    writer = await domain.actor(people[1]!.user.id);
    outsider = await domain.actor(people[2]!.user.id);
  });
  afterAll(async () => {
    await fixture?.close();
  });
  beforeEach(async () => {
    project = await domain.execute(
      "create_project",
      { key: `K${crypto.randomUUID().slice(0, 8).toUpperCase()}`, name: "Isolated project" },
      owner,
    );
  });
  const ticket = (title = "A deliverable ticket") =>
    domain.execute(
      "create_ticket",
      {
        projectId: project.id,
        title,
        description: "Implement the described behavior.",
        acceptanceCriteria: "The regression is covered and checks pass.",
        difficulty: "med",
        automationReady: true,
      },
      owner,
    );
  it("deduplicates retried writes and rejects reuse for different work", async () => {
    const requestId = crypto.randomUUID(),
      input = { projectId: project.id, title: "Retry me", requestId };
    const first = await domain.execute("create_ticket", input, owner),
      second = await domain.execute("create_ticket", input, owner);
    expect(first).toEqual(second);
    expect((await domain.execute("list_tickets", { projectId: project.id }, owner)).total).toBe(1);
    await expect(
      domain.execute("create_ticket", { ...input, title: "Different work" }, owner),
    ).rejects.toMatchObject({ code: "idempotency_conflict" });
    expect((await ticket("Next ticket")).number).toBe(2);
  });
  it("allows only one concurrent update to the same version", async () => {
    const current = await ticket();
    const outcomes = await Promise.allSettled(
      ["First edit", "Second edit"].map((title) =>
        domain.execute(
          "update_ticket",
          { projectId: project.id, ticketId: current.id, expectedVersion: 1, changes: { title } },
          owner,
        ),
      ),
    );
    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    const failure = outcomes.find((outcome) => outcome.status === "rejected");
    expect(failure?.status === "rejected" ? failure.reason : null).toMatchObject({
      code: "version_conflict",
    });
    const state = await domain.execute(
      "get_ticket",
      { projectId: project.id, ticketId: current.key },
      owner,
    );
    expect(state.ticket.version).toBe(2);
    expect(
      (
        await domain.execute(
          "list_activity",
          { projectId: project.id, ticketId: current.id },
          owner,
        )
      ).items.filter((event) => event.type === "ticket.updated"),
    ).toHaveLength(1);
  });
  it("rolls back an entire bulk edit when one ticket changed", async () => {
    const first = await ticket(),
      second = await ticket("Second ticket");
    await domain.execute(
      "update_ticket",
      {
        projectId: project.id,
        ticketId: second.id,
        expectedVersion: 1,
        changes: { title: "Changed" },
      },
      owner,
    );
    await expect(
      domain.execute(
        "bulk_update_tickets",
        {
          projectId: project.id,
          tickets: [
            { ticketId: first.id, expectedVersion: 1 },
            { ticketId: second.id, expectedVersion: 1 },
          ],
          changes: { priority: "urgent" },
        },
        owner,
      ),
    ).rejects.toMatchObject({ code: "version_conflict" });
    expect(
      (await domain.execute("get_ticket", { projectId: project.id, ticketId: first.id }, owner))
        .ticket,
    ).toMatchObject({ version: 1, priority: "medium" });
  });
  it("rejects cycles across blockers and parent relationships and explains readiness", async () => {
    const first = await ticket(),
      second = await ticket("Dependent ticket");
    await domain.execute(
      "add_relation",
      { projectId: project.id, ticketId: first.id, targetId: second.id, type: "blocks" },
      owner,
    );
    await expect(
      domain.execute(
        "add_relation",
        { projectId: project.id, ticketId: second.id, targetId: first.id, type: "blocks" },
        owner,
      ),
    ).rejects.toMatchObject({ code: "dependency_cycle" });
    await expect(
      domain.execute(
        "update_ticket",
        {
          projectId: project.id,
          ticketId: second.id,
          expectedVersion: 1,
          changes: { parentId: first.id },
        },
        owner,
      ),
    ).rejects.toMatchObject({ code: "dependency_cycle" });
    expect(
      (await domain.execute("get_ticket", { projectId: project.id, ticketId: second.id }, owner))
        .readiness,
    ).toMatchObject({ ready: false, reasons: [{ code: "dependency", ticketId: first.id }] });
    await domain.execute(
      "update_ticket",
      {
        projectId: project.id,
        ticketId: first.id,
        expectedVersion: 1,
        changes: { status: "done" },
      },
      owner,
    );
    expect(
      (await domain.execute("get_ticket", { projectId: project.id, ticketId: second.id }, owner))
        .readiness.ready,
    ).toBe(true);
  });
  it("coordinates competing workers and fences old ownership after recovery", async () => {
    const current = await ticket();
    const workers = [
      await domain.actor(owner.id, { ownerId: "worker-a", scopes: ["read", "write", "claim"] }),
      await domain.actor(owner.id, { ownerId: "worker-b", scopes: ["read", "write", "claim"] }),
    ];
    const outcomes = await Promise.allSettled(
      workers.map((actor, index) =>
        domain.execute(
          "claim_ticket",
          {
            projectId: project.id,
            ticketId: current.id,
            expectedVersion: 1,
            workerId: `worker-${index}`,
          },
          actor,
        ),
      ),
    );
    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    const claim = (
      await domain.execute("get_ticket", { projectId: project.id, ticketId: current.id }, owner)
    ).claim!;
    await fixture.database.pool.query(
      "UPDATE claims SET expires_at = now() - interval '1 second' WHERE id = $1",
      [claim.id],
    );
    const owningWorker = claim.workerId === "worker-0" ? workers[0]! : workers[1]!;
    await expect(
      domain.execute(
        "release_claim",
        { projectId: project.id, ticketId: current.id, claimId: claim.id },
        owningWorker,
      ),
    ).rejects.toMatchObject({ code: "claim_conflict" });
    await expect(
      domain.execute(
        "claim_ticket",
        {
          projectId: project.id,
          ticketId: current.id,
          expectedVersion: 2,
          workerId: "replacement",
        },
        workers[1]!,
      ),
    ).rejects.toMatchObject({ code: "not_ready" });
    await domain.execute(
      "recover_claim",
      {
        projectId: project.id,
        ticketId: current.id,
        claimId: claim.id,
        reason: "Confirmed the old worker has stopped",
        confirmedStopped: true,
      },
      owner,
    );
    await expect(
      domain.execute(
        "update_ticket",
        {
          projectId: project.id,
          ticketId: current.id,
          expectedVersion: 2,
          claimId: claim.id,
          changes: { status: "done" },
        },
        workers[0]!,
      ),
    ).rejects.toMatchObject({ code: "claim_conflict" });
    await expect(
      domain.execute(
        "update_ticket",
        {
          projectId: project.id,
          ticketId: current.id,
          expectedVersion: 2,
          changes: { title: "Bypass by omitting ownership token" },
        },
        workers[0]!,
      ),
    ).rejects.toMatchObject({ code: "claim_conflict" });
    await expect(
      domain.execute(
        "add_evidence",
        {
          projectId: project.id,
          ticketId: current.id,
          kind: "test",
          title: "Stale worker evidence",
          url: "https://example.test/proof",
        },
        workers[0]!,
      ),
    ).rejects.toMatchObject({ code: "claim_conflict" });
    expect(
      (await domain.execute("get_ticket", { projectId: project.id, ticketId: current.id }, owner))
        .ticket.status,
    ).toBe("in_progress");
  });
  it("reports release capability for the exact live claim identity and preserves fences after release", async () => {
    const current = await ticket();
    const worker = await domain.actor(owner.id, {
      ownerId: "capability-worker",
      scopes: ["read", "write", "claim"],
    });
    const readOnly = await domain.actor(owner.id, { ownerId: worker.ownerId, scopes: ["read"] });
    const claim = await domain.execute(
      "claim_ticket",
      {
        projectId: project.id,
        ticketId: current.id,
        expectedVersion: 1,
        workerId: "capability-worker",
      },
      worker,
    );
    const input = { projectId: project.id, ticketId: current.id };
    expect((await domain.execute("get_ticket", input, owner)).canReleaseClaim).toBe(false);
    expect((await domain.execute("get_ticket", input, worker)).canReleaseClaim).toBe(true);
    expect((await domain.execute("get_ticket", input, readOnly)).canReleaseClaim).toBe(false);
    await domain.execute("release_claim", { ...input, claimId: claim.id }, worker);
    expect((await domain.execute("get_ticket", input, worker)).canReleaseClaim).toBe(false);
    await expect(
      domain.execute(
        "update_ticket",
        { ...input, expectedVersion: 2, changes: { status: "done" } },
        worker,
      ),
    ).rejects.toMatchObject({ code: "claim_conflict" });
    await domain.execute(
      "update_ticket",
      { ...input, expectedVersion: 2, changes: { status: "todo" } },
      owner,
    );
    const humanClaim = await domain.execute(
      "claim_ticket",
      { ...input, expectedVersion: 3, workerId: "manual owner" },
      owner,
    );
    expect((await domain.execute("get_ticket", input, owner)).canReleaseClaim).toBe(true);
    await domain.execute("release_claim", { ...input, claimId: humanClaim.id }, owner);
  });
  it("enforces project membership, credential scopes, and access on idempotent replay", async () => {
    const current = await ticket();
    await expect(
      domain.execute("get_ticket", { projectId: project.id, ticketId: current.id }, outsider),
    ).rejects.toMatchObject({ status: 404 });
    await domain.execute(
      "set_member",
      { projectId: project.id, email: "writer@example.test", role: "reader" },
      owner,
    );
    await expect(
      domain.execute(
        "update_ticket",
        {
          projectId: project.id,
          ticketId: current.id,
          expectedVersion: 1,
          changes: { title: "Forbidden" },
        },
        writer,
      ),
    ).rejects.toMatchObject({ status: 403 });
    const readOnly = await domain.actor(owner.id, {
      ownerId: "read-only",
      scopes: ["read"],
      projectIds: [project.id],
    });
    await expect(
      domain.execute("create_ticket", { projectId: project.id, title: "Forbidden" }, readOnly),
    ).rejects.toMatchObject({ status: 403 });
    await domain.execute(
      "set_member",
      { projectId: project.id, email: "writer@example.test", role: "writer" },
      owner,
    );
    const input = {
      projectId: project.id,
      title: "Writer's ticket",
      requestId: crypto.randomUUID(),
    };
    await domain.execute("create_ticket", input, writer);
    await domain.execute(
      "set_member",
      { projectId: project.id, email: "writer@example.test", role: null },
      owner,
    );
    await expect(domain.execute("create_ticket", input, writer)).rejects.toMatchObject({
      status: 404,
    });
  });
  it("preserves committed event order and returns permission-filtered replay", async () => {
    const snapshot = await domain.snapshot(owner, project.id);
    await Promise.all(
      Array.from({ length: 12 }, (_, index) => ticket(`Concurrent ticket ${index}`)),
    );
    const replay = await domain.readEvents(owner, BigInt(snapshot.cursor), project.id);
    expect(replay.items).toHaveLength(12);
    expect(replay.items.map((event) => event.id)).toEqual(
      replay.items.map((event) => event.id).toSorted((a, b) => (a < b ? -1 : 1)),
    );
    expect(new Set(replay.items.map((event) => event.id.toString())).size).toBe(12);
    expect((await domain.readEvents(outsider, 0n)).items).toEqual([]);
    await expect(domain.readEvents(owner, replay.cursor + 1n, project.id)).rejects.toMatchObject({
      code: "snapshot_required",
    });
  });
  it("attributes discussion and evidence and rejects moderation by another writer", async () => {
    const current = await ticket();
    await domain.execute(
      "set_member",
      { projectId: project.id, email: "writer@example.test", role: "writer" },
      owner,
    );
    const comment = await domain.execute(
      "add_comment",
      { projectId: project.id, ticketId: current.id, body: "A reproducible observation" },
      owner,
    );
    await expect(
      domain.execute(
        "update_comment",
        { projectId: project.id, commentId: comment.id, expectedVersion: 1, body: "Rewritten" },
        writer,
      ),
    ).rejects.toMatchObject({ status: 403 });
    const result = await domain.execute(
      "add_evidence",
      {
        projectId: project.id,
        ticketId: current.id,
        kind: "test",
        title: "Regression run",
        url: "https://example.test/result",
        outcome: "passed",
      },
      writer,
    );
    expect(result.actorId).toBe(writer.id);
    expect(
      (
        await domain.execute(
          "list_evidence",
          { projectId: project.id, ticketId: current.id },
          owner,
        )
      )[0]?.outcome,
    ).toBe("passed");
  });
});
