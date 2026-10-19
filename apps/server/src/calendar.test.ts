import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import { createApplication } from "./app.ts";
import { createFixture } from "./test-fixture.ts";
import type { Actor } from "./domain.ts";

// Synthetic dates around New York's 2026 daylight-saving changes (8 March and 1 November).
const newYork = {
  springStart: "2026-03-08T05:00:00.000Z", // 00:00 EST on 8 March
  springEnd: "2026-03-09T03:59:59.999Z", // 23:59:59.999 EDT on 8 March
  fallEnd: "2026-11-02T04:59:59.999Z", // 23:59:59.999 EST on 1 November
};
// Calendar clients unfold continuation lines before reading a property.
const unfold = (ics: string) => ics.replaceAll(/\r\n[ \t]/g, "");
const eventFor = (ics: string, key: string) =>
  unfold(ics)
    .split("BEGIN:VEVENT")
    .find((part) => part.includes(`SUMMARY:${key} `));

describe("start dates and calendar feeds", () => {
  let fixture: Awaited<ReturnType<typeof createFixture>>,
    application: Awaited<ReturnType<typeof createApplication>>,
    cookie: string,
    owner: Actor,
    writer: Actor,
    deputy: Actor,
    writerEmail: string,
    deputyEmail: string;
  const url = (path: string) => `${fixture.config.KANVIL_URL}${path}`;
  const request = (path: string, init?: RequestInit) =>
    application.app.fetch(new Request(url(path), init));
  async function send(method: string, path: string, body?: unknown) {
    const response = await request(`/api/v1${path}`, {
      method,
      headers: {
        Cookie: cookie,
        Origin: fixture.config.KANVIL_URL,
        "Content-Type": "application/json",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    // Assertions below read the JSON the way an HTTP consumer would.
    const parsed: any = text ? JSON.parse(text) : {};
    return { status: response.status, body: parsed };
  }
  async function feed(path: string) {
    const response = await request(path);
    return {
      status: response.status,
      type: response.headers.get("content-type"),
      text: await response.text(),
    };
  }
  beforeAll(async () => {
    fixture = await createFixture();
    application = await createApplication(fixture.database, fixture.config);
    const input = {
      email: "calendar-owner@example.test",
      name: "Calendar owner",
      password: "Isolated calendar password 42!",
      token: fixture.config.KANVIL_SETUP_TOKEN,
    };
    expect(
      (
        await request("/api/v1/setup", {
          method: "POST",
          headers: { "Content-Type": "application/json", Origin: fixture.config.KANVIL_URL },
          body: JSON.stringify(input),
        })
      ).status,
    ).toBe(201);
    const login = await request("/api/auth/sign-in/email", {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: fixture.config.KANVIL_URL },
      body: JSON.stringify({ email: input.email, password: input.password }),
    });
    cookie = login.headers
      .getSetCookie()
      .map((value) => value.split(";")[0])
      .join("; ");
    const people = await Promise.all(
      ["Calendar writer", "Calendar deputy"].map((name, index) =>
        fixture.auth.api.createUser({
          body: {
            name,
            email: `calendar-${index}@example.test`,
            password: "Isolated calendar password 42!",
            role: "user",
          },
        }),
      ),
    );
    writerEmail = people[0]!.user.email;
    deputyEmail = people[1]!.user.email;
    writer = await application.domain.actor(people[0]!.user.id);
    deputy = await application.domain.actor(people[1]!.user.id);
    const ownerId = (
      await fixture.database.pool.query<{ id: string }>(`SELECT id FROM "user" WHERE email = $1`, [
        input.email,
      ])
    ).rows[0]!.id;
    owner = await application.domain.actor(ownerId);
  });
  afterAll(async () => {
    await application?.close();
    await fixture?.close();
  });
  const newProject = async () => {
    const created = await send("POST", "/projects", {
      key: `C${crypto.randomUUID().slice(0, 8).toUpperCase()}`,
      name: "Calendar project",
    });
    expect(created.status).toBe(200);
    return created.body;
  };

  it("stores, validates, sorts, and filters start dates beside due dates", async () => {
    const project = await newProject();
    const spanning = await send("POST", `/projects/${project.id}/tickets`, {
      title: "Spans the spring change",
      startAt: newYork.springStart,
      dueAt: newYork.springEnd,
    });
    expect(spanning.status).toBe(200);
    expect(spanning.body.startAt).toBe(newYork.springStart);
    expect(spanning.body.dueAt).toBe(newYork.springEnd);
    const undated = await send("POST", `/projects/${project.id}/tickets`, { title: "Undated" });
    expect(undated.body.startAt).toBeNull();
    const startOnly = await send("POST", `/projects/${project.id}/tickets`, {
      title: "Starts later",
      startAt: "2026-04-01T04:00:00.000Z",
    });
    expect(startOnly.status).toBe(200);
    // A start after the due date is rejected on create and on an edit of either side.
    const backwards = await send("POST", `/projects/${project.id}/tickets`, {
      title: "Backwards",
      startAt: "2026-05-02T04:00:00.000Z",
      dueAt: "2026-05-01T04:00:00.000Z",
    });
    expect(backwards.status).toBe(400);
    expect(backwards.body.error.code).toBe("validation_error");
    const moved = await send("PATCH", `/projects/${project.id}/tickets/${spanning.body.id}`, {
      expectedVersion: spanning.body.version,
      changes: { startAt: "2026-03-10T04:00:00.000Z" },
    });
    expect(moved.status).toBe(400);
    expect(moved.body.error.code).toBe("validation_error");
    expect(moved.body.error.message).toBe(`${spanning.body.key} would start after its due date`);
    const sorted = await send("GET", `/projects/${project.id}/tickets?sort=start`);
    expect(sorted.body.items.map((ticket: { title: string }) => ticket.title)).toEqual([
      "Spans the spring change",
      "Starts later",
      "Undated",
    ]);
    // A window returns tickets whose start-to-due span overlaps it, whichever date they have.
    const march = await send(
      "GET",
      `/projects/${project.id}/tickets?scheduledFrom=2026-03-09T00:00:00.000Z&scheduledTo=2026-03-20T00:00:00.000Z`,
    );
    expect(march.body.items.map((ticket: { title: string }) => ticket.title)).toEqual([
      "Spans the spring change",
    ]);
    const april = await send(
      "GET",
      `/projects/${project.id}/tickets?scheduledFrom=2026-04-01T00:00:00.000Z&scheduledTo=2026-05-01T00:00:00.000Z`,
    );
    expect(april.body.items.map((ticket: { title: string }) => ticket.title)).toEqual([
      "Starts later",
    ]);
    const duplicated = await send(
      "POST",
      `/projects/${project.id}/tickets/${spanning.body.id}/duplicate`,
      {},
    );
    expect(duplicated.body.startAt).toBe(newYork.springStart);
  });

  it("creates, lists, serves, and revokes label-filtered feeds for project administrators", async () => {
    const project = await newProject();
    const make = (title: string, extra: Record<string, unknown>) =>
      send("POST", `/projects/${project.id}/tickets`, { title, ...extra }).then((r) => {
        expect(r.status).toBe(200);
        return r.body;
      });
    const spring = await make("Plan, then ship; spring", {
      startAt: newYork.springStart,
      dueAt: newYork.springEnd,
      labels: ["release"],
    });
    const fall = await make("Due on the fall change", {
      dueAt: newYork.fallEnd,
      labels: ["release"],
    });
    const other = await make("Other label", { dueAt: newYork.fallEnd, labels: ["internal"] });
    const done = await make("Already done", {
      dueAt: newYork.fallEnd,
      labels: ["release"],
      status: "done",
    });
    const archived = await make("Put away", {
      dueAt: newYork.fallEnd,
      labels: ["release"],
      archived: true,
    });
    const undated = await make("No dates", { labels: ["release"] });

    const created = await send("POST", `/projects/${project.id}/calendar-feeds`, {
      name: "Release dates",
      labels: ["release"],
      timeZone: "America/New_York",
    });
    expect(created.status).toBe(200);
    const { token, path } = created.body;
    expect(path).toBe(`/api/calendar/${token}.ics`);
    // Only the hash is stored, and neither the list nor the event stream carries the secret.
    const listed = await send("GET", `/projects/${project.id}/calendar-feeds`);
    expect(listed.body).toEqual([
      expect.objectContaining({
        id: created.body.id,
        name: "Release dates",
        labels: ["release"],
        timeZone: "America/New_York",
        active: true,
      }),
    ]);
    expect(JSON.stringify(listed.body)).not.toContain(token);
    const stored = await fixture.database.db.execute(
      sql`SELECT row_to_json(calendar_feeds)::text AS row FROM calendar_feeds`,
    );
    expect(JSON.stringify(stored.rows)).not.toContain(token);
    expect(JSON.stringify(stored.rows)).toContain(createHash("sha256").update(token).digest("hex"));
    const events = await fixture.database.db.execute(sql`SELECT data::text FROM events`);
    expect(JSON.stringify(events.rows)).not.toContain(token);

    const served = await feed(path);
    expect(served.status).toBe(200);
    expect(served.type).toContain("text/calendar");
    expect(served.text.startsWith("BEGIN:VCALENDAR\r\n")).toBe(true);
    expect(
      served.text
        .split("\r\n")
        .every((line: string) => new TextEncoder().encode(line).length <= 75),
    ).toBe(true);
    const springEvent = eventFor(served.text, spring.key);
    expect(springEvent).toContain("DTSTART;VALUE=DATE:20260308\r\n");
    // The due day is inclusive, so the all-day event ends the following morning.
    expect(springEvent).toContain("DTEND;VALUE=DATE:20260309\r\n");
    expect(springEvent).toContain("SUMMARY:" + spring.key + " · Plan\\, then ship\\; spring\r\n");
    expect(springEvent).toContain(
      `URL:${fixture.config.KANVIL_URL}/projects/${project.id}/tickets/${spring.id}`,
    );
    const fallEvent = eventFor(served.text, fall.key);
    expect(fallEvent).toContain("DTSTART;VALUE=DATE:20261101\r\n");
    expect(fallEvent).toContain("DTEND;VALUE=DATE:20261102\r\n");
    for (const hidden of [other, done, archived, undated])
      expect(eventFor(served.text, hidden.key)).toBeUndefined();

    // Date changes show on the next fetch; clearing both dates removes the event.
    const rescheduled = await send("PATCH", `/projects/${project.id}/tickets/${fall.id}`, {
      expectedVersion: fall.version,
      changes: { dueAt: "2026-11-21T04:59:59.999Z" },
    });
    expect(rescheduled.status).toBe(200);
    expect(eventFor((await feed(path)).text, fall.key)).toContain(
      "DTSTART;VALUE=DATE:20261120\r\n",
    );
    await send("PATCH", `/projects/${project.id}/tickets/${fall.id}`, {
      expectedVersion: rescheduled.body.version,
      changes: { dueAt: null },
    });
    expect(eventFor((await feed(path)).text, fall.key)).toBeUndefined();

    // The token survives a server restart because it is checked against the database.
    const restarted = await createApplication(fixture.database, fixture.config);
    try {
      const again = await restarted.app.fetch(new Request(url(path)));
      expect(again.status).toBe(200);
      expect(await again.text()).toContain(spring.key);
    } finally {
      await restarted.close();
    }

    const revoked = await send(
      "DELETE",
      `/projects/${project.id}/calendar-feeds/${created.body.id}`,
      {},
    );
    expect(revoked.status).toBe(200);
    expect((await feed(path)).status).toBe(404);
    expect((await send("GET", `/projects/${project.id}/calendar-feeds`)).body).toEqual([]);
    expect((await feed("/api/calendar/kvcal_not-a-real-token.ics")).status).toBe(404);
  });

  it("limits feed management to project administrators and stops feeds when access ends", async () => {
    const project = await newProject();
    await send("POST", `/projects/${project.id}/members`, { email: writerEmail, role: "writer" });
    await send("POST", `/projects/${project.id}/members`, { email: deputyEmail, role: "admin" });
    const domain = application.domain;
    await expect(
      domain.execute(
        "create_calendar_feed",
        { projectId: project.id, name: "Mine", timeZone: "UTC" },
        writer,
      ),
    ).rejects.toMatchObject({ status: 403, code: "forbidden" });
    await expect(
      domain.execute("list_calendar_feeds", { projectId: project.id }, writer),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      domain.execute(
        "create_calendar_feed",
        { projectId: project.id, name: "Zone", timeZone: "Mars/Olympus" },
        owner,
      ),
    ).rejects.toMatchObject({ status: 400, code: "validation_error" });
    await domain.execute(
      "create_ticket",
      { projectId: project.id, title: "Deputy work", dueAt: newYork.fallEnd },
      owner,
    );
    const shared = await domain.execute(
      "create_calendar_feed",
      { projectId: project.id, name: "Deputy feed", timeZone: "UTC" },
      deputy,
    );
    expect((await feed(shared.path)).status).toBe(200);
    // A feed is only as good as its creator's access: removal stops it at once.
    await send("POST", `/projects/${project.id}/members`, { email: deputyEmail, role: null });
    expect((await feed(shared.path)).status).toBe(404);
    expect(await domain.execute("list_calendar_feeds", { projectId: project.id }, owner)).toEqual([
      expect.objectContaining({ id: shared.id, active: false }),
    ]);
  });
});
