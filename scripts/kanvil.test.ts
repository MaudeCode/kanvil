import { spawnSync } from "node:child_process";
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vite-plus/test";

test("the executable dispatches client namespaces and preserves service commands and arguments", async () => {
  const directory = await mkdtemp(join(tmpdir(), "kanvil-dispatch-"));
  try {
    await mkdir(join(directory, "bin"));
    await mkdir(join(directory, "apps/server/dist"), { recursive: true });
    await cp("scripts/kanvil.mjs", join(directory, "bin/kanvil.mjs"));
    await writeFile(join(directory, "package.json"), JSON.stringify({ version: "1.2.3" }));
    for (const name of ["client", "index", "configure", "migrate", "recover"])
      await writeFile(
        join(directory, `apps/server/dist/${name}.mjs`),
        `console.log(JSON.stringify({entry: ${JSON.stringify(name)}, args: process.argv.slice(2)}));`,
      );
    const run = (args: string[]) =>
      spawnSync(process.execPath, [join(directory, "bin/kanvil.mjs"), ...args], {
        cwd: directory,
        encoding: "utf8",
      });
    const result = run(["task", "--help"]);
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ entry: "client", args: ["task", "--help"] });
    for (const namespace of ["project", "workspace", "comment", "claim", "profile"])
      expect(JSON.parse(run([namespace, "list"]).stdout)).toEqual({
        entry: "client",
        args: [namespace, "list"],
      });
    for (const [command, entry] of [
      ["start", "index"],
      ["configure", "configure"],
      ["migrate", "migrate"],
      ["recover", "recover"],
    ])
      expect(JSON.parse(run([command ?? "", "--example"]).stdout)).toEqual({
        entry,
        args: ["--example"],
      });
    expect(JSON.parse(run([]).stdout)).toEqual({ entry: "index", args: [] });
    expect(run(["--version"]).stdout.trim()).toBe("1.2.3");
    expect(run(["--help"]).stdout).toContain("Usage: kanvil");
    expect(run(["unknown"]).status).not.toBe(0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
