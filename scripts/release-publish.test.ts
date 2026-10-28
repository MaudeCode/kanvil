import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, test } from "vite-plus/test";
import {
  CommandError,
  identity,
  imageTags,
  publish,
  repository,
  type Run,
} from "./release-publish.ts";
import { experimentalVersion } from "./release-version.ts";

// Synthetic commits on main, oldest first.
const first = "1".repeat(40),
  second = "2".repeat(40),
  third = "3".repeat(40);
const stable = "4".repeat(40);
const hash = (value: unknown) =>
  `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;

interface Image {
  platform: string;
  labels: Record<string, string>;
}
type Blob = { kind: "image"; image: Image } | { kind: "index"; manifests: string[] };

// A stand-in for docker, gh, and git: a registry of tags and blobs, a main history, and
// GitHub's tags and releases. Records every command so tests can assert what ran.
class World {
  archives = new Map<string, Image>();
  local: Image | undefined;
  tags = new Map<string, string>();
  blobs = new Map<string, Blob>();
  history: string[] = [];
  refs = new Map<string, string>();
  releases = new Map<string, { prerelease: boolean; draft: boolean; notes: string }>();
  calls: string[][] = [];
  failing = new Set<string>();

  archive(path: string, arch: string, revision: string, version: string) {
    this.archives.set(path, {
      platform: `linux/${arch}`,
      labels: {
        "org.opencontainers.image.revision": revision,
        "org.opencontainers.image.version": version,
        "org.opencontainers.image.source": "https://github.com/MaudeCode/kanvil",
      },
    });
  }
  resolve(reference: string) {
    const digest = reference.startsWith(`${repository}@`)
      ? reference.slice(repository.length + 1)
      : this.tags.get(reference);
    return digest === undefined ? undefined : { digest, blob: this.blobs.get(digest) };
  }
  config(image: Image) {
    const [os, architecture] = image.platform.split("/");
    return { os, architecture, config: { Labels: image.labels } };
  }
  run: Run = (command, args) => {
    this.calls.push([command, ...args]);
    const line = [command, ...args].join(" ");
    if ([...this.failing].some((pattern) => line.includes(pattern)))
      throw new CommandError(command, 1, "unexpected registry error");
    const [a, b, c, d] = args;
    if (command === "docker" && a === "load") {
      this.local = this.archives.get(args[2] ?? "");
      return "";
    }
    if (command === "docker" && a === "image" && b === "inspect") {
      if (c === "kanvil:local" && this.local)
        return JSON.stringify({
          Architecture: this.local.platform.split("/")[1],
          Config: { Labels: this.local.labels },
        });
      return JSON.stringify([`${repository}@${this.tags.get(c ?? "") ?? ""}`]);
    }
    if (command === "docker" && a === "tag") return "";
    if (command === "docker" && a === "push" && this.local && b) {
      const digest = hash(this.local);
      this.blobs.set(digest, { kind: "image", image: this.local });
      this.tags.set(b, digest);
      return "";
    }
    if (command === "docker" && a === "buildx" && b === "imagetools" && c === "inspect") {
      const found = this.resolve(d ?? "");
      if (!found?.blob) throw new CommandError(command, 1, `ERROR: ${d ?? ""}: not found`);
      const { blob, digest } = found;
      if (blob.kind === "image")
        return JSON.stringify({ manifest: { digest }, image: this.config(blob.image) });
      return JSON.stringify({
        manifest: { digest, manifests: blob.manifests.map((entry) => ({ digest: entry })) },
        image: Object.fromEntries(
          blob.manifests.flatMap((entry) => {
            const part = this.blobs.get(entry);
            return part?.kind === "image" ? [[part.image.platform, this.config(part.image)]] : [];
          }),
        ),
      });
    }
    if (command === "docker" && a === "buildx" && b === "imagetools" && c === "create") {
      const names = args.filter((_, index) => args[index - 1] === "--tag");
      const sources = args.slice(3).filter((arg) => arg !== "--tag" && !names.includes(arg));
      const resolved = sources.map((source) => this.resolve(source));
      // One index source is copied unchanged, as buildx does.
      const only = resolved.length === 1 ? resolved[0] : undefined;
      const digest =
        only?.blob?.kind === "index"
          ? only.digest
          : hash(resolved.map((entry) => entry?.digest ?? fail("missing source")));
      if (only?.blob?.kind !== "index")
        this.blobs.set(digest, {
          kind: "index",
          manifests: resolved.map((entry) => entry?.digest ?? ""),
        });
      for (const name of names) this.tags.set(name, digest);
      return "";
    }
    if (command === "git" && a === "rev-list") return this.history.toReversed().join("\n");
    if (command === "git" && a === "merge-base") {
      if (!this.history.includes(c ?? "")) throw new CommandError(command, 1, "");
      return "";
    }
    if (command === "gh" && a === "api") {
      const target = this.refs.get(b?.split("/tags/")[1] ?? "");
      if (!target) throw new CommandError(command, 1, "gh: Not Found (HTTP 404)");
      return `${target}\n`;
    }
    if (command === "gh" && a === "release" && b === "view") {
      const found = this.releases.get(c ?? "");
      if (!found) throw new CommandError(command, 1, "release not found");
      return JSON.stringify({ tagName: c, isPrerelease: found.prerelease, isDraft: found.draft });
    }
    if (command === "gh" && a === "release" && b === "create" && c) {
      const option = (name: string) => args[args.indexOf(name) + 1] ?? "";
      if (!this.refs.has(c)) this.refs.set(c, option("--target"));
      this.releases.set(c, {
        prerelease: args.includes("--prerelease"),
        draft: false,
        notes: option("--notes"),
      });
      return "";
    }
    if (command === "gh" && a === "release" && b === "list")
      return JSON.stringify(
        [...this.releases].map(([tagName, entry]) => ({
          tagName,
          isPrerelease: entry.prerelease,
        })),
      );
    throw new Error(`Unexpected command: ${line}`);
  };
  commands(name: string) {
    return this.calls.filter((call) => call.slice(0, 4).join(" ").includes(name));
  }
}
const fail = (message: string): never => {
  throw new Error(message);
};

let directory: string, world: World;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "kanvil-release-"));
  world = new World();
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

const environment = (channel: string, version: string, revision: string, arch = "amd64") => ({
  KANVIL_RELEASE_CHANNEL: channel,
  KANVIL_VERSION: version,
  KANVIL_REVISION: revision,
  ARCH: arch,
  ARCHIVE: join(directory, `${revision}-${arch}.tar.gz`),
  DIGEST_FILE: join(directory, revision, arch),
  DIGESTS: join(directory, revision),
  GITHUB_REPOSITORY: "MaudeCode/kanvil",
});
// Runs the publication jobs for one build in order, stopping where a job fails.
function release(
  channel: "stable" | "experimental",
  revision: string,
  version = channel === "stable" ? "1.2.3" : experimentalVersion(revision),
) {
  for (const arch of ["amd64", "arm64"]) {
    world.archive(join(directory, `${revision}-${arch}.tar.gz`), arch, revision, version);
    publish("image", environment(channel, version, revision, arch), world.run);
  }
  publish("manifest", environment(channel, version, revision), world.run);
  if (channel === "experimental")
    publish("release", environment(channel, version, revision), world.run);
}
const promote = () => publish("promote", { GITHUB_REPOSITORY: "MaudeCode/kanvil" }, world.run);
const pointsTo = (tag: string) => world.tags.get(`${repository}:${tag}`);
const revisionOf = (tag: string) => {
  const blob = world.blobs.get(pointsTo(tag) ?? "");
  const part = blob?.kind === "index" ? world.blobs.get(blob.manifests[0] ?? "") : blob;
  return part?.kind === "image" ? part.image.labels["org.opencontainers.image.revision"] : "";
};

test("stable and experimental builds publish separate, nonnumeric names", () => {
  expect(imageTags("stable", "1.2.3", stable)).toMatchObject({
    immutable: "1.2.3",
    rolling: ["latest"],
  });
  const experimental = imageTags("experimental", experimentalVersion(first), first);
  expect(experimental).toMatchObject({ immutable: `experimental-${first}`, rolling: [] });
  expect(experimental.architecture("arm64")).toBe(`experimental-${first}-arm64`);
});

describe("publication", () => {
  it("publishes a stable release under its version and latest", () => {
    release("stable", stable);
    expect([...world.tags.keys()].toSorted()).toEqual(
      ["1.2.3", "1.2.3-amd64", "1.2.3-arm64", "latest"].map((tag) => `${repository}:${tag}`),
    );
    expect(pointsTo("latest")).toBe(pointsTo("1.2.3"));
    expect(world.releases.size).toBe(0);
  });

  it("publishes an experimental build without touching latest or any version tag", () => {
    release("stable", stable);
    const latest = pointsTo("latest");
    world.history = [first];
    release("experimental", first);
    expect(pointsTo("latest")).toBe(latest);
    expect([...world.tags.keys()].filter((name) => /:\d/.test(name)).toSorted()).toEqual(
      ["1.2.3", "1.2.3-amd64", "1.2.3-arm64"].map((tag) => `${repository}:${tag}`),
    );
    const index = world.blobs.get(pointsTo(`experimental-${first}`) ?? "");
    expect(index).toEqual({
      kind: "index",
      manifests: [pointsTo(`experimental-${first}-amd64`), pointsTo(`experimental-${first}-arm64`)],
    });
    expect(world.commands("push").map((call) => call[2])).toEqual(
      [
        "1.2.3-amd64",
        "1.2.3-arm64",
        `experimental-${first}-amd64`,
        `experimental-${first}-arm64`,
      ].map((tag) => `${repository}:${tag}`),
    );
    // Promotion, not publication, moves the rolling alias.
    expect(pointsTo("experimental")).toBeUndefined();
  });

  it("announces a prerelease pinned to its commit with its image and digest", () => {
    world.history = [first];
    release("experimental", first);
    const tag = `experimental-${first}`;
    expect(world.refs.get(tag)).toBe(first);
    const created = world.commands("release create")[0] ?? [];
    expect(created).toEqual(
      expect.arrayContaining(["--target", first, "--prerelease", "--latest=false"]),
    );
    expect(created).toContain("--generate-notes");
    const notes = world.releases.get(tag)?.notes ?? "";
    expect(notes).toContain(`https://github.com/MaudeCode/kanvil/commit/${first}`);
    expect(notes).toContain(`${repository}:${tag}`);
    expect(notes).toContain(`${repository}@${pointsTo(tag) ?? "missing"}`);
    expect(notes).toContain(experimentalVersion(first));
  });

  it("reads an arm64 variant platform as arm64", () => {
    const version = experimentalVersion(first),
      archive = join(directory, `${first}-arm64.tar.gz`);
    world.archive(archive, "arm64", first, version);
    const image = world.archives.get(archive);
    if (image) image.platform = "linux/arm64/v8";
    publish("image", environment("experimental", version, first, "arm64"), world.run);
    world.archive(join(directory, `${first}-amd64.tar.gz`), "amd64", first, version);
    publish("image", environment("experimental", version, first, "amd64"), world.run);
    publish("manifest", environment("experimental", version, first), world.run);
    expect(pointsTo(`experimental-${first}`)).toBeDefined();
  });

  it("refuses a tested image from another commit, version, or architecture", () => {
    const version = experimentalVersion(first);
    const env = environment("experimental", version, first);
    world.archive(env.ARCHIVE, "amd64", second, experimentalVersion(second));
    expect(() => publish("image", env, world.run)).toThrow(`not built from ${first}`);
    world.archive(env.ARCHIVE, "amd64", first, experimentalVersion(second));
    expect(() => publish("image", env, world.run)).toThrow("is not version");
    world.archive(env.ARCHIVE, "arm64", first, version);
    expect(() => publish("image", env, world.run)).toThrow("is not amd64");
    expect(world.commands("push")).toEqual([]);
  });

  it.each([
    ["stable", "0.0.0-experimental.g" + first, "is not a valid stable version"],
    ["experimental", "1.2.3", "is not a valid experimental version"],
    ["experimental", experimentalVersion(second), "is not a valid experimental version"],
    ["nightly", "1.2.3", "must be stable or experimental"],
  ])("refuses a %s build named %s", (channel, version, message) => {
    expect(() => publish("image", environment(channel, version, first), world.run)).toThrow(
      message,
    );
    expect(world.calls).toEqual([]);
  });

  it("does not announce a release until every architecture is published", () => {
    const version = experimentalVersion(first);
    world.archive(join(directory, `${first}-amd64.tar.gz`), "amd64", first, version);
    world.archive(join(directory, `${first}-arm64.tar.gz`), "arm64", first, version);
    world.failing.add(`push ${repository}:experimental-${first}-arm64`);
    publish("image", environment("experimental", version, first, "amd64"), world.run);
    expect(() =>
      publish("image", environment("experimental", version, first, "arm64"), world.run),
    ).toThrow("unexpected registry error");
    expect(() =>
      publish("manifest", environment("experimental", version, first), world.run),
    ).toThrow("The arm64 image is not published");
    expect(() =>
      publish("release", environment("experimental", version, first), world.run),
    ).toThrow("is not published");
    expect(world.releases.size).toBe(0);
    expect(world.refs.size).toBe(0);

    // Rerunning only the failed architecture completes the build without republishing amd64.
    world.failing.clear();
    const pushes = world.commands("push").length;
    publish("image", environment("experimental", version, first, "arm64"), world.run);
    publish("image", environment("experimental", version, first, "amd64"), world.run);
    expect(world.commands("push").length).toBe(pushes + 1);
    publish("manifest", environment("experimental", version, first), world.run);
    publish("release", environment("experimental", version, first), world.run);
    expect(world.releases.get(`experimental-${first}`)?.prerelease).toBe(true);
  });
});

describe("reruns", () => {
  it("keep every published name and release unchanged", () => {
    world.history = [first];
    release("experimental", first);
    const tags = new Map(world.tags),
      calls = world.calls.length;
    release("experimental", first);
    expect(world.tags).toEqual(tags);
    const rerun = world.calls.slice(calls).map((call) => call.slice(0, 4).join(" "));
    expect(rerun.filter((call) => /push|create/.test(call))).toEqual([]);
    expect(world.releases.size).toBe(1);
  });

  it("refuse an architecture tag published from other bytes", () => {
    world.history = [first];
    release("experimental", first);
    const tag = `${repository}:experimental-${first}-amd64`;
    const before = world.tags.get(tag);
    world.blobs.set("sha256:other", {
      kind: "image",
      image: {
        platform: "linux/amd64",
        labels: { "org.opencontainers.image.revision": second },
      },
    });
    world.tags.set(tag, "sha256:other");
    const env = environment("experimental", experimentalVersion(first), first);
    expect(() => publish("image", env, world.run)).toThrow("Published names are never replaced");
    world.tags.set(tag, before ?? "");
  });

  it("refuse a release tag or manifest that names something else", () => {
    world.history = [first];
    release("experimental", first);
    const version = experimentalVersion(first);
    const env = environment("experimental", version, first);
    const tag = `experimental-${first}`;
    world.refs.set(tag, second);
    world.releases.delete(tag);
    expect(() => publish("release", env, world.run)).toThrow(`points to ${second}`);
    world.refs.set(tag, first);
    world.releases.set(tag, { prerelease: false, draft: false, notes: "" });
    expect(() => publish("release", env, world.run)).toThrow("is not a published prerelease");

    world.tags.set(`${repository}:${tag}`, pointsTo(`${tag}-amd64`) ?? "");
    expect(() => publish("manifest", env, world.run)).toThrow(
      "already exists for linux/arm64 with a different source",
    );
  });

  it("stop on a registry or GitHub failure instead of publishing", () => {
    world.failing.add("imagetools inspect");
    const version = experimentalVersion(first);
    const env = environment("experimental", version, first);
    world.archive(env.ARCHIVE, "amd64", first, version);
    expect(() => publish("image", env, world.run)).toThrow("unexpected registry error");
    expect(world.commands("push")).toEqual([]);
  });
});

describe("the experimental alias", () => {
  beforeEach(() => {
    world.history = [first, second, third];
  });

  it("follows main forward as builds finish in order", () => {
    promote();
    expect(pointsTo("experimental")).toBeUndefined();
    release("experimental", first);
    promote();
    expect(revisionOf("experimental")).toBe(first);
    expect(pointsTo("experimental")).toBe(pointsTo(`experimental-${first}`));
    release("experimental", second);
    promote();
    expect(revisionOf("experimental")).toBe(second);
  });

  it("never moves backward when builds finish out of order or old runs repeat", () => {
    release("experimental", third);
    promote();
    expect(revisionOf("experimental")).toBe(third);
    release("experimental", second);
    promote();
    release("experimental", first);
    release("experimental", first);
    promote();
    expect(revisionOf("experimental")).toBe(third);
    expect(
      world
        .commands("imagetools create")
        .filter((call) => call.includes(`${repository}:experimental`)),
    ).toHaveLength(1);
  });

  it("recovers a missed promotion from published images without rebuilding", () => {
    release("experimental", first);
    promote();
    // The newest build published and announced, then its promotion failed.
    release("experimental", third);
    world.failing.add("--tag ghcr.io/maudecode/kanvil:experimental ");
    expect(promote).toThrow("unexpected registry error");
    expect(revisionOf("experimental")).toBe(first);
    world.failing.clear();
    const pushes = world.commands("push").length;
    // An older run's promotion still selects the newest published build.
    release("experimental", second);
    promote();
    expect(revisionOf("experimental")).toBe(third);
    expect(world.commands("push").length).toBe(pushes + 2);
  });

  it("ignores published builds no longer on main and unannounced images", () => {
    release("experimental", first);
    release("experimental", "5".repeat(40));
    promote();
    expect(revisionOf("experimental")).toBe(first);
    // Images without a release are not yet complete.
    const version = experimentalVersion(second);
    for (const arch of ["amd64", "arm64"]) {
      world.archive(join(directory, `${second}-${arch}.tar.gz`), arch, second, version);
      publish("image", environment("experimental", version, second, arch), world.run);
    }
    publish("manifest", environment("experimental", version, second), world.run);
    promote();
    expect(revisionOf("experimental")).toBe(first);
  });
});

describe("the publication gate", () => {
  const ci = {
    id: 42,
    conclusion: "success",
    event: "push",
    head_branch: "main",
    head_sha: second,
    head_repository: { full_name: "MaudeCode/kanvil" },
  };
  async function decide(change: Record<string, unknown>) {
    world.history = [first, second];
    const path = join(directory, "event.json"),
      output = join(directory, "output");
    await writeFile(path, JSON.stringify({ workflow_run: { ...ci, ...change } }));
    await writeFile(output, "");
    const result = identity(
      { GITHUB_EVENT_PATH: path, GITHUB_OUTPUT: output, GITHUB_REPOSITORY: "MaudeCode/kanvil" },
      world.run,
    );
    return { result, written: await readFile(output, "utf8") };
  }

  it("publishes a successful push run of main", async () => {
    const { result, written } = await decide({});
    expect(result).toEqual({
      publish: "true",
      revision: second,
      version: experimentalVersion(second),
      "run-id": "42",
    });
    expect(written).toBe(
      `publish=true\nrevision=${second}\nversion=${experimentalVersion(second)}\nrun-id=42\n`,
    );
  });

  it.each([
    { conclusion: "failure" },
    { conclusion: "cancelled" },
    { conclusion: "skipped" },
    { event: "pull_request" },
    { event: "workflow_dispatch" },
    { head_branch: "feature" },
    { head_branch: "v1.2.3" },
    { head_repository: { full_name: "someone/kanvil" } },
    { head_sha: "5".repeat(40) },
  ])("refuses %o", async (change) => {
    const { result, written } = await decide(change);
    expect(result).toEqual({ publish: "false" });
    expect(written).toBe("publish=false\n");
  });
});
