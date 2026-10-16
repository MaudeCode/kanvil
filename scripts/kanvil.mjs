#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";

const command = process.argv[2] ?? "start";
if (command === "--version") {
  console.info(
    JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version,
  );
} else if (command === "--help") {
  console.info(
    "Usage: kanvil [start | configure --production https://kanvil.example.com | migrate | recover --email admin@example.com]\nReads .env from the current directory. Requires Node 24 and PostgreSQL 18.",
  );
} else {
  const entries = {
    start: "index",
    configure: "configure",
    migrate: "migrate",
    recover: "recover",
  };
  if (!Object.hasOwn(entries, command)) throw new Error(`Unknown command: ${command}. Use --help.`);
  if (process.argv[2]) process.argv.splice(2, 1);
  if (command !== "configure") {
    if (existsSync(".env")) process.loadEnvFile(".env");
    process.env.NODE_ENV ??= "production";
  }
  await import(new URL(`../apps/server/dist/${entries[command]}.mjs`, import.meta.url));
}
