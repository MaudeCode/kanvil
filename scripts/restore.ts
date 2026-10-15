import { createReadStream } from "node:fs";
import { open } from "node:fs/promises";
import { parseArgs } from "node:util";
import { databaseName, postgres } from "./postgres.ts";

const { values } = parseArgs({
  options: { file: { type: "string" }, database: { type: "string" } },
});
if (!values.file)
  throw new Error(
    "Pass --file <backup.dump> and --database <new-database-name>. Existing databases are never overwritten.",
  );
const database = databaseName(values.database);
const file = await open(values.file, "r");
try {
  const header = Buffer.alloc(5);
  await file.read(header, 0, 5, 0);
  if (header.toString() !== "PGDMP")
    throw new Error("Choose a PostgreSQL custom-format backup created by pnpm backup.");
} finally {
  await file.close();
}
await postgres("create", database);
await postgres("restore", database, { input: createReadStream(values.file) });
console.info(
  `Restored into ${database}. Set KANVIL_DATABASE=${database} in .env, keep the original BETTER_AUTH_SECRET, and restart the app. The previous database is retained.`,
);
