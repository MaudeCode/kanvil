import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "vite-plus/test";

const exec = promisify(execFile);
const script = resolve("scripts/publish-npm.mjs");
test("npm publishing retries require identical bytes and only E404 permits a publish", async () => {
  const directory = await mkdtemp(join(tmpdir(), "kanvil-publish-"));
  try {
    await mkdir(join(directory, "release"));
    await writeFile(
      join(directory, "package.json"),
      JSON.stringify({ name: "@maudecode/kanvil", version: "0.0.0" }),
    );
    const tarball = Buffer.from("tested release bytes");
    await writeFile(join(directory, "release/package.tgz"), tarball);
    const integrity = `sha512-${createHash("sha512").update(tarball).digest("base64")}`;
    await writeFile(
      join(directory, "npm"),
      `#!/usr/bin/env node
const fs = require("node:fs");
if (process.argv[2] === "view") {
  fs.writeFileSync("lookup", process.argv[3]);
  if (process.env.SCENARIO === "same") console.log(JSON.stringify(process.env.INTEGRITY));
  else if (process.env.SCENARIO === "different") console.log(JSON.stringify("sha512-other"));
  else { console.log(JSON.stringify({ error: { code: process.env.SCENARIO } })); process.exit(1); }
} else fs.appendFileSync("published", process.argv.slice(2).join(" "));
`,
      { mode: 0o755 },
    );
    const options = (scenario: string) => ({
      cwd: directory,
      env: {
        ...process.env,
        PATH: `${directory}:${process.env.PATH}`,
        SCENARIO: scenario,
        INTEGRITY: integrity,
        GITHUB_REF_TYPE: "tag",
        GITHUB_REF_NAME: "v1.2.3",
      },
    });
    await exec(process.execPath, [script], options("same"));
    expect(await readFile(join(directory, "lookup"), "utf8")).toBe("@maudecode/kanvil@1.2.3");
    await expect(readFile(join(directory, "published"))).rejects.toThrow();
    await expect(exec(process.execPath, [script], options("different"))).rejects.toThrow();
    await expect(exec(process.execPath, [script], options("E403"))).rejects.toThrow();
    await expect(readFile(join(directory, "published"))).rejects.toThrow();
    await exec(process.execPath, [script], options("E404"));
    expect(await readFile(join(directory, "published"), "utf8")).toBe(
      "publish release/package.tgz --access public --provenance",
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
