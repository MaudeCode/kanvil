import { EventEmitter } from "node:events";
import { createHash } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { z } from "zod";
import type { BrokerSettings } from "@kanvil/contracts/instance";
import { createRealtime } from "./realtime.ts";
import type { Realtime } from "./realtime.ts";
import { createCleanup } from "./cleanup.ts";
import { createWakeupBus } from "./adapters/wakeup-buses.ts";
import { bounded } from "./adapters/rabbitmq.ts";
import type { WakeupBus, WakeupBusFactory } from "./adapters/ports.ts";
import type { Config } from "./config.ts";
import type { Database } from "./database.ts";
import type { Instance } from "./instance.ts";
import { deliveryCheckpoints, eventClock } from "./schema.ts";
import { fail } from "./domain.ts";

const messageSchema = z.object({ instanceId: z.uuid(), cursor: z.string().regex(/^\d+$/) });
export function brokerEndpoint(settings: BrokerSettings) {
  if (!settings.url) return "";
  const url = new URL(settings.url);
  return `${url.protocol}//${url.host}${url.pathname}`;
}
export async function createEventDelivery(
  config: Config,
  instance: Instance,
  database: Database,
  factory: WakeupBusFactory = createWakeupBus,
) {
  const cleanup = createCleanup();
  try {
    const postgres = await createRealtime(config);
    cleanup.add("PostgreSQL realtime client", () => postgres.close());
    return await initializeEventDelivery(instance, database, factory, postgres, cleanup);
  } catch (error) {
    return cleanup.fail(error);
  }
}

async function initializeEventDelivery(
  instance: Instance,
  database: Database,
  factory: WakeupBusFactory,
  postgres: Realtime,
  cleanup: ReturnType<typeof createCleanup>,
) {
  const emitter = new EventEmitter();
  emitter.setMaxListeners(0);
  cleanup.add("realtime listeners", () => {
    try {
      emitter.emit("close");
    } finally {
      emitter.removeAllListeners();
    }
  });
  const identity = (await instance.read()).identity;
  let bus: WakeupBus | undefined,
    fingerprint = "",
    destination = "",
    closed = false,
    pending: Promise<void> | undefined,
    dirty = false,
    error: string | null = null;
  const wake = () => emitter.emit("change");
  function receive(message: string) {
    try {
      const parsed = messageSchema.safeParse(JSON.parse(message));
      if (parsed.success && parsed.data.instanceId === identity) wake();
    } catch {
      /* A shared exchange can contain other applications' messages. */
    }
  }
  async function process() {
    const settings = await instance.broker(),
      next = JSON.stringify(settings);
    if (next !== fingerprint) {
      const old = bus;
      bus = undefined;
      fingerprint = next;
      await old?.close().catch(() => {});
      if (settings) {
        destination = createHash("sha256")
          .update(JSON.stringify([identity, brokerEndpoint(settings), settings.exchange]))
          .digest("hex");
        bus = await factory({ provider: "rabbitmq", config: settings }, receive, () => {
          if (!closed) {
            wake();
            trigger();
          }
        });
      }
      error = null;
      wake();
    }
    if (!bus) return;
    if (!bus.ready()) {
      error = "RabbitMQ is unavailable. PostgreSQL is delivering event wakeups.";
      return;
    }
    await database.db.transaction(async (tx) => {
      const lock = await tx.execute(sql`SELECT pg_try_advisory_xact_lock(7361085) AS locked`);
      if (!lock.rows[0]?.locked) return;
      const clock =
        (await tx.select().from(eventClock).where(eq(eventClock.id, 1)))[0]?.value ?? 0n;
      const checkpoint =
        (
          await tx
            .select()
            .from(deliveryCheckpoints)
            .where(eq(deliveryCheckpoints.destination, destination))
        )[0]?.cursor ?? 0n;
      if (clock <= checkpoint) return;
      await bus?.publish(JSON.stringify({ instanceId: identity, cursor: clock.toString() }));
      await tx
        .insert(deliveryCheckpoints)
        .values({ destination, cursor: clock })
        .onConflictDoUpdate({ target: deliveryCheckpoints.destination, set: { cursor: clock } });
    });
    error = null;
  }
  function trigger() {
    if (closed) return;
    dirty = true;
    pending ??= (async () => {
      while (dirty) {
        dirty = false;
        if (closed) break;
        try {
          await process();
        } catch {
          error = "RabbitMQ is unavailable. PostgreSQL is delivering event wakeups.";
          if (!bus) fingerprint = "";
          wake();
        }
      }
    })().finally(() => {
      pending = undefined;
    });
  }
  const unsubscribe = postgres.subscribe(() => {
    if (!bus?.ready() || error) wake();
    trigger();
  });
  cleanup.add("broker connection", async () => {
    await bus?.close();
  });
  cleanup.add("broker worker", async () => {
    closed = true;
    await pending;
  });
  cleanup.add("PostgreSQL subscription", unsubscribe);
  const timer = setInterval(() => {
    if (error) wake();
    trigger();
  }, 1000);
  timer.unref();
  cleanup.add("broker timer", () => {
    closed = true;
    clearInterval(timer);
  });
  trigger();
  return {
    subscribe(listener: () => void) {
      emitter.on("change", listener);
      return () => {
        emitter.off("change", listener);
      };
    },
    onClose(listener: () => void) {
      emitter.on("close", listener);
      return () => {
        emitter.off("close", listener);
      };
    },
    status() {
      return {
        status:
          !bus && fingerprint === "null"
            ? "builtin"
            : error
              ? "unavailable"
              : bus?.ready()
                ? "ready"
                : "connecting",
        error,
      };
    },
    async test(settings: BrokerSettings) {
      const token = crypto.randomUUID();
      let received: (() => void) | undefined;
      const readback = new Promise<void>((resolve) => {
        received = resolve;
      });
      const probe = await factory(
        { provider: "rabbitmq", config: settings },
        (value) => {
          if (value === token) received?.();
        },
        () => {},
      );
      try {
        const deadline = Date.now() + 5000;
        while (!probe.ready()) {
          if (Date.now() >= deadline) throw new Error("Broker connection timed out");
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
        await probe.publish(token);
        await bounded(readback);
      } catch {
        fail(
          503,
          "broker_unavailable",
          "RabbitMQ connection could not be verified. Check its URL, exchange, and permissions.",
        );
      } finally {
        await probe.close().catch(() => {});
      }
    },
    close: cleanup.close,
  };
}
export type EventDelivery = Awaited<ReturnType<typeof createEventDelivery>>;
