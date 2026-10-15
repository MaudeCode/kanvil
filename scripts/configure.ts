import { randomBytes } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";

const { values } = parseArgs({ options: { production: { type: "string" } } });
const root = new URL("../", import.meta.url);
let origin: string | undefined;
if (values.production) {
  const url = new URL(values.production);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  )
    throw new Error("Use your public HTTPS origin without a path or credentials.");
  origin = url.origin;
}
const databasePassword = randomBytes(32).toString("hex");
const example = await readFile(new URL(".env.example", root), "utf8");
let contents = example
  .replace(/^POSTGRES_PASSWORD=$/m, `POSTGRES_PASSWORD=${databasePassword}`)
  .replace(/^BETTER_AUTH_SECRET=$/m, `BETTER_AUTH_SECRET=${randomBytes(48).toString("base64url")}`)
  .replace(/^KANVIL_SETUP_TOKEN=$/m, `KANVIL_SETUP_TOKEN=${randomBytes(32).toString("base64url")}`);
if (origin)
  contents = contents
    .replace(
      /^DATABASE_URL=.*$/m,
      `DATABASE_URL=postgres://kanvil:${databasePassword}@db:5432/kanvil`,
    )
    .replace(/^KANVIL_URL=.*$/m, `KANVIL_URL=${origin}`)
    .replace(/^HOST=.*$/m, "HOST=0.0.0.0")
    .replace(/^KANVIL_TRUSTED_ORIGINS=.*$/m, "KANVIL_TRUSTED_ORIGINS=");
await writeFile(new URL(".env", root), contents, { mode: 0o600, flag: "wx" });
console.info(
  "Created private .env configuration. The initial owner setup token is stored as KANVIL_SETUP_TOKEN.",
);
