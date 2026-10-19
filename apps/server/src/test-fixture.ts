import pg from "pg";
import { createServer } from "node:net";
import { createDatabase, type Database } from "./database.ts";
import { migrateDatabase } from "./migrate.ts";
import { readConfig } from "./config.ts";
import { createAuth } from "./auth.ts";
import { recordBoundary } from "../../../scripts/testing/boundaries.ts";

export async function createFixture({
  beforeMigrate,
}: { beforeMigrate?: (database: Database) => Promise<void> } = {}) {
  const url = new URL(
    process.env.TEST_DATABASE_URL ?? "postgres://kanvil:kanvil@127.0.0.1:55462/kanvil",
  );
  const admin = new pg.Pool({ connectionString: url.toString() });
  const name = `kanvil_test_${crypto.randomUUID().replaceAll("-", "")}`;
  await admin.query(`CREATE DATABASE "${name}"`);
  recordBoundary("databases");
  url.pathname = `/${name}`;
  const database = createDatabase(url.toString());
  const config = readConfig({
    NODE_ENV: "test",
    DATABASE_URL: url.toString(),
    KANVIL_URL: "http://localhost:5180",
    BETTER_AUTH_SECRET: crypto.randomUUID(),
    KANVIL_SETUP_TOKEN: crypto.randomUUID(),
    // Repository connections in tests never reach GitHub; suites that need a host run a fake one.
    KANVIL_GITHUB_API_URL: "https://api.github.kanvil.invalid",
  });
  try {
    await beforeMigrate?.(database);
    await migrateDatabase(database);
    recordBoundary("migrations");
  } catch (error) {
    await database.pool.end();
    await admin.query(`DROP DATABASE "${name}"`);
    await admin.end();
    throw error;
  }
  const auth = createAuth(database, config);
  return {
    database,
    config,
    auth,
    async close() {
      await database.pool.end();
      await admin.query(`DROP DATABASE "${name}"`);
      await admin.end();
    },
  };
}

// A local SMTP server that accepts every message, so email never leaves the machine. Quoted-printable
// messages are kept decoded.
export async function startMailbox(onMessage?: (message: string) => void) {
  const messages: string[] = [];
  // While set, the relay refuses every message with a permanent failure.
  const state = { rejecting: false };
  const server = createServer((socket) => {
    let buffer = "",
      body: string | undefined;
    socket.write("220 fake ESMTP\r\n");
    socket.on("data", (chunk: Buffer) => {
      buffer += chunk.toString();
      for (let end = buffer.indexOf("\r\n"); end >= 0; end = buffer.indexOf("\r\n")) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        if (body !== undefined) {
          if (line === "." && state.rejecting) {
            body = undefined;
            socket.write("550 rejected\r\n");
          } else if (line === ".") {
            const message = body.includes("Content-Transfer-Encoding: quoted-printable")
              ? body
                  .replaceAll("=\n", "")
                  .replace(/=([0-9A-F]{2})/g, (_, hex: string) =>
                    String.fromCharCode(parseInt(hex, 16)),
                  )
              : body;
            messages.push(message);
            onMessage?.(message);
            body = undefined;
            socket.write("250 queued\r\n");
          } else body += `${line}\n`;
          continue;
        }
        const command = line.slice(0, 4).toUpperCase();
        if (command === "DATA") {
          body = "";
          socket.write("354 send\r\n");
        } else if (command === "QUIT") socket.end("221 bye\r\n");
        else socket.write("250 ok\r\n");
      }
    });
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected a TCP listener");
  return {
    messages,
    state,
    url: `smtp://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((done) => server.close(() => done())),
  };
}
