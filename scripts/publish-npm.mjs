import { releaseVersion } from "./release-version.ts";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";

const metadata = JSON.parse(readFileSync("package.json", "utf8"));
metadata.version = releaseVersion(metadata.version);
const tarballs = readdirSync("release").filter((file) => file.endsWith(".tgz"));
assert.equal(tarballs.length, 1, "Expected one tested release tarball");
const tarball = `./release/${tarballs[0]}`;
const integrity = `sha512-${createHash("sha512").update(readFileSync(tarball)).digest("base64")}`;
let published;
try {
  published = JSON.parse(
    execFileSync(
      "npm",
      ["view", `${metadata.name}@${metadata.version}`, "dist.integrity", "--json"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    ),
  );
} catch (error) {
  // Only a missing version permits publication; auth and network failures must stop.
  if (!error.stdout || JSON.parse(error.stdout).error?.code !== "E404") throw error;
}
if (published !== undefined) {
  assert.equal(published, integrity, "Published version has different bytes; bump the version");
  console.info("The identical npm tarball is already published.");
} else {
  execFileSync("npm", ["publish", tarball, "--access", "public", "--provenance"], {
    stdio: "inherit",
  });
}
