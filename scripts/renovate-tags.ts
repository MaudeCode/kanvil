// Proves with Renovate's own Docker versioning and update filter, at its default configuration,
// that a consumer of a stable Kanvil image tag is never offered an experimental tag. Renovate is
// large, so it installs into a temporary directory instead of the workspace.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { experimentalAlias, imageTags, repository } from "./release-publish.ts";
import { experimentalVersion } from "./release-version.ts";
import { writeScriptReport } from "./testing/policy.ts";

const renovate = "44.192.2";
const started = new Date();
const directory = mkdtempSync(join(tmpdir(), "kanvil-renovate-"));
// Calls a function a Renovate module exports, or a method of an object it exports.
function call(owner: unknown, method: string, ...args: unknown[]): unknown {
  const fn: unknown = Reflect.get(Object(owner), method);
  if (typeof fn !== "function") throw new Error(`Renovate ${renovate} has no ${method}.`);
  return Reflect.apply(fn, owner, args);
}
const load = async (path: string): Promise<unknown> =>
  import(pathToFileURL(join(directory, "node_modules/renovate/dist", path)).href);
try {
  execFileSync(
    "npm",
    [
      "install",
      "--prefix",
      directory,
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      "--loglevel=error",
      `renovate@${renovate}`,
    ],
    { stdio: ["ignore", "ignore", "inherit"] },
  );
  const docker = await load("modules/versioning/docker/index.js");
  const filter = await load("workers/repository/process/lookup/filter.js");
  const defaults = await load("config/defaults.js");
  const versioning: unknown = Reflect.get(Object(docker), "api");
  const isVersion = (tag: string) => call(versioning, "isVersion", tag) === true;

  const stableTags = [
    "0.4.3",
    "0.4.4",
    "0.4.4-amd64",
    "0.4.4-arm64",
    "0.5.0",
    "0.5.0-amd64",
    "0.5.0-arm64",
  ];
  // Synthetic commits, including ones that start with a digit or look like a number.
  const revisions = ["0".repeat(40), "1234567890".repeat(4), "abcdef0123".repeat(4)];
  const experimentalTags = revisions.flatMap((revision) => {
    const tags = imageTags("experimental", experimentalVersion(revision), revision);
    return [tags.immutable, tags.architecture("amd64"), tags.architecture("arm64")];
  });
  const tags = [...stableTags, "latest", experimentalAlias, ...experimentalTags];
  for (const tag of [experimentalAlias, ...experimentalTags])
    assert.equal(isVersion(tag), false, `Renovate reads ${tag} as a version`);

  // Renovate's lookup keeps compatible versions of the current tag, then filters them for updates.
  const offered = (current: string) => {
    const releases = tags
      .filter((tag) => isVersion(tag) && call(versioning, "isCompatible", tag, current) === true)
      .map((version) => ({ version }));
    const config = { ...Object(call(defaults, "getConfig")), depName: repository };
    const updates = call(
      filter,
      "filterVersions",
      config,
      current,
      undefined,
      releases,
      versioning,
    );
    return (Array.isArray(updates) ? updates : []).map((release) =>
      Reflect.get(Object(release), "version"),
    );
  };
  assert.deepEqual(offered("0.4.3"), ["0.4.4", "0.5.0"]);
  assert.deepEqual(offered("0.4.4-amd64"), ["0.5.0-amd64"]);
  assert.deepEqual(offered("0.5.0"), []);
  console.info(`Renovate ${renovate} offers stable consumers only stable tags.`);
  writeScriptReport("renovate", "scripts/renovate-tags.ts", started);
} finally {
  rmSync(directory, { recursive: true, force: true });
}
