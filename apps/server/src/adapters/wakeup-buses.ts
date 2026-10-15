import type { WakeupBusFactory } from "./ports.ts";
import { createRabbitMqBus } from "./rabbitmq.ts";
const providers: Record<string, WakeupBusFactory> = { rabbitmq: createRabbitMqBus };
export const createWakeupBus: WakeupBusFactory = (configuration, receive, changed) => {
  const factory = providers[configuration.provider];
  if (!factory) throw new Error("Unsupported event delivery provider");
  return factory(configuration, receive, changed);
};
