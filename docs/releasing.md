# Releases

PRs and `main` pushes run `.github/workflows/ci.yml`. Independent suites and browser/native/Docker matrices run in parallel; only jobs consuming build artifacts wait for the build. The always-running `Checks` status requires every suite to succeed. Releases start on a `vX.Y.Z` tag and reuse that workflow against the tagged commit. Publishing jobs have registry write permissions; PR checks have read-only repository access.

The public npm application package is `@maudecode/kanvil`; the workspace root and internal packages remain private. Both npm and Docker use the root `package.json` version. The release tag must be exactly `v` followed by that version; a mismatch stops the workflow.

## Publish a version

1. Set the root `package.json` version to the intended stable `X.Y.Z`. Update the lockfile with the pinned pnpm if it changes. Commit through a reviewed PR with green `Checks` and merge it to `main`.
2. Fetch `main`, inspect the intended commit, then create and push an annotated tag: `git tag -a vX.Y.Z COMMIT -m "Kanvil X.Y.Z"` and `git push origin vX.Y.Z`. Repository release-tag rules apply. Creating the tag authorizes public publication.
3. Check the `Release` run. It rejects malformed versions, mismatched tags, `0.0.0`, and commits outside `main` history. The full CI workflow must pass on that commit.
4. Verify `npm view @maudecode/kanvil@X.Y.Z dist.integrity` and `docker buildx imagetools inspect ghcr.io/maudecode/kanvil:X.Y.Z`. The image includes Linux amd64 and arm64. Confirm anonymous Docker pulls work.

The workflow publishes the exact npm tarball installed by CI to the `latest` dist-tag, while separate amd64/arm64 publishers push the exact image archives tested by CI. Docker builds and restoration tests run on matching native runners; release publishing does not rebuild or emulate either image. A final Docker manifest job joins those immutable digests under `ghcr.io/maudecode/kanvil:X.Y.Z` and `:latest`. Stable releases only; prerelease versions are rejected. Do not tag an older version to move `latest` backward.

If either registry publication fails, rerun the failed release jobs. npm and Docker publication are independent after validation. The npm step accepts an existing version only when its SHA-512 integrity matches the tested tarball; different bytes fail and require a new version. Registry publication is not atomic across npm and GHCR. Never move a published tag or reuse a version for changed bytes. Avoid rerunning an old release after a newer release, since Docker's `latest` tag would move backward.

Tag creation and package publication are separate from deploying to any running instance. Operators choose when to upgrade using [self-hosting](self-hosting.md).
