import pg from "pg";
import { EventEmitter } from "node:events";
import type { Config } from "./config.ts";

export async function createRealtime(config: Config) {
  const emitter = new EventEmitter();
  emitter.setMaxListeners(0);
  let client: pg.Client | undefined,
    closed = false,
    retry: ReturnType<typeof setTimeout> | undefined;
  async function connect() {
    if (closed) return;
    const connection = new pg.Client({ connectionString: config.DATABASE_URL });
    client = connection;
    const disconnected = () => {
      if (client !== connection || closed) return;
      client = undefined;
      void connection.end().catch(() => {});
      clearTimeout(retry);
      retry = setTimeout(() => {
        void connect();
      }, 1000);
    };
    connection.on("error", disconnected);
    connection.on("end", disconnected);
    connection.on("notification", () => emitter.emit("change"));
    try {
      await connection.connect();
      await connection.query("LISTEN kanvil_events");
      emitter.emit("change");
    } catch {
      disconnected();
    }
  }
  await connect();
  return {
    subscribe(listener: () => void) {
      emitter.on("change", listener);
      return () => {
        emitter.off("change", listener);
      };
    },
    async close() {
      closed = true;
      clearTimeout(retry);
      emitter.emit("close");
      emitter.removeAllListeners();
      await client?.end();
    },
    onClose(listener: () => void) {
      emitter.on("close", listener);
      return () => {
        emitter.off("close", listener);
      };
    },
  };
}
export type Realtime = Awaited<ReturnType<typeof createRealtime>>;
