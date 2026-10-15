import { spawn } from "node:child_process";
import { pipeline } from "node:stream/promises";
import type { Readable, Writable } from "node:stream";

export function databaseName(value: string | undefined): string {
  if (!value || !/^[a-z][a-z0-9_]{0,62}$/.test(value))
    throw new Error(
      "Use a database name containing lowercase letters, numbers, and underscores, starting with a letter.",
    );
  return value;
}
export async function postgres(
  command: string,
  database: string,
  streams: { input?: Readable; output?: Writable } = {},
) {
  const scripts: Record<string, string> = {
    dump: 'exec pg_dump -U "$POSTGRES_USER" -d "$1" --format=custom',
    create: 'exec createdb -U "$POSTGRES_USER" -- "$1"',
    restore: 'exec pg_restore -U "$POSTGRES_USER" -d "$1" --exit-on-error --single-transaction',
  };
  const script = scripts[command];
  if (!script) throw new Error("Unknown PostgreSQL operation");
  const child = spawn(
    "docker",
    ["compose", "exec", "-T", "db", "sh", "-c", script, "--", databaseName(database)],
    { stdio: [streams.input ? "pipe" : "ignore", streams.output ? "pipe" : "inherit", "inherit"] },
  );
  const exited = new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) =>
      code === 0 ? resolve() : reject(new Error(`PostgreSQL ${command} failed (${code})`)),
    );
  });
  try {
    await Promise.all([
      exited,
      ...(streams.input && child.stdin ? [pipeline(streams.input, child.stdin)] : []),
      ...(streams.output && child.stdout ? [pipeline(child.stdout, streams.output)] : []),
    ]);
  } catch (error) {
    child.kill("SIGTERM");
    throw error;
  }
}
