import { connect, type ChannelModel, type ConfirmChannel } from "amqplib";
import { brokerSettingsSchema } from "@kanvil/contracts/instance";
import type { WakeupBusFactory } from "./ports.ts";

export async function bounded<T>(operation: Promise<T>, milliseconds = 5000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("Broker operation timed out")), milliseconds);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export const createRabbitMqBus: WakeupBusFactory = async (configuration, receive, changed) => {
  const settings = brokerSettingsSchema.parse(configuration.config);
  if (!settings.url) throw new Error("RabbitMQ connection URL is required");
  const url = new URL(settings.url);
  if (!url.searchParams.has("heartbeat")) url.searchParams.set("heartbeat", "10");
  let channel: ConfirmChannel | undefined,
    available = false;
  const connection = await connect(url.toString(), {
    timeout: 5000,
    keepAlive: true,
    clientProperties: { connection_name: "Kanvil event delivery" },
    recovery: {
      waitForConnect: false,
      initialDelay: 1000,
      maxDelay: 10000,
      async setup(model: ChannelModel) {
        available = false;
        const next = await model.createConfirmChannel();
        next.on("error", () => {});
        next.on("close", () => {
          if (channel === next) {
            available = false;
            changed();
          }
        });
        await bounded(
          (async () => {
            await next.assertExchange(settings.exchange, "fanout", { durable: true });
            const queue = await next.assertQueue("", {
              exclusive: true,
              autoDelete: true,
              durable: false,
              arguments: { "x-max-length": 1000, "x-overflow": "drop-head" },
            });
            await next.bindQueue(queue.queue, settings.exchange, "");
            await next.prefetch(20);
            await next.consume(
              queue.queue,
              (message) => {
                if (!message) {
                  available = false;
                  changed();
                  return;
                }
                try {
                  if (message.content.length <= 2048) receive(message.content.toString());
                } finally {
                  next.ack(message);
                }
              },
              { noAck: false },
            );
          })(),
        );
        channel = next;
        available = true;
        changed();
      },
    },
  });
  const unavailable = () => {
    available = false;
    changed();
  };
  connection.on("error", unavailable);
  connection.on("disconnect", unavailable);
  connection.on("connect-failed", unavailable);
  connection.on("blocked", unavailable);
  connection.on("unblocked", () => {
    available = !!channel;
    changed();
  });
  return {
    ready: () => available,
    async publish(message) {
      const current = channel;
      if (!current || !available) throw new Error("RabbitMQ is unavailable");
      // Only one small notification is outstanding; confirms also bound producer backpressure.
      await bounded(
        new Promise<void>((resolve, reject) => {
          current.publish(
            settings.exchange,
            "",
            Buffer.from(message),
            { persistent: true, contentType: "application/json" },
            (error) =>
              error ? reject(new Error("RabbitMQ did not confirm publication")) : resolve(),
          );
        }),
      );
    },
    async close() {
      available = false;
      await bounded(connection.close());
    },
  };
};
