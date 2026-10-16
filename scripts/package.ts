import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { z } from "zod";

const metadata = z.object({
  name: z.string(),
  version: z.string().regex(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/),
  description: z.string(),
  license: z.string(),
  engines: z.record(z.string(), z.string()),
});
const root = metadata.parse(JSON.parse(await readFile("package.json", "utf8")));
const server = z
  .object({ dependencies: z.record(z.string(), z.string()) })
  .parse(JSON.parse(await readFile("apps/server/package.json", "utf8")));
// The server build already bundles the workspace contracts.
const dependencies = Object.fromEntries(
  Object.entries(server.dependencies).filter(([name]) => name !== "@kanvil/contracts"),
);
if (Object.values(dependencies).some((version) => version.startsWith("workspace:")))
  throw new Error("The release package contains an unbundled workspace dependency.");
const output = "dist/package";
await rm(output, { recursive: true, force: true });
await mkdir(`${output}/bin`, { recursive: true });
for (const path of ["apps/server/dist", "apps/server/drizzle", "apps/web/dist", "docs"])
  await cp(path, `${output}/${path}`, { recursive: true });
for (const path of ["LICENSE", "README.md", "compose.yml"]) await cp(path, `${output}/${path}`);
await cp(".env.example", `${output}/apps/server/.env.example`);
await cp("scripts/kanvil.mjs", `${output}/bin/kanvil.mjs`);
await writeFile(
  `${output}/package.json`,
  JSON.stringify(
    {
      ...root,
      type: "module",
      bin: { kanvil: "bin/kanvil.mjs" },
      files: ["bin", "apps", "docs", "compose.yml"],
      repository: { type: "git", url: "git+https://github.com/MaudeCode/kanvil.git" },
      homepage: "https://github.com/MaudeCode/kanvil#readme",
      publishConfig: { access: "public" },
      dependencies,
    },
    null,
    2,
  ) + "\n",
);
console.info(`Prepared ${root.name}@${root.version} in ${output}`);
