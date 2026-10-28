# Releases

PRs and `main` pushes run `.github/workflows/ci.yml`. `main` pushes also publish an [experimental build](#experimental-builds). Independent suites and browser/native/Docker matrices run in parallel; only jobs consuming build artifacts wait for the build. The always-running `Checks` status requires every suite to succeed. Releases start on a `vX.Y.Z` tag and reuse that workflow against the tagged commit. Publishing jobs have registry write permissions; PR checks have read-only repository access.

The public npm application package is `@maudecode/kanvil`; the workspace root and internal packages remain private. The release tag supplies the version for both npm and Docker: `v1.2.3` publishes `@maudecode/kanvil@1.2.3` and `ghcr.io/maudecode/kanvil:1.2.3`. The server build embeds that same version for Administration, public instance info, OpenAPI, and MCP. Installed artifacts need no Git checkout or release environment variables. No `package.json` version bump is needed. PR and local builds use the development version in `package.json`; custom Docker builds pass `--build-arg KANVIL_VERSION=X.Y.Z` to stamp the server and image label together. Native mobile app/store versions remain separate.

## Publish a version

1. Merge the intended changes to `main` through a reviewed PR with green `Checks`.
2. Fetch `main`, inspect the intended commit, then create and push an annotated tag: `git tag -a vX.Y.Z COMMIT -m "Kanvil X.Y.Z"` and `git push origin vX.Y.Z`. Repository release-tag rules apply. Creating the tag authorizes public publication.
3. Check the `Release` run. It rejects malformed or prerelease tags, `v0.0.0`, and commits outside `main` history. The full CI workflow must pass on that commit.
4. Verify `npm view @maudecode/kanvil@X.Y.Z dist.integrity` and `docker buildx imagetools inspect ghcr.io/maudecode/kanvil:X.Y.Z`. The image includes Linux amd64 and arm64. Confirm anonymous Docker pulls work, and check the GitHub Release for the tag and its automatically generated notes.

The workflow publishes the exact npm tarball installed by CI to the `latest` dist-tag, while separate amd64/arm64 publishers push the exact image archives tested by CI. Docker builds and restoration tests run on matching native runners; release publishing does not rebuild or emulate either image. A final Docker manifest job joins those immutable digests under `ghcr.io/maudecode/kanvil:X.Y.Z` and `:latest`. Stable and experimental builds share this publisher, `.github/workflows/publish-images.yml`. Stable releases only; prerelease versions are rejected. Do not tag an older version to move `latest` backward.

If either registry publication fails, rerun the failed release jobs. npm and Docker publication are independent after validation. The npm step accepts an existing version only when its SHA-512 integrity matches the tested tarball; different bytes fail and require a new version. Registry publication is not atomic across npm and GHCR. Never move a published tag or reuse a version for changed bytes. Avoid rerunning an old release after a newer release, since Docker's `latest` tag would move backward.

After npm publication and the Docker manifest job both succeed, the workflow creates a GitHub Release for the existing tag with an automatically generated title and release notes. Only this final job has repository contents write permission. Reruns preserve an existing release and its notes.

## Experimental builds

Every push to `main` also publishes an experimental build once CI passes on that exact commit. `.github/workflows/experimental.yml` runs when a CI run finishes. It publishes only a successful `push` run of this repository's `main` whose commit is still on `main`; pull requests, forks, other branches, release tags, and failed or cancelled runs publish nothing. Each `main` commit runs CI in its own concurrency group, so a newer push never cancels or replaces an older commit's verification or publication.

An experimental build of commit `SHA` (the full 40-character commit) has the version `0.0.0-experimental.gSHA` in Administration, public instance info, OpenAPI, MCP, and the image's `org.opencontainers.image.version` label; `org.opencontainers.image.revision` is `SHA`. CI builds and tests it with that identity (`KANVIL_RELEASE_CHANNEL=experimental` in `scripts/release-version.ts`), and publishing reuses the exact native images CI tested:

- `ghcr.io/maudecode/kanvil:experimental-SHA-amd64` and `-arm64`, then the multi-platform `ghcr.io/maudecode/kanvil:experimental-SHA`. These names are immutable.
- A Git tag and GitHub prerelease named `experimental-SHA`, pinned to `SHA`, created only after both architectures and the multi-platform manifest are published. It is never marked latest; its notes give the source commit, image, and manifest digest after the generated change list.
- `ghcr.io/maudecode/kanvil:experimental`, the opt-in rolling alias. It moves to the newest announced experimental build on `main`'s first-parent history and never to an older commit, so builds that finish out of order and reruns of old runs cannot move it backward. Only this step is serialized.

Experimental tags start with a letter, so tools that read numeric Docker tags as versions, such as Renovate, never treat them as upgrades from a stable release; CI's `Renovate tag selection` job checks this with Renovate itself. Experimental builds never publish npm packages or move npm dist-tags, `latest`, version tags, or the latest GitHub release.

Reruns are safe. `scripts/release-publish.ts` keeps an existing image, manifest, tag, or release that names the same commit and version, and fails on one that names anything else rather than replacing it. If one architecture fails to publish, rerun the failed jobs of the `Experimental` run; they reuse the images CI tested and the architecture already published. If only the alias move fails, rerun it, or let the next `main` commit's run move the alias; it always selects the newest published build.

Tag creation and package publication are separate from deploying to any running instance. Operators choose when to upgrade using [self-hosting](self-hosting.md).
