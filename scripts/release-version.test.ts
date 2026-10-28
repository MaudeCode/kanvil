import { expect, test } from "vite-plus/test";
import { releaseVersion } from "./release-version.ts";

test("release tags override the unchanged development package version", () => {
  expect(releaseVersion("0.0.0", { GITHUB_REF_TYPE: "tag", GITHUB_REF_NAME: "v1.2.3" })).toBe(
    "1.2.3",
  );
  expect(releaseVersion("0.0.0", { GITHUB_REF_TYPE: "branch", GITHUB_REF_NAME: "main" })).toBe(
    "0.0.0",
  );
  expect(releaseVersion("0.0.0", {})).toBe("0.0.0");
});

test.each([
  "v0.0.0",
  "1.2.3",
  "v01.2.3",
  "v1.02.3",
  "v1.2.03",
  "v1.2",
  "v1.2.3-beta.1",
  "v1.2.3+build",
  "",
])("rejects invalid release tag %s", (tag) => {
  expect(() => releaseVersion("0.0.0", { GITHUB_REF_TYPE: "tag", GITHUB_REF_NAME: tag })).toThrow(
    "Release tags must use vX.Y.Z",
  );
});

const sha = "0123456789abcdef0123456789abcdef01234567";
test("main experimental builds stamp the full source commit", () => {
  const env = { KANVIL_RELEASE_CHANNEL: "experimental", GITHUB_SHA: sha };
  expect(releaseVersion("0.0.0", env)).toBe(`0.0.0-experimental.g${sha}`);
  expect(releaseVersion("0.0.0", { ...env, GITHUB_REF_TYPE: "branch" })).toBe(
    `0.0.0-experimental.g${sha}`,
  );
  // The Docker build receives the resolved identity as its fallback, without CI variables.
  expect(releaseVersion(`0.0.0-experimental.g${sha}`, {})).toBe(`0.0.0-experimental.g${sha}`);
});

test.each([
  { GITHUB_SHA: sha.slice(0, 12) },
  { GITHUB_SHA: sha.toUpperCase() },
  {},
  { GITHUB_SHA: sha, GITHUB_REF_TYPE: "tag", GITHUB_REF_NAME: "v1.2.3" },
])("rejects an experimental build without one full commit outside a tag: %o", (env) => {
  expect(() => releaseVersion("0.0.0", { KANVIL_RELEASE_CHANNEL: "experimental", ...env })).toThrow(
    "Experimental builds",
  );
});

test.each(["0.0.0-experimental.g0123", "1.2.3-experimental.g" + sha, "0.0.0-beta.1"])(
  "rejects the malformed development version %s",
  (version) => {
    expect(() => releaseVersion(version, {})).toThrow("Release tags must use vX.Y.Z");
  },
);

test("an unknown channel cannot fall back to the stable identity", () => {
  expect(() => releaseVersion("0.0.0", { KANVIL_RELEASE_CHANNEL: "nightly" })).toThrow(
    "Unknown release channel",
  );
});
