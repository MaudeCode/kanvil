# Releases

PRs and `main` pushes run `.github/workflows/ci.yml`. Independent suites and browser/native/Docker matrices run in parallel; only jobs consuming build artifacts wait for the build. The always-running `Checks` status requires every suite to succeed. Releases start on a `vX.Y.Z` tag and reuse that workflow against the tagged commit. Publishing jobs have registry write permissions; PR checks have read-only repository access.

## One-time registry setup

The public npm application package is `@maudecode/kanvil`; the workspace root and internal packages remain private. The release packager creates a separate manifest with the server's runtime dependencies, the CLI, migrations, and built web assets. It excludes development dependencies and workspace references.

An npm organization owner must bootstrap the package before OIDC publishing can work. Build and test the intended first release with `pnpm test:package`, then publish the resulting `dist/maudecode-kanvil-VERSION.tgz` interactively with `npm publish <tarball> --access public` using the owner's npm login and required 2FA. This is an actual public release: do it only when that version is ready to ship. Do not add an npm token to GitHub.

In the package's npm settings, add a GitHub Actions trusted publisher:

- Organization: `MaudeCode`
- Repository: `kanvil`
- Workflow filename: `release.yml`
- Environment: leave empty
- Allow direct `npm publish`

The workflow uses `id-token: write` on a GitHub-hosted runner and the Node pin's bundled npm (which must remain at least 11.5.1). npm supplies provenance through OIDC. See [npm trusted publishing](https://docs.npmjs.com/trusted-publishers/).

For GHCR, allow this repository's `GITHUB_TOKEN` to write packages. After the first successful publication, open the `kanvil` package settings in the `MaudeCode` organization and change visibility to public so anonymous Docker pulls work. The image carries the repository source label. See [GitHub's container registry instructions](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-container-registry).

## Publish a version

1. Change the root `package.json` version from `0.0.0` to the intended stable `X.Y.Z`. Update the lockfile with the pinned pnpm if it changes. Commit through a reviewed PR with green `Checks` and merge it to `main`.
2. Fetch `main`, inspect the intended commit, then create and push an annotated tag: `git tag -a vX.Y.Z COMMIT -m "Kanvil X.Y.Z"` and `git push origin vX.Y.Z`. Repository release-tag rules apply. Creating the tag authorizes public publication.
3. Check the `Release` run. It rejects malformed versions, mismatched tags, `0.0.0`, and commits outside `main` history. The full CI workflow must pass on that commit.
4. Verify `npm view @maudecode/kanvil@X.Y.Z dist.integrity` and `docker buildx imagetools inspect ghcr.io/maudecode/kanvil:X.Y.Z`. The image includes Linux amd64 and arm64. Confirm anonymous pulls after making the first package public.

The workflow publishes the exact npm tarball installed by CI to the `latest` dist-tag, while separate amd64/arm64 publishers push the exact image archives tested by CI. Docker builds and restoration tests run on matching native runners; release publishing does not rebuild or emulate either image. A final Docker manifest job joins those immutable digests under `ghcr.io/maudecode/kanvil:X.Y.Z` and `:latest`. Stable releases only; prerelease versions are rejected. Do not tag an older version to move `latest` backward.

If either registry publication fails, rerun the failed release jobs. npm and Docker publication are independent after validation. The npm step accepts an existing version only when its SHA-512 integrity matches the tested tarball; different bytes fail and require a new version. Registry publication is not atomic across npm and GHCR. Never move a published tag or reuse a version for changed bytes. Avoid rerunning an old release after a newer release, since Docker's `latest` tag would move backward.

Tag creation and package publication are separate from deploying to any running instance. Operators choose when to upgrade using [self-hosting](self-hosting.md).
