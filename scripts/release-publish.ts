// Publishes the Docker images CI tested, for a stable vX.Y.Z release or an experimental build of
// a green main commit. Every published name is immutable except `latest` (stable releases) and
// `experimental` (the newest experimental build on main, advanced only forward).
//
//   node scripts/release-publish.ts identity   decide whether a finished CI run may publish
//   node scripts/release-publish.ts image      push one architecture's tested image
//   node scripts/release-publish.ts manifest   join both architectures under the release tag
//   node scripts/release-publish.ts release    announce an experimental build as a prerelease
//   node scripts/release-publish.ts promote    move `experimental` to the newest published build
import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { commit, experimentalVersion, releaseVersion, stableVersion } from "./release-version.ts";

export const repository = "ghcr.io/maudecode/kanvil";
export const architectures = ["amd64", "arm64"] as const;
export const experimentalAlias = "experimental";
const revisionLabel = "org.opencontainers.image.revision";
const versionLabel = "org.opencontainers.image.version";

export class CommandError extends Error {
  readonly status: number | null;
  readonly stderr: string;
  constructor(command: string, status: number | null, stderr: string) {
    super(`${command} failed (${status}): ${stderr.trim()}`);
    this.status = status;
    this.stderr = stderr;
  }
}
// Runs a command and returns its standard output; a nonzero exit throws CommandError.
export type Run = (command: string, args: string[]) => string;

type Channel = "stable" | "experimental";
// The names one build publishes. Experimental names start with a letter so numeric-tag tooling,
// Renovate's Docker versioning included, never reads them as versions.
export function imageTags(channel: Channel, version: string, revision: string) {
  const immutable = channel === "stable" ? version : `experimental-${revision}`;
  return {
    immutable,
    architecture: (arch: string) => `${immutable}-${arch}`,
    rolling: channel === "stable" ? ["latest"] : [],
  };
}

// Dependency-free JSON reading: publisher jobs install no packages.
const fail = (message: string): never => {
  throw new Error(message);
};
const record = (value: unknown): object =>
  typeof value === "object" && value !== null ? value : fail("Unexpected command output.");
const field = (value: unknown, name: string): unknown => Reflect.get(record(value), name);
const text = (value: unknown) => (typeof value === "string" ? value : fail("Expected text."));
const items = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

interface Published {
  digest: string;
  manifests: string[];
  // Image labels by platform, such as linux/amd64.
  labels: Map<string, Map<string, string>>;
}
const labelsOf = (config: unknown) =>
  new Map(
    Object.entries(record(field(field(config, "config"), "Labels") ?? {})).map(
      ([name, value]) => [name, String(value)] as const,
    ),
  );
// Reads a published tag or digest from the registry; undefined when it does not exist.
export function inspect(run: Run, reference: string): Published | undefined {
  let output: string;
  try {
    output = run("docker", [
      "buildx",
      "imagetools",
      "inspect",
      reference,
      "--format",
      '{"manifest":{{json .Manifest}},"image":{{json .Image}}}',
    ]);
  } catch (error) {
    // Only a missing name permits publication; authentication and network failures stop.
    if (error instanceof CommandError && /\bnot found\b/i.test(error.stderr)) return undefined;
    throw error;
  }
  const parsed: unknown = JSON.parse(output);
  const manifest = field(parsed, "manifest"),
    image = field(parsed, "image");
  const configs: [string, unknown][] =
    field(image, "config") === undefined
      ? Object.entries(record(image))
      : [[`${text(field(image, "os"))}/${text(field(image, "architecture"))}`, image]];
  return {
    digest: text(field(manifest, "digest")),
    manifests: items(field(manifest, "manifests")).map((entry) => text(field(entry, "digest"))),
    // An arm64 variant such as linux/arm64/v8 is still linux/arm64.
    labels: new Map(
      configs.map(([key, config]) => [key.split("/").slice(0, 2).join("/"), labelsOf(config)]),
    ),
  };
}
function assertIdentity(
  published: Published,
  reference: string,
  platforms: readonly string[],
  revision: string,
  version: string,
) {
  for (const platform of platforms) {
    const labels = published.labels.get(platform);
    if (labels?.get(revisionLabel) !== revision || labels.get(versionLabel) !== version)
      fail(
        `${reference} already exists for ${platform} with a different source or version. Published names are never replaced; publish a new version.`,
      );
  }
}

interface Build {
  channel: Channel;
  version: string;
  revision: string;
}
function build(env: NodeJS.ProcessEnv): Build {
  const channel = env.KANVIL_RELEASE_CHANNEL;
  const version = env.KANVIL_VERSION ?? "",
    revision = env.KANVIL_REVISION ?? "";
  if (channel !== "stable" && channel !== "experimental")
    fail("KANVIL_RELEASE_CHANNEL must be stable or experimental.");
  if (!commit.test(revision)) fail("KANVIL_REVISION must be a full commit SHA.");
  const expected =
    channel === "experimental"
      ? version === experimentalVersion(revision)
      : stableVersion.test(version);
  if (!expected) fail(`${version} is not a valid ${String(channel)} version for ${revision}.`);
  return { channel: channel === "stable" ? "stable" : "experimental", version, revision };
}
const platform = (arch: string) => `linux/${arch}`;
const digestReference = new RegExp(`^${repository.replaceAll(".", "\\.")}@sha256:[0-9a-f]{64}$`);

// Pushes the tested archive under the build's architecture tag. A rerun keeps an existing tag
// from the same source and refuses one from any other.
function publishImage(env: NodeJS.ProcessEnv, run: Run) {
  const { channel, version, revision } = build(env);
  const arch = env.ARCH ?? "";
  if (!architectures.some((candidate) => candidate === arch)) fail("ARCH must be amd64 or arm64.");
  const archive = env.ARCHIVE ?? "release/image.tar.gz",
    output = env.DIGEST_FILE ?? join("digests", arch);
  run("docker", ["load", "--input", archive]);
  const local: unknown = JSON.parse(
    run("docker", ["image", "inspect", "kanvil:local", "--format", "{{json .}}"]),
  );
  const labels = labelsOf({ config: field(local, "Config") });
  if (field(local, "Architecture") !== arch) fail(`The tested image is not ${arch}.`);
  if (labels.get(revisionLabel) !== revision)
    fail(`The tested image was not built from ${revision}.`);
  if (labels.get(versionLabel) !== version) fail(`The tested image is not version ${version}.`);
  const reference = `${repository}:${imageTags(channel, version, revision).architecture(arch)}`;
  const existing = inspect(run, reference);
  let digest: string;
  if (existing) {
    assertIdentity(existing, reference, [platform(arch)], revision, version);
    digest = `${repository}@${existing.digest}`;
    console.info(`${reference} is already published from ${revision}.`);
  } else {
    run("docker", ["tag", "kanvil:local", reference]);
    run("docker", ["push", reference]);
    const pushed: unknown = JSON.parse(
      run("docker", ["image", "inspect", reference, "--format", "{{json .RepoDigests}}"]),
    );
    digest = text(
      items(pushed).find((entry) => typeof entry === "string" && digestReference.test(entry)) ??
        fail(`${reference} has no registry digest after its push.`),
    );
  }
  if (!digestReference.test(digest)) fail(`Unexpected digest ${digest}.`);
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, `${digest}\n`);
}

// Joins both architecture digests under the build's immutable tag, plus `latest` for a stable
// release. Every architecture must be published first.
function publishManifest(env: NodeJS.ProcessEnv, run: Run) {
  const { channel, version, revision } = build(env);
  const directory = env.DIGESTS ?? "digests";
  const sources = architectures.map((arch) => {
    const file = join(directory, arch);
    if (!existsSync(file)) fail(`The ${arch} image is not published; rerun its publisher.`);
    const digest = readFileSync(file, "utf8").trim();
    if (!digestReference.test(digest)) fail(`Unexpected ${arch} digest ${digest}.`);
    return digest;
  });
  const tags = imageTags(channel, version, revision);
  const reference = `${repository}:${tags.immutable}`;
  const platforms = architectures.map(platform);
  const verify = (published: Published) => {
    assertIdentity(published, reference, platforms, revision, version);
    for (const source of sources)
      if (!published.manifests.includes(source.slice(repository.length + 1)))
        fail(`${reference} already exists with other images. Published names are never replaced.`);
  };
  const existing = inspect(run, reference);
  if (existing) verify(existing);
  if (!existing || tags.rolling.length) {
    const names = [tags.immutable, ...tags.rolling].flatMap((tag) => [
      "--tag",
      `${repository}:${tag}`,
    ]);
    run("docker", ["buildx", "imagetools", "create", ...names, ...sources]);
  }
  const published = inspect(run, reference) ?? fail(`${reference} was not published.`);
  verify(published);
  console.info(`${reference} is ${repository}@${published.digest}.`);
}

const experimentalBuild = (env: NodeJS.ProcessEnv) =>
  build({ ...env, KANVIL_RELEASE_CHANNEL: "experimental" });
function githubRepository(env: NodeJS.ProcessEnv) {
  const name = env.GITHUB_REPOSITORY ?? "";
  return /^[\w.-]+\/[\w.-]+$/.test(name) ? name : fail("GITHUB_REPOSITORY is required.");
}
function tagTarget(run: Run, github: string, tag: string) {
  try {
    return run("gh", ["api", `repos/${github}/git/ref/tags/${tag}`, "--jq", ".object.sha"]).trim();
  } catch (error) {
    if (error instanceof CommandError && /\b404\b/.test(error.stderr)) return undefined;
    throw error;
  }
}
function releaseOf(run: Run, tag: string) {
  try {
    const release: unknown = JSON.parse(
      run("gh", ["release", "view", tag, "--json", "tagName,isPrerelease,isDraft"]),
    );
    return {
      prerelease: field(release, "isPrerelease") === true,
      draft: field(release, "isDraft"),
    };
  } catch (error) {
    if (error instanceof CommandError && /release not found/i.test(error.stderr)) return undefined;
    throw error;
  }
}

// Creates the experimental-<SHA> tag and GitHub prerelease once both architectures are
// published. It never becomes the latest release; a rerun keeps the existing one.
function publishRelease(env: NodeJS.ProcessEnv, run: Run) {
  const { version, revision } = experimentalBuild(env);
  const github = githubRepository(env);
  const tag = imageTags("experimental", version, revision).immutable;
  const reference = `${repository}:${tag}`;
  const published =
    inspect(run, reference) ?? fail(`${reference} is not published; publish its images first.`);
  assertIdentity(published, reference, architectures.map(platform), revision, version);
  const target = tagTarget(run, github, tag);
  if (target !== undefined && target !== revision)
    fail(`Tag ${tag} points to ${target}, not ${revision}.`);
  const existing = releaseOf(run, tag);
  if (existing) {
    if (!existing.prerelease || existing.draft !== false)
      fail(`Release ${tag} exists but is not a published prerelease.`);
    console.info(`Release ${tag} already exists.`);
    return;
  }
  const notes = [
    `Experimental build of ${revision} from \`main\`, published after its CI checks passed. It is not a stable release.`,
    "",
    `- Version: \`${version}\``,
    `- Source: https://github.com/${github}/commit/${revision}`,
    `- Image: \`${reference}\``,
    `- Digest: \`${repository}@${published.digest}\``,
    `- Rolling alias: \`${repository}:${experimentalAlias}\``,
  ].join("\n");
  run("gh", [
    "release",
    "create",
    tag,
    "--target",
    revision,
    "--title",
    tag,
    "--prerelease",
    "--latest=false",
    "--generate-notes",
    "--notes",
    notes,
  ]);
  if (!releaseOf(run, tag)?.prerelease || tagTarget(run, github, tag) !== revision)
    fail(`Release ${tag} did not publish as a prerelease of ${revision}.`);
}

const historyLimit = 200;
// Moves `experimental` to the newest published experimental build on main's first-parent
// history. It never moves to an older commit, so reruns and late finishers cannot roll it back.
// ponytail: reads the newest 100 releases and 200 commits; widen both if main outpaces them.
function promote(env: NodeJS.ProcessEnv, run: Run) {
  githubRepository(env);
  const history = run("git", [
    "rev-list",
    "--first-parent",
    `--max-count=${historyLimit}`,
    "origin/main",
  ])
    .split("\n")
    .filter((line) => commit.test(line));
  const releases: unknown = JSON.parse(
    run("gh", [
      "release",
      "list",
      "--limit",
      "100",
      "--exclude-drafts",
      "--json",
      "tagName,isPrerelease",
    ]),
  );
  const announced = new Set(
    items(releases).flatMap((release) => {
      const match = /^experimental-([0-9a-f]{40})$/.exec(String(field(release, "tagName")));
      return match?.[1] && field(release, "isPrerelease") === true ? [match[1]] : [];
    }),
  );
  const newest = history.find((revision) => announced.has(revision));
  if (!newest) return console.info("No experimental build on main is published yet.");
  const alias = `${repository}:${experimentalAlias}`;
  const current = inspect(run, alias);
  const currentRevision = current?.labels.get(platform("amd64"))?.get(revisionLabel);
  const position = currentRevision ? history.indexOf(currentRevision) : -1;
  if (position !== -1 && position <= history.indexOf(newest))
    return console.info(`${alias} already points to ${currentRevision ?? ""}.`);
  const version = experimentalVersion(newest);
  const reference = `${repository}:${imageTags("experimental", version, newest).immutable}`;
  const source = inspect(run, reference) ?? fail(`${reference} is announced but not published.`);
  assertIdentity(source, reference, architectures.map(platform), newest, version);
  run("docker", [
    "buildx",
    "imagetools",
    "create",
    "--tag",
    alias,
    `${repository}@${source.digest}`,
  ]);
  if (inspect(run, alias)?.digest !== source.digest) fail(`${alias} did not move to ${reference}.`);
  console.info(`${alias} now points to ${newest}.`);
}

// Decides whether the finished CI run in a workflow_run event may publish an experimental
// build: a successful push run of this repository's main branch whose commit is still on main.
export function identity(env: NodeJS.ProcessEnv, run: Run) {
  const event: unknown = JSON.parse(
    readFileSync(env.GITHUB_EVENT_PATH ?? fail("No event."), "utf8"),
  );
  const ci = field(event, "workflow_run");
  const revision = text(field(ci, "head_sha"));
  const skip =
    field(ci, "conclusion") !== "success"
      ? "CI did not succeed"
      : field(ci, "event") !== "push"
        ? "CI did not run for a push"
        : field(ci, "head_branch") !== "main"
          ? "CI did not run for main"
          : field(field(ci, "head_repository"), "full_name") !== githubRepository(env)
            ? "CI ran for another repository"
            : undefined;
  let reason = skip;
  if (!reason) {
    try {
      run("git", ["merge-base", "--is-ancestor", revision, "origin/main"]);
    } catch (error) {
      if (!(error instanceof CommandError) || error.status !== 1) throw error;
      reason = `${revision} is no longer on main`;
    }
  }
  const outputs: Record<string, string> = reason
    ? { publish: "false" }
    : {
        publish: "true",
        revision,
        version: releaseVersion("0.0.0", {
          KANVIL_RELEASE_CHANNEL: "experimental",
          GITHUB_SHA: revision,
        }),
        "run-id": String(field(ci, "id")),
      };
  console.info(reason ? `Not publishing: ${reason}.` : `Publishing ${outputs.version}.`);
  if (env.GITHUB_OUTPUT)
    appendFileSync(
      env.GITHUB_OUTPUT,
      Object.entries(outputs)
        .map(([name, value]) => `${name}=${value}\n`)
        .join(""),
    );
  return outputs;
}

export function publish(command: string, env: NodeJS.ProcessEnv, run: Run) {
  if (command === "identity") identity(env, run);
  else if (command === "image") publishImage(env, run);
  else if (command === "manifest") publishManifest(env, run);
  else if (command === "release") publishRelease(env, run);
  else if (command === "promote") promote(env, run);
  else fail(`Unknown command ${command}.`);
}

const execute: Run = (command, args) => {
  console.info(`$ ${command} ${args.join(" ")}`);
  const result = spawnSync(command, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new CommandError(command, result.status, result.stderr);
  return result.stdout;
};

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url)
  publish(process.argv[2] ?? "", process.env, execute);
