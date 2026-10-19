import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vite-plus/test";
import { and, asc, eq } from "drizzle-orm";
import { createFixture } from "./test-fixture.ts";
import { createDomain, type Actor } from "./domain.ts";
import { sendDueReminders } from "./reminders.ts";
import { events, notificationPreferences, notifications, tickets } from "./schema.ts";
import type { Project, Ticket } from "@kanvil/contracts";

describe("due-date reminders", () => {
  let fixture: Awaited<ReturnType<typeof createFixture>>, domain: ReturnType<typeof createDomain>;
  let owner: Actor, project: Project, ticket: Ticket;
  const prefer = (values: Partial<typeof notificationPreferences.$inferInsert>) =>
    fixture.database.db
      .insert(notificationPreferences)
      .values({ userId: owner.id, ...values })
      .onConflictDoUpdate({ target: notificationPreferences.userId, set: values });
  // Notices recorded for the current ticket, oldest first, as [event type, category] pairs.
  const notices = async (userId = owner.id) =>
    (
      await fixture.database.db
        .select({ type: events.type, category: notifications.category })
        .from(notifications)
        .innerJoin(events, eq(events.id, notifications.eventId))
        .where(and(eq(notifications.userId, userId), eq(events.ticketId, ticket.id)))
        .orderBy(asc(events.id))
    ).map((row) => [row.type, row.category]);
  const setDue = async (dueAt: Date | null, changes: Record<string, unknown> = {}) => {
    ticket = await domain.execute(
      "update_ticket",
      {
        projectId: project.id,
        ticketId: ticket.id,
        expectedVersion: ticket.version,
        changes: { dueAt: dueAt?.toISOString() ?? null, ...changes },
      },
      owner,
    );
  };
  const at = (offset: number) => new Date(due.getTime() + offset);
  const minute = 60_000;
  let due: Date;
  beforeAll(async () => {
    fixture = await createFixture();
    domain = createDomain(fixture.database);
    const created = await fixture.auth.api.createUser({
      body: {
        name: "Reminder owner",
        email: "reminders@example.test",
        password: "Isolated reminder password 42!",
        role: "user",
      },
    });
    owner = await domain.actor(created.user.id);
    project = await domain.execute("create_project", { key: "REM", name: "Reminders" }, owner);
  });
  afterAll(async () => {
    await fixture?.close();
  });
  beforeEach(async () => {
    await fixture.database.db.delete(notificationPreferences);
    // Earlier tests' tickets keep their due dates; clear them so each test counts only its own.
    await fixture.database.db.update(tickets).set({ dueAt: null });
    due = new Date(Date.now() + 3 * 86_400_000);
    ticket = await domain.execute(
      "create_ticket",
      { projectId: project.id, title: "Reminder ticket" },
      owner,
    );
  });
  it("reminds inside the lead time, then once when overdue, on a test-owned clock", async () => {
    await prefer({ reminderAmount: 1, reminderUnit: "hours" });
    await setDue(due);
    expect(await sendDueReminders(fixture.database, at(-61 * minute))).toBe(0);
    expect(await sendDueReminders(fixture.database, at(-60 * minute))).toBe(1);
    expect(await sendDueReminders(fixture.database, at(-1))).toBe(0);
    expect(await sendDueReminders(fixture.database, due)).toBe(1);
    expect(await sendDueReminders(fixture.database, at(minute))).toBe(0);
    expect(await notices()).toEqual([
      ["ticket.due_soon", "due_soon"],
      ["ticket.overdue", "overdue"],
    ]);
    const [reminder] = await fixture.database.db
      .select()
      .from(events)
      .where(and(eq(events.ticketId, ticket.id), eq(events.type, "ticket.overdue")));
    expect(reminder).toMatchObject({
      actorId: null,
      data: { dueAt: due.toISOString(), key: ticket.key, source: { kind: "system" } },
    });
    const current = await domain.execute(
      "get_ticket",
      { projectId: project.id, ticketId: ticket.id },
      owner,
    );
    expect(current.ticket.version).toBe(ticket.version);
  });
  it("follows a moved due date and skips cleared, completed, and archived tickets", async () => {
    await setDue(due);
    await sendDueReminders(fixture.database, due);
    const moved = at(86_400_000);
    await setDue(moved);
    expect(await sendDueReminders(fixture.database, due)).toBe(1);
    expect(await notices()).toEqual([
      ["ticket.overdue", "overdue"],
      ["ticket.due_soon", "due_soon"],
    ]);
    await setDue(null);
    expect(await sendDueReminders(fixture.database, moved)).toBe(0);
    await setDue(moved, { status: "done" });
    expect(await sendDueReminders(fixture.database, moved)).toBe(0);
    await setDue(moved, { status: "todo", archived: true });
    expect(await sendDueReminders(fixture.database, moved)).toBe(0);
  });
  it("honors disabled reminder categories and revoked project access", async () => {
    await prefer({ categories: { due_soon: false } });
    const follower = await fixture.auth.api.createUser({
      body: {
        name: "Former follower",
        email: `follower-${crypto.randomUUID()}@example.test`,
        password: "Isolated reminder password 42!",
        role: "user",
      },
    });
    await domain.execute(
      "set_member",
      { projectId: project.id, email: follower.user.email, role: "reader" },
      owner,
    );
    await setDue(due, { assigneeId: follower.user.id });
    await domain.execute(
      "set_member",
      { projectId: project.id, email: follower.user.email, role: null },
      owner,
    );
    expect(await sendDueReminders(fixture.database, at(-minute))).toBe(0);
    expect(await sendDueReminders(fixture.database, due)).toBe(1);
    expect(await notices()).toEqual([["ticket.overdue", "overdue"]]);
    expect(await notices(follower.user.id)).toEqual([["ticket.updated", "assignment"]]);
  });
  it("records one notice when concurrent workers race at the same instant", async () => {
    await setDue(due);
    const sent = await Promise.all(
      Array.from({ length: 4 }, () => sendDueReminders(fixture.database, due)),
    );
    expect(sent.toSorted((a, b) => a - b)).toEqual([0, 0, 0, 1]);
    expect(await notices()).toEqual([["ticket.overdue", "overdue"]]);
  });
  it("publishes a fresh event for a follower whose later lead time opens", async () => {
    const follower = await fixture.auth.api.createUser({
      body: {
        name: "Early follower",
        email: `early-${crypto.randomUUID()}@example.test`,
        password: "Isolated reminder password 42!",
        role: "user",
      },
    });
    await domain.execute(
      "set_member",
      { projectId: project.id, email: follower.user.email, role: "reader" },
      owner,
    );
    await domain.execute(
      "set_subscription",
      { projectId: project.id, ticketId: ticket.id, enabled: true },
      await domain.actor(follower.user.id),
    );
    await prefer({ reminderAmount: 1, reminderUnit: "hours" });
    await setDue(due);
    expect(await sendDueReminders(fixture.database, at(-86_400_000))).toBe(1);
    expect(await sendDueReminders(fixture.database, at(-60 * minute))).toBe(1);
    const published = await fixture.database.db
      .select({ id: events.id })
      .from(events)
      .where(and(eq(events.ticketId, ticket.id), eq(events.type, "ticket.due_soon")))
      .orderBy(asc(events.id));
    // Live clients refresh on new events, so the later follower's notice needs its own event.
    expect(published).toHaveLength(2);
    const [notice] = await fixture.database.db
      .select({ eventId: notifications.eventId })
      .from(notifications)
      .where(and(eq(notifications.userId, owner.id), eq(notifications.eventId, published[1]!.id)));
    expect(notice).toBeDefined();
    expect(await notices(follower.user.id)).toEqual([
      ["ticket.updated", "update"],
      ["ticket.due_soon", "due_soon"],
    ]);
  });
});
