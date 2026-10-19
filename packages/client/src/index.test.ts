import { expect, it, vi } from "vite-plus/test";
import { createClient } from "./index.ts";

it("creates valid, retry-stable write IDs when an HTTP browser has no randomUUID", async () => {
  const getRandomValues = crypto.getRandomValues.bind(crypto);
  vi.stubGlobal("crypto", { getRandomValues });
  try {
    const ids: string[] = [];
    const client = createClient({
      baseUrl: "http://192.168.1.10:5173",
      fetch: async (_input, init) => {
        if (typeof init?.body !== "string") throw new Error("Expected a JSON request body");
        const body = JSON.parse(init.body);
        ids.push(body.requestId);
        if (ids.length === 1) throw new TypeError("Lost response");
        return Response.json({ ok: true });
      },
    });
    const input = { projectId: "p", ticketId: "t", enabled: true };
    await client.call("set_subscription", input);
    await client.call("set_subscription", input);
    expect(ids).toHaveLength(3);
    expect(ids[0]).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(ids[1]).toBe(ids[0]);
    expect(ids[2]).not.toBe(ids[0]);
  } finally {
    vi.unstubAllGlobals();
  }
});
it("sends no requestId to writes that do not accept one", async () => {
  const bodies: unknown[] = [];
  const client = createClient({
    baseUrl: "http://localhost:5180",
    fetch: async (_input, init) => {
      if (typeof init?.body !== "string") throw new Error("Expected a JSON request body");
      bodies.push(JSON.parse(init.body));
      return Response.json({
        id: "6f9619ff-8b86-4011-b42d-00c04fc964ff",
        projectId: "7f9619ff-8b86-4011-b42d-00c04fc964ff",
        name: "Feed",
        labels: [],
        timeZone: "UTC",
        createdBy: "user",
        createdAt: "2026-01-01T00:00:00.000Z",
        active: true,
        token: "kvcal_secret",
        path: "/api/calendar/kvcal_secret.ics",
      });
    },
  });
  await client.call("create_calendar_feed", { projectId: "p", name: "Feed", timeZone: "UTC" });
  expect(bodies).toEqual([{ name: "Feed", labels: [], timeZone: "UTC" }]);
});
