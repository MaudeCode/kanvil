import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const stableVersion = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
export const commit = /^[0-9a-f]{40}$/;
// Experimental builds keep the development base version and name their commit, so they never
// sort above a stable release. Their Docker tags are not versions at all; see release-publish.ts.
export const experimentalVersion = (revision: string) => `0.0.0-experimental.g${revision}`;
const experimental = /^0\.0\.0-experimental\.g[0-9a-f]{40}$/;

export const isReleaseVersion = (version: string) =>
  stableVersion.test(version) || experimental.test(version);

// The one place a build learns its identity: a vX.Y.Z tag, an explicit experimental build of a
// full commit, or the development version (which a Docker build receives already resolved).
export function releaseVersion(fallback: string, env: NodeJS.ProcessEnv = process.env): string {
  const tagged = env.GITHUB_REF_TYPE === "tag";
  const channel = env.KANVIL_RELEASE_CHANNEL ?? "";
  if (channel === "experimental") {
    if (tagged || !commit.test(env.GITHUB_SHA ?? ""))
      throw new Error("Experimental builds need the full source commit and cannot run for a tag.");
    return experimentalVersion(env.GITHUB_SHA ?? "");
  }
  if (channel !== "") throw new Error(`Unknown release channel ${channel}.`);
  const version = tagged ? /^v(.+)$/.exec(env.GITHUB_REF_NAME ?? "")?.[1] : fallback;
  if (
    !version ||
    !(tagged ? stableVersion.test(version) : isReleaseVersion(version)) ||
    (tagged && version === "0.0.0")
  )
    throw new Error("Release tags must use vX.Y.Z with a nonzero stable version.");
  return version;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const manifest: unknown = JSON.parse(readFileSync("package.json", "utf8"));
  if (
    !manifest ||
    typeof manifest !== "object" ||
    !("version" in manifest) ||
    typeof manifest.version !== "string"
  )
    throw new Error("package.json must contain a version string.");
  console.info(releaseVersion(manifest.version));
}
