import assert from "node:assert/strict";
import { sign } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import config from "../apps/mobile/app.config.ts";

const origin = "https://api.appstoreconnect.apple.com";
const row = z.object({ id: z.string(), attributes: z.record(z.string(), z.unknown()) });
const page = z.object({
  data: z.array(row),
  links: z.object({ next: z.string().nullable().optional() }).optional(),
});

// Like release-publish.ts, keep the release service behind an injected boundary for tests.
export async function testflight(
  command: string,
  version: string,
  buildNumber: string,
  request: (url: URL) => Promise<unknown>,
) {
  async function list(path: string, filters: Record<string, string>) {
    let url: URL | undefined = new URL(path, origin);
    url.search = new URLSearchParams({ ...filters, limit: "200" }).toString();
    const rows: z.infer<typeof row>[] = [];
    while (url) {
      assert.equal(url.origin, origin, "Refusing Apple credentials for another origin");
      const result = page.parse(await request(url));
      rows.push(...result.data);
      url = result.links?.next ? new URL(result.links.next, origin) : undefined;
    }
    return rows;
  }
  assert(command === "select" || command === "verify", "Expected select or verify");
  const apps = await list("/v1/apps", { "filter[bundleId]": config.ios!.bundleIdentifier! });
  assert.equal(apps.length, 1, "Expected one App Store Connect app for Kanvil");
  const builds = await list("/v1/builds", {
    "filter[app]": apps[0]!.id,
    "filter[preReleaseVersion.version]": version,
    "filter[preReleaseVersion.platform]": "IOS",
    ...(command === "verify" ? { "filter[version]": buildNumber } : {}),
  });
  if (command === "verify") {
    assert.equal(builds.length, 1, "Expected exactly one uploaded iOS build");
    const build = builds[0]!;
    assert.equal(build.attributes.version, buildNumber);
    assert.equal(build.attributes.processingState, "VALID");
    assert.equal(build.attributes.expired, false);
    return JSON.stringify({ buildId: build.id, version, buildNumber, processingState: "VALID" });
  }
  // Increment the first component so dotted legacy build numbers are also surpassed.
  const numbers = builds.map((build) => {
    const value = z
      .string()
      .regex(/^\d+(?:\.\d+){0,2}$/)
      .parse(build.attributes.version);
    return Number(value.split(".")[0]);
  });
  const next = Math.max(0, ...numbers) + 1;
  assert(next <= 9999, "Apple build number exhausted; use a newer release version");
  return String(next);
}

const required = (name: string) => z.string().min(1).parse(process.env[name]);
const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const key = readFileSync(required("APP_STORE_CONNECT_KEY_PATH"));
  const result = await testflight(
    process.argv[2] ?? "",
    z.string().parse(config.version),
    process.env.KANVIL_IOS_BUILD_NUMBER ?? "",
    async (url) => {
      const now = Math.floor(Date.now() / 1000);
      const input = `${encode({ alg: "ES256", kid: required("APP_STORE_CONNECT_KEY_ID"), typ: "JWT" })}.${encode({ iss: required("APP_STORE_CONNECT_ISSUER_ID"), iat: now - 30, exp: now + 600, aud: "appstoreconnect-v1" })}`;
      const signature = sign("sha256", Buffer.from(input), {
        key,
        dsaEncoding: "ieee-p1363",
      }).toString("base64url");
      const response = await fetch(url, {
        headers: { Authorization: `Bearer ${input}.${signature}` },
        signal: AbortSignal.timeout(30_000),
        redirect: "error",
      });
      assert(response.ok, `App Store Connect returned HTTP ${response.status}`);
      return response.json();
    },
  );
  console.info(result);
}
