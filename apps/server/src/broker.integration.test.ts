import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { createServer, connect as connectTcp, type Socket } from "node:net";
import { connect } from "amqplib";
import { createFixture } from "./test-fixture.ts";
import { createApplication } from "./app.ts";
import { createClient } from "@kanvil/client";
import { adminInstanceSchema } from "@kanvil/contracts/instance";

async function waitFor(assertion: () => void | Promise<void>) {
  await expect.poll(assertion, { timeout: 20000, interval: 100 }).toBeUndefined();
}
const brokerUrl = process.env.TEST_RABBITMQ_URL;
describe.skipIf(!brokerUrl)("optional RabbitMQ event delivery", () => {
  let fixture: Awaited<ReturnType<typeof createFixture>>,
    first: Awaited<ReturnType<typeof createApplication>>,
    second: Awaited<ReturnType<typeof createApplication>>,
    cookie = "",
    proxyUrl = "",
    allowConnections = true;
  const sockets = new Set<Socket>(),
    proxy = createServer((client) => {
      sockets.add(client);
      client.on("close", () => sockets.delete(client));
      client.on("error", () => {});
      if (!allowConnections) {
        client.destroy();
        return;
      }
      const target = new URL(brokerUrl ?? "amqp://localhost");
      const upstream = connectTcp({ host: target.hostname, port: Number(target.port) || 5672 });
      sockets.add(upstream);
      upstream.on("close", () => {
        sockets.delete(upstream);
        client.destroy();
      });
      upstream.on("error", () => client.destroy());
      client.on("close", () => upstream.destroy());
      client.pipe(upstream).pipe(client);
    });
  const request = (path: string, method = "GET", body?: unknown) =>
    first.app.fetch(
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
  beforeAll(async () => {
    fixture = await createFixture();
    await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
    const address = proxy.address();
    if (!address || typeof address === "string") throw new Error("Proxy did not open");
    const url = new URL(brokerUrl ?? "amqp://localhost");
    url.hostname = "127.0.0.1";
    url.port = String(address.port);
    proxyUrl = url.toString();
    first = await createApplication(fixture.database, fixture.config);
    await request("/api/v1/setup", "POST", {
      token: fixture.config.KANVIL_SETUP_TOKEN,
      name: "Broker admin",
      email: "broker@example.test",
      password: "Isolated-broker-password-123",
    });
    const login = await request("/api/auth/sign-in/email", "POST", {
      email: "broker@example.test",
      password: "Isolated-broker-password-123",
    });
    cookie = login.headers
      .getSetCookie()
      .map((value) => value.split(";")[0])
      .join("; ");
    second = await createApplication(fixture.database, fixture.config);
  });
  afterAll(async () => {
    allowConnections = true;
    await first?.close();
    await second?.close();
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => proxy.close(() => resolve()));
    if (fixture) {
      const settings = await fixture.database.pool.query("SELECT identity FROM instance_settings");
      const identity = String(settings.rows[0]?.identity ?? "");
      if (brokerUrl && identity) {
        const connection = await connect(brokerUrl);
        connection.on("error", () => {});
        const channel = await connection.createChannel();
        await channel.deleteExchange(`kanvil.test.${identity}`);
        await connection.close();
      }
      await fixture.close();
    }
  });
  it("configures without exposing credentials, fans out to replicas, and recovers from a broker outage", async () => {
    const initial = adminInstanceSchema.parse(
      await (await request("/api/v1/admin/instance")).json(),
    );
    const payload = {
      expectedVersion: initial.version,
      name: initial.name,
      description: initial.description,
      storage: { provider: "local" },
      search: { provider: "postgres" },
      broker: { provider: "rabbitmq", url: proxyUrl, exchange: `kanvil.test.${initial.id}` },
    };
    const saved = await request("/api/v1/admin/instance", "PATCH", payload);
    expect(saved.status, await saved.text()).toBe(200);
    await waitFor(() => {
      expect(first.realtime.status().status).toBe("ready");
      expect(second.realtime.status().status).toBe("ready");
    });
    const info = await (await request("/api/v1/admin/instance")).text();
    expect(info).not.toContain("isolated-test-password");
    expect(info).not.toContain("kanvil-test@");
    expect(
      JSON.stringify(
        (await fixture.database.pool.query("SELECT broker_config FROM instance_settings")).rows,
      ),
    ).not.toContain(proxyUrl);
    let wakes = 0;
    const unsubscribe = second.realtime.subscribe(() => {
      wakes++;
    });
    const client = createClient({
      baseUrl: "http://localhost:5180",
      headers: () => ({ Cookie: cookie, Origin: "http://localhost:5180" }),
      fetch: async (input, init) => first.app.fetch(new Request(input, init)),
    });
    const project = await client.call("create_project", {
      key: "RABBIT",
      name: "RabbitMQ fixture",
    });
    const before = wakes;
    await client.call("create_ticket", { projectId: project.id, title: "Confirmed fanout" });
    await waitFor(() => {
      expect(wakes).toBeGreaterThan(before);
    });
    await waitFor(async () => {
      const result = await fixture.database.pool.query(
        "SELECT d.cursor=c.value AS caught_up FROM delivery_checkpoints d CROSS JOIN event_clock c",
      );
      expect(result.rows[0]?.caught_up).toBe(true);
    });
    allowConnections = false;
    for (const socket of sockets) socket.destroy();
    await waitFor(() => {
      expect(first.realtime.status().status).toBe("unavailable");
      expect(second.realtime.status().status).toBe("unavailable");
    });
    const fallback = wakes;
    await client.call("create_ticket", {
      projectId: project.id,
      title: "Works while the broker is down",
    });
    await waitFor(() => {
      expect(wakes).toBeGreaterThan(fallback);
    });
    expect(
      (
        await request("/api/v1/admin/instance", "PATCH", {
          ...payload,
          expectedVersion: initial.version + 1,
          name: "Renamed during outage",
          broker: { provider: "rabbitmq", exchange: payload.broker.exchange },
        })
      ).status,
    ).toBe(200);
    allowConnections = true;
    await waitFor(() => {
      expect(first.realtime.status().status).toBe("ready");
      expect(second.realtime.status().status).toBe("ready");
    });
    await waitFor(async () => {
      const result = await fixture.database.pool.query(
        "SELECT d.cursor=c.value AS caught_up FROM delivery_checkpoints d CROSS JOIN event_clock c",
      );
      expect(result.rows[0]?.caught_up).toBe(true);
    });
    const recovered = wakes;
    await client.call("create_ticket", {
      projectId: project.id,
      title: "Delivered after reconnect",
    });
    await waitFor(() => {
      expect(wakes).toBeGreaterThan(recovered);
    });
    unsubscribe();
    // Older configuration clients omit broker; they must preserve the existing provider.
    const latest = adminInstanceSchema.parse(
      await (await request("/api/v1/admin/instance")).json(),
    );
    const { broker: _broker, ...legacy } = payload;
    expect(
      (
        await request("/api/v1/admin/instance", "PATCH", {
          ...legacy,
          expectedVersion: latest.version,
        })
      ).status,
    ).toBe(200);
    expect((await first.instance.broker())?.url).toBe(proxyUrl);
  }, 60000);
});
