import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vite-plus/test";
import { and, eq } from "drizzle-orm";
import { createFixture } from "./test-fixture.ts";
import { createDomain, type Actor, type Domain } from "./domain.ts";
import { events, notificationPreferences, notifications } from "./schema.ts";
import type { Project, Ticket } from "@kanvil/contracts";

const mention = (name: string, actor: Actor) => `[@${name}](mention:${actor.id})`;
describe("comment mentions", () => {
  let fixture: Awaited<ReturnType<typeof createFixture>>,
    domain: Domain,
    owner: Actor,
    writer: Actor,
    reader: Actor,
    outsider: Actor,
    project: Project,
    ticket: Ticket;
  // Every notification of a user on the current ticket, oldest first.
  const received = async (actor: Actor) =>
    (
      await fixture.database.db
        .select({ type: events.type, category: notifications.category })
        .from(notifications)
        .innerJoin(events, eq(events.id, notifications.eventId))
        .where(and(eq(notifications.userId, actor.id), eq(events.ticketId, ticket.id)))
        .orderBy(events.id)
    ).map((row) => [row.type, row.category]);
  const comment = (body: string, actor = owner, requestId?: string) =>
    domain.execute(
      "add_comment",
      { projectId: project.id, ticketId: ticket.id, body, ...(requestId ? { requestId } : {}) },
      actor,
    );
  beforeAll(async () => {
    fixture = await createFixture();
    domain = createDomain(fixture.database);
    const person = async (name: string) =>
      domain.actor(
        (
          await fixture.auth.api.createUser({
            body: {
              name,
              email: `${name.toLowerCase()}@mentions.example.test`,
              password: "Isolated mention password 42!",
              role: "user",
            },
          })
        ).user.id,
      );
    owner = await person("Owner");
    writer = await person("Writer");
    reader = await person("Reader");
    outsider = await person("Outsider");
    // The outsider owns a project elsewhere, so the ID is valid but grants nothing here.
    await domain.execute("create_project", { key: "AWAY", name: "Other workspace" }, outsider);
  });
  afterAll(async () => {
    await fixture?.close();
  });
  beforeEach(async () => {
    await fixture.database.db.delete(notificationPreferences);
    project = await domain.execute(
      "create_project",
      { key: `M${crypto.randomUUID().slice(0, 6).toUpperCase()}`, name: "Mention project" },
      owner,
    );
    for (const [actor, role] of [
      [writer, "writer"],
      [reader, "reader"],
    ] as const)
      await domain.execute(
        "set_member",
        {
          projectId: project.id,
          email: `${actor === writer ? "writer" : "reader"}@mentions.example.test`,
          role,
        },
        owner,
      );
    ticket = await domain.execute(
      "create_ticket",
      { projectId: project.id, title: "Mention ticket" },
      owner,
    );
  });

  it("notifies each permitted mentioned member once, without following them", async () => {
    await comment(
      [
        `${mention("Writer", writer)} and again ${mention("Writer", writer)}, cc ${mention("Reader", reader)}.`,
        `Me: ${mention("Owner", owner)}. Elsewhere: ${mention("Outsider", outsider)}.`,
        "Unknown: [@Ghost](mention:no-such-user).",
      ].join("\n\n"),
    );
    expect(await received(writer)).toEqual([["comment.created", "mention"]]);
    expect(await received(reader)).toEqual([["comment.created", "mention"]]);
    expect(await received(owner)).toEqual([]);
    expect(await received(outsider)).toEqual([]);
    // A mention is not a subscription: the next unmentioned comment reaches only followers.
    await comment("Follow-up without mentions", writer);
    expect(await received(writer)).toEqual([["comment.created", "mention"]]);
    expect(await received(reader)).toEqual([["comment.created", "mention"]]);
  });

  it("ignores code, escaped syntax, and lookalike text", async () => {
    await comment(
      [
        "```",
        mention("Writer", writer),
        "```",
        `Inline \`${mention("Writer", writer)}\`, escaped \\${mention("Writer", writer)},`,
        `plain @Writer, mention:${writer.id}, and [@Writer](https://example.test/${writer.id}).`,
        "",
        `    ${mention("Writer", writer)}`,
      ].join("\n"),
    );
    expect(await received(writer)).toEqual([]);
  });

  it("respects the mention category and keeps a follower's comment notice", async () => {
    await fixture.database.db
      .insert(notificationPreferences)
      .values({ userId: writer.id, categories: { mention: false } });
    await comment(`Hello ${mention("Writer", writer)}`);
    expect(await received(writer)).toEqual([]);
    await domain.execute(
      "set_subscription",
      { projectId: project.id, ticketId: ticket.id, enabled: true },
      writer,
    );
    await comment(`Again ${mention("Writer", writer)}`);
    expect(await received(writer)).toEqual([["comment.created", "comment"]]);
    await fixture.database.db.delete(notificationPreferences);
    await comment(`Once more ${mention("Writer", writer)}`);
    expect(await received(writer)).toEqual([
      ["comment.created", "comment"],
      ["comment.created", "mention"],
    ]);
  });

  it("notifies only mentions an edit adds", async () => {
    const created = await comment(`Draft for ${mention("Writer", writer)}`);
    const edited = await domain.execute(
      "update_comment",
      {
        projectId: project.id,
        commentId: created.id,
        expectedVersion: created.version,
        body: `Draft for ${mention("Writer", writer)} and ${mention("Reader", reader)}`,
      },
      owner,
    );
    await domain.execute(
      "update_comment",
      {
        projectId: project.id,
        commentId: edited.id,
        expectedVersion: edited.version,
        body: "Mentions removed",
      },
      owner,
    );
    expect(await received(writer)).toEqual([["comment.created", "mention"]]);
    expect(await received(reader)).toEqual([["comment.updated", "mention"]]);
  });

  it("does not notify again on a retried request or after access is removed", async () => {
    const requestId = crypto.randomUUID();
    const first = await comment(`Retry ${mention("Writer", writer)}`, owner, requestId);
    expect(await comment(`Retry ${mention("Writer", writer)}`, owner, requestId)).toEqual(first);
    expect(await received(writer)).toEqual([["comment.created", "mention"]]);
    await domain.execute(
      "set_member",
      { projectId: project.id, email: "writer@mentions.example.test", role: null },
      owner,
    );
    await comment(`Gone ${mention("Writer", writer)}`);
    expect(await received(writer)).toEqual([["comment.created", "mention"]]);
  });
});
