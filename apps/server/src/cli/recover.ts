import passwordPrompt from "@inquirer/password";
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { createDatabase } from "../database.ts";
import { readConfig } from "../config.ts";
import { localPasswordSchema, recoverLocalPassword } from "../recover-account.ts";

const { values } = parseArgs({ options: { email: { type: "string" } } });
if (!values.email)
  throw new Error(
    "Pass --email <account-email>. The new password is read privately from the terminal or stdin.",
  );
const password = process.stdin.isTTY
  ? await passwordPrompt({
      message: "New local password",
      mask: true,
      validate: (value) =>
        localPasswordSchema.safeParse(value).success || "Use 12 to 128 characters",
    })
  : readFileSync(0, "utf8").replace(/\r?\n$/, "");
const config = readConfig(),
  database = createDatabase(config.DATABASE_URL);
try {
  await recoverLocalPassword(database, config, values.email, password);
  console.info(
    "Local password replaced and account sessions revoked. API credentials and linked OIDC accounts are retained.",
  );
} finally {
  await database.pool.end();
}
