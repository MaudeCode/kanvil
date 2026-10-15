import { open, unlink } from "node:fs/promises";
import { parseArgs } from "node:util";
import { postgres, databaseName } from "./postgres.ts";

const { values } = parseArgs({ options: { output: { type: "string" } } });
if (!values.output)
  throw new Error(
    "Pass --output <new-backup.dump>. Keep your private .env configuration securely with the backup.",
  );
const database = databaseName(process.env.KANVIL_DATABASE ?? "kanvil");
const file = await open(values.output, "wx", 0o600);
try {
  await postgres("dump", database, { output: file.createWriteStream() });
  console.info(
    `Backed up ${database} to ${values.output}. Tickets, accounts, events, and attachment bytes are included.`,
  );
} catch (error) {
  await file.close();
  await unlink(values.output);
  throw error;
}
