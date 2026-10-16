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
