import { randomBytes } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";

const root = new URL("../", import.meta.url);
const example = await readFile(new URL(".env.example", root), "utf8");
const contents = example
  .replace(/^BETTER_AUTH_SECRET=$/m, `BETTER_AUTH_SECRET=${randomBytes(48).toString("base64url")}`)
  .replace(/^KANVIL_SETUP_TOKEN=$/m, `KANVIL_SETUP_TOKEN=${randomBytes(32).toString("base64url")}`);
await writeFile(new URL(".env", root), contents, { mode: 0o600, flag: "wx" });
console.info(
  "Created .env with generated secrets. The initial owner setup token is stored as KANVIL_SETUP_TOKEN.",
);
