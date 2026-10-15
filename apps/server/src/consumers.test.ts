import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFixture } from "./test-fixture.ts";
import { createApplication } from "./app.ts";
import { createClient } from "../../../packages/client/src/index.ts";
import { mirrorProject } from "../../../examples/mirror-project.ts";
import { inspectMcpProject } from "../../../examples/mcp-client.ts";
import { z } from "zod";
import { snapshotSchema } from "../../../packages/contracts/src/index.ts";

describe("reference consumers", () => {
  let fixture: Awaited<ReturnType<typeof createFixture>>,
    application: Awaited<ReturnType<typeof createApplication>>,
    directory: string;
  beforeAll(async () => {
    fixture = await createFixture();
    application = await createApplication(fixture.database, fixture.config);
    directory = await mkdtemp(join(tmpdir(), "kanvil-consumers-"));
  });
  afterAll(async () => {
    await application?.close();
    await fixture?.close();
    await rm(directory, { recursive: true, force: true });
  });
  async function setup() {
    const created = await fixture.auth.api.createUser({
      body: {
        name: "Consumer owner",
        email: `${crypto.randomUUID()}@example.test`,
        password: "Isolated consumer password 42!",
        role: "user",
      },
    });
    const owner = await application.domain.actor(created.user.id);
    const project = await application.domain.execute(
      "create_project",
      { key: `R${crypto.randomUUID().slice(0, 8).toUpperCase()}`, name: "Consumer project" },
      owner,
    );
    const other = await application.domain.execute(
      "create_project",
      { key: `R${crypto.randomUUID().slice(0, 8).toUpperCase()}`, name: "Private other project" },
      owner,
    );
    const key = await fixture.auth.api.createApiKey({
      body: {
        userId: owner.id,
        name: "Reference consumer",
        metadata: { projectIds: [project.id] },
        permissions: { kanvil: ["read"] },
        expiresIn: 3600,
        rateLimitEnabled: true,
        rateLimitMax: 600,
        rateLimitTimeWindow: 60000,
      },
    });
    const fetch: typeof globalThis.fetch = async (input, init) =>
      application.app.fetch(new Request(input, init));
    const client = createClient({
      baseUrl: fixture.config.KANVIL_URL,
      headers: () => ({ Authorization: `Bearer ${key.key}` }),
      fetch,
    });
    return { owner, project, other, key, fetch, client };
  }
  it("reads scoped work through the official MCP transport", async () => {
    const { owner, project, other, key, fetch } = await setup();
    const ticket = await application.domain.execute(
      "create_ticket",
      { projectId: project.id, title: "MCP reference context" },
      owner,
    );
    const data = await inspectMcpProject({
      baseUrl: fixture.config.KANVIL_URL,
      key: key.key,
      projectId: project.key,
      fetch,
    });
    expect(data.projects.map((row) => row.id)).toEqual([project.id]);
    expect(data.tickets.items[0]?.id).toBe(ticket.id);
    await expect(
      inspectMcpProject({
        baseUrl: fixture.config.KANVIL_URL,
        key: key.key,
        projectId: other.id,
        fetch,
      }),
    ).rejects.toThrow("failed");
  });
  it("persists a consistent mirror through writes, service restart, and an expired replay cursor", async () => {
    const { owner, project, other, client } = await setup();
    const first = await application.domain.execute(
      "create_ticket",
      { projectId: project.id, title: "Initial mirror ticket" },
      owner,
    );
    const output = join(directory, "project.json"),
      failures: unknown[] = [];
    const read = async () =>
      z.object({ snapshot: snapshotSchema }).parse(JSON.parse(await readFile(output, "utf8")))
        .snapshot;
    const start = () => {
      const controller = new AbortController();
      const running = mirrorProject({
        client,
        baseUrl: fixture.config.KANVIL_URL,
        projectId: project.key,
        output,
        signal: controller.signal,
      }).catch((error: unknown) => {
        failures.push(error);
      });
      return async () => {
        controller.abort();
        await running;
      };
    };
    let stop = start();
    try {
      await expect
        .poll(async () => (await read()).tickets.map((row) => row.id))
        .toEqual([first.id]);
      expect((await stat(output)).mode & 0o777).toBe(0o600);
      const second = await application.domain.execute(
        "create_ticket",
        { projectId: project.id, title: "Live second ticket" },
        owner,
      );
      await application.domain.execute(
        "update_ticket",
        {
          projectId: project.id,
          ticketId: first.id,
          expectedVersion: 1,
          changes: { title: "Updated live" },
        },
        owner,
      );
      await expect
        .poll(async () => (await read()).tickets.find((row) => row.id === first.id)?.version)
        .toBe(2);
      await stop();
      await application.domain.execute(
        "delete_ticket",
        { projectId: project.id, ticketId: second.id, expectedVersion: 1 },
        owner,
      );
      await application.close();
      application = await createApplication(fixture.database, fixture.config);
      stop = start();
      await expect
        .poll(async () => (await read()).tickets.map((row) => row.id))
        .toEqual([first.id]);
      await stop();
      const missed = await application.domain.execute(
        "create_ticket",
        { projectId: project.id, title: "Written beyond retained cursor" },
        owner,
      );
      await fixture.database.pool.query("UPDATE event_clock SET floor = value");
      stop = start();
      await expect
        .poll(async () => (await read()).tickets.map((row) => row.id))
        .toEqual([first.id, missed.id]);
      await expect(
        mirrorProject({
          client,
          baseUrl: fixture.config.KANVIL_URL,
          projectId: other.id,
          output,
          signal: new AbortController().signal,
        }),
      ).rejects.toThrow("different output file");
    } finally {
      await stop();
    }
    expect(failures).toEqual([]);
  });
});
