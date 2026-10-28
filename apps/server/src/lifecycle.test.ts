import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { createApplication } from "./app.ts";
import { createDatabase } from "./database.ts";
import { createInstance } from "./instance.ts";
import { createEventDelivery } from "./event-delivery.ts";
import { createFixture } from "./test-fixture.ts";
import { readConfig } from "./config.ts";
import type { JobScheduler } from "./adapters/ports.ts";

const state = vi.hoisted(() => {
  const controls: { createError?: Error } = {};
  const pools: FakePool[] = [];
  const clients: FakeClient[] = [];
  class FakePool {
    query = vi.fn(async (sql: unknown) => {
      if (typeof sql === "string" && sql.startsWith("CREATE DATABASE") && controls.createError)
        throw controls.createError;
      return { rows: [] };
    });
    end = vi.fn(async () => {});
    on = vi.fn();
    constructor() {
      pools.push(this);
    }
  }
  class FakeClient {
    connect = vi.fn(async () => {});
    query = vi.fn(async () => {});
    end = vi.fn(async () => {});
    on = vi.fn();
    constructor() {
      clients.push(this);
    }
  }
  return {
    pools,
    clients,
    FakePool,
    FakeClient,
    controls,
    read: vi.fn(async () => ({ identity: "15a831fa-9240-4870-bdc5-038c51ba03b3" })),
    migrate: vi.fn(async () => {}),
  };
});
vi.mock("pg", () => ({ default: { Pool: state.FakePool, Client: state.FakeClient } }));
vi.mock("./instance.ts", () => ({
  createInstance: vi.fn((_database, config) => ({
    config,
    read: state.read,
    broker: async () => null,
  })),
}));
vi.mock("./migrate.ts", () => ({ migrateDatabase: state.migrate }));
vi.mock("../../../scripts/testing/boundaries.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../scripts/testing/boundaries.ts")>()),
  // The fake pg driver creates no database; keep real socket enforcement and reporting intact.
  recordBoundary: vi.fn(),
}));

const config = readConfig({
  NODE_ENV: "test",
  DATABASE_URL: "postgres://test:test@127.0.0.1:55462/test",
  KANVIL_URL: "http://localhost:5180",
  BETTER_AUTH_SECRET: "test-only-lifecycle-secret-12345678",
});
const startupError = new Error("startup failed");
let closed: string[], failJob: string | undefined, throwJob: string | undefined;
const jobs: JobScheduler = (_name, _interval, _run) => {
  if (_name === throwJob) throw startupError;
  return {
    trigger: _run,
    async close() {
      closed.push(_name);
      if (_name === failJob) throw new Error("postgres://private:password@secret.invalid/db");
    },
  };
};
beforeEach(() => {
  delete state.controls.createError;
  state.pools.length = 0;
  state.clients.length = 0;
  state.read.mockReset().mockResolvedValue({ identity: "15a831fa-9240-4870-bdc5-038c51ba03b3" });
  state.migrate.mockReset().mockResolvedValue(undefined);
  closed = [];
  failJob = undefined;
  throwJob = undefined;
});
afterEach(() => {
  vi.restoreAllMocks();
});

it("unwinds application startup without closing the supplied database", async () => {
  const database = createDatabase(config.DATABASE_URL);
  await expect(
    createApplication(database, config, {
      jobs,
      realtime: async () => {
        throw startupError;
      },
    }),
  ).rejects.toBe(startupError);
  expect(closed).toEqual(["ticket-index", "blob-transfer", "blob-cleanup"]);
  expect(state.pools[1]?.end).toHaveBeenCalledOnce();
  expect(state.pools[0]?.end).not.toHaveBeenCalled();
});

it("releases the application pool when the first instance read fails", async () => {
  state.read.mockRejectedValueOnce(startupError);
  await expect(
    createApplication(createDatabase(config.DATABASE_URL), config, { jobs }),
  ).rejects.toBe(startupError);
  expect(state.pools[1]?.end).toHaveBeenCalledOnce();
});

it("unwinds a partially constructed blob owner when its second job fails", async () => {
  throwJob = "blob-transfer";
  await expect(
    createApplication(createDatabase(config.DATABASE_URL), config, { jobs }),
  ).rejects.toBe(startupError);
  expect(closed).toEqual(["blob-cleanup"]);
  expect(state.pools[1]?.end).toHaveBeenCalledOnce();
});

it("attempts all closes in dependency order and shares the result on repeated close", async () => {
  const application = await createApplication(createDatabase(config.DATABASE_URL), config, {
    jobs,
  });
  failJob = "blob-transfer";
  const result = await application.close().catch((error: unknown) => error);
  expect(result).toBeInstanceOf(AggregateError);
  if (!(result instanceof AggregateError)) throw new Error("Expected a cleanup aggregate");
  expect(result.errors.map((error: unknown) => String(error))).toEqual([
    "Error: Could not close blob-transfer.",
  ]);
  expect(closed).toEqual([
    "imports",
    "due-reminders",
    "outbox",
    "ticket-index",
    "blob-transfer",
    "blob-cleanup",
  ]);
  expect(state.clients[0]?.end).toHaveBeenCalledOnce();
  expect(state.pools[1]?.end).toHaveBeenCalledOnce();
  expect(state.pools[0]?.end).not.toHaveBeenCalled();
  await expect(application.close()).rejects.toBe(result);
  await expect(application.close()).rejects.toBe(result);
  expect(closed).toHaveLength(6);
  expect(state.clients[0]?.end).toHaveBeenCalledOnce();
  expect(state.pools[1]?.end).toHaveBeenCalledOnce();
});

it("preserves startup errors and reports cleanup failures without adapter secrets", async () => {
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  failJob = "blob-transfer";
  await expect(
    createApplication(createDatabase(config.DATABASE_URL), config, {
      jobs,
      realtime: async () => {
        throw startupError;
      },
    }),
  ).rejects.toBe(startupError);
  expect(log).toHaveBeenCalled();
  expect(JSON.stringify(log.mock.calls)).not.toContain("password");
  expect(closed).toContain("blob-cleanup");
  expect(state.pools[1]?.end).toHaveBeenCalledOnce();
});

it("closes the LISTEN client when event-delivery initialization fails", async () => {
  const database = createDatabase(config.DATABASE_URL);
  state.read.mockRejectedValueOnce(startupError);
  await expect(
    createEventDelivery(config, createInstance(database, config), database),
  ).rejects.toBe(startupError);
  expect(state.clients[0]?.end).toHaveBeenCalledOnce();
  expect(state.pools[0]?.end).not.toHaveBeenCalled();
});

it("makes event-delivery close safe to repeat concurrently", async () => {
  const database = createDatabase(config.DATABASE_URL);
  const delivery = await createEventDelivery(config, createInstance(database, config), database);
  await Promise.all([delivery.close(), delivery.close()]);
  await delivery.close();
  expect(state.clients[0]?.end).toHaveBeenCalledOnce();
});

it("closes PostgreSQL even when an event-delivery close listener throws", async () => {
  const database = createDatabase(config.DATABASE_URL);
  const delivery = await createEventDelivery(config, createInstance(database, config), database);
  delivery.onClose(() => {
    throw new Error("private listener failure");
  });
  await expect(delivery.close()).rejects.toBeInstanceOf(AggregateError);
  expect(state.clients[0]?.end).toHaveBeenCalledOnce();
  await expect(delivery.close()).rejects.toBeInstanceOf(AggregateError);
  expect(state.clients[0]?.end).toHaveBeenCalledOnce();
});

it("ends the fixture admin pool when CREATE DATABASE fails", async () => {
  state.controls.createError = startupError;
  await expect(createFixture()).rejects.toBe(startupError);
  expect(state.pools).toHaveLength(1);
  expect(state.pools[0]?.end).toHaveBeenCalledOnce();
});

it("ends fixture pools and preserves migration failure when DROP also fails", async () => {
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  state.migrate.mockRejectedValueOnce(startupError);
  await expect(
    createFixture({
      beforeMigrate: async () => {
        state.pools[0]!.query.mockRejectedValueOnce(new Error("private drop error"));
      },
    }),
  ).rejects.toBe(startupError);
  expect(state.pools[1]?.end).toHaveBeenCalledOnce();
  expect(state.pools[0]?.end).toHaveBeenCalledOnce();
  expect(log).toHaveBeenCalled();
});

it("ends the fixture admin pool after failed DROP and safely repeats close", async () => {
  const fixture = await createFixture();
  state.pools[0]!.query.mockRejectedValueOnce(new Error("private drop error"));
  await expect(fixture.close()).rejects.toBeInstanceOf(AggregateError);
  expect(state.pools[0]?.end).toHaveBeenCalledOnce();
  expect(state.pools[1]?.end).toHaveBeenCalledOnce();
  await expect(fixture.close()).rejects.toBeInstanceOf(AggregateError);
  await expect(fixture.close()).rejects.toBeInstanceOf(AggregateError);
  expect(state.pools[1]?.end).toHaveBeenCalledOnce();
});
