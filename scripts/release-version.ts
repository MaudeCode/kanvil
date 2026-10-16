import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const stableVersion = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

export function releaseVersion(fallback: string, env: NodeJS.ProcessEnv = process.env): string {
  const tagged = env.GITHUB_REF_TYPE === "tag";
  const version = tagged ? /^v(.+)$/.exec(env.GITHUB_REF_NAME ?? "")?.[1] : fallback;
  if (!version || !stableVersion.test(version) || (tagged && version === "0.0.0"))
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
