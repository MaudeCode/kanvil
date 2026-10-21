import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout } from "node:timers/promises";
import { promisify } from "node:util";
import { z } from "zod";
import { releaseVersion } from "./release-version.ts";
import { createFixture } from "../apps/server/src/test-fixture.ts";
import { writeScriptReport } from "./testing/policy.ts";

const exec = promisify(execFile);
const started = new Date();
const directory = await mkdtemp(join(tmpdir(), "kanvil-package-"));
const fixture = await createFixture();
let server: ReturnType<typeof spawn> | undefined;
try {
  const tarballs = (await readdir("dist")).filter((file) => file.endsWith(".tgz"));
  assert.equal(tarballs.length, 1, "Expected one built release tarball");
  const [filename] = tarballs;
  assert(filename);
  const tarball = resolve("dist", filename);
  const packed = await exec("npm", ["pack", tarball, "--dry-run", "--json"]);
  const [contents] = z
    .array(z.object({ files: z.array(z.object({ path: z.string() })) }))
    .parse(JSON.parse(packed.stdout));
  assert(contents);
  assert(!contents.files.some(({ path }) => /node_modules|\.env$|\.test\.|\.map$/.test(path)));
  await exec("npm", [
    "install",
    "--prefix",
    directory,
    "--ignore-scripts",
    "--no-audit",
    "--no-fund",
    tarball,
  ]);
  const cli = join(directory, "node_modules/.bin/kanvil");
  const options = { cwd: directory };
  assert.match((await exec(cli, ["--help"], options)).stdout, /Usage: kanvil/);
  assert.match((await exec(cli, ["task", "--help"], options)).stdout, /task create/);
  const metadata = z
    .object({ version: z.string() })
    .parse(JSON.parse(await readFile("package.json", "utf8")));
  assert.equal(
    (await exec(cli, ["--version"], options)).stdout.trim(),
    releaseVersion(metadata.version),
  );
  await assert.rejects(exec(cli, ["invalid"], options));
  await exec(cli, ["configure", "--production", "https://kanvil.example.test"], options);
  assert.equal((await stat(join(directory, ".env"))).mode & 0o777, 0o600);
  const generated = await readFile(join(directory, ".env"), "utf8");
  await assert.rejects(exec(cli, ["configure"], options));
  assert.equal(await readFile(join(directory, ".env"), "utf8"), generated);
  await writeFile(
    join(directory, ".env"),
    `DATABASE_URL=${fixture.config.DATABASE_URL}\nBETTER_AUTH_SECRET=${fixture.config.BETTER_AUTH_SECRET}\nKANVIL_SETUP_TOKEN=${fixture.config.KANVIL_SETUP_TOKEN}\nKANVIL_URL=https://kanvil.example.test\nHOST=127.0.0.1\nPORT=5192\n`,
  );
  await exec(cli, ["migrate"], options);
  server = spawn(cli, ["start"], {
    ...options,
    env: {
      ...process.env,
      GITHUB_REF_TYPE: "branch",
      GITHUB_REF_NAME: "main",
      KANVIL_VERSION: "1.0.0",
    },
    stdio: "inherit",
  });
  const exited = once(server, "exit");
  const base = "http://127.0.0.1:5192";
  let healthy = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    assert.equal(server.exitCode, null, "Installed package exited");
    try {
      healthy = (await fetch(`${base}/healthz`, { signal: AbortSignal.timeout(1000) })).ok;
    } catch {
      /* Wait for the installed server to listen. */
    }
    if (healthy) break;
    await setTimeout(200);
  }
  assert(healthy, "Installed package did not start");
  const page = await fetch(base);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /<html/);
  const icon = await fetch(`${base}/icon.svg`);
  assert.equal(icon.status, 200);
  assert.match(await icon.text(), /<svg/);
  const info = z
    .object({ setupRequired: z.boolean(), version: z.string() })
    .parse(await (await fetch(`${base}/api/v1/info`)).json());
  assert.equal(info.setupRequired, true);
  const expectedVersion = releaseVersion(metadata.version);
  assert.equal(info.version, expectedVersion, "Public info must report the packaged version");
  const document = z
    .object({ info: z.object({ version: z.string() }) })
    .parse(await (await fetch(`${base}/api/openapi.json`)).json());
  assert.equal(document.info.version, expectedVersion, "OpenAPI must report the packaged version");
  const setup = await fetch(`${base}/api/v1/setup`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: "Package owner",
      email: "package@example.test",
      password: "Package smoke password 42!",
      token: fixture.config.KANVIL_SETUP_TOKEN,
    }),
  });
  assert.equal(setup.status, 201, await setup.text());
  const login = await fetch(`${base}/api/auth/sign-in/email`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: "https://kanvil.example.test" },
    body: JSON.stringify({ email: "package@example.test", password: "Package smoke password 42!" }),
  });
  assert.equal(login.status, 200, await login.text());
  const cookie = login.headers
    .getSetCookie()
    .map((value) => value.split(";")[0])
    .join("; ");
  const settings = z
    .object({ deployment: z.object({ version: z.string() }) })
    .parse(
      await (await fetch(`${base}/api/v1/admin/instance`, { headers: { Cookie: cookie } })).json(),
    );
  assert.equal(
    settings.deployment.version,
    expectedVersion,
    "Settings must report the packaged version",
  );
  const projectResponse = await fetch(`${base}/api/v1/projects`, {
    method: "POST",
    headers: {
      Cookie: cookie,
      Origin: "https://kanvil.example.test",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ key: "CLI", name: "Installed CLI" }),
  });
  assert.equal(projectResponse.status, 200);
  const project = z.object({ id: z.string() }).parse(await projectResponse.json());
  const credentialResponse = await fetch(`${base}/api/v1/credentials`, {
    method: "POST",
    headers: {
      Cookie: cookie,
      Origin: "https://kanvil.example.test",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      name: "Installed CLI",
      projectIds: [project.id],
      scopes: ["read", "write"],
    }),
  });
  assert.equal(credentialResponse.status, 201);
  const credential = z.object({ key: z.string() }).parse(await credentialResponse.json());
  const clientConfig = join(directory, "client.json");
  const configured = exec(
    cli,
    [
      "profile",
      "set",
      "default",
      "--config",
      clientConfig,
      "--server",
      base,
      "--project",
      project.id,
      "--token-stdin",
    ],
    options,
  );
  configured.child.stdin?.end(credential.key);
  const configuredOutput = await configured;
  assert(!configuredOutput.stdout.includes(credential.key));
  assert.equal((await stat(clientConfig)).mode & 0o777, 0o600);
  const created = z
    .object({ key: z.string(), version: z.number() })
    .parse(
      JSON.parse(
        (
          await exec(
            cli,
            ["task", "create", "--config", clientConfig, "--title", "Installed task", "--json"],
            options,
          )
        ).stdout,
      ),
    );
  const edited = exec(
    cli,
    ["task", "update", created.key, "--config", clientConfig, "--input", "-", "--json"],
    options,
  );
  edited.child.stdin?.end(
    JSON.stringify({ expectedVersion: created.version, changes: { title: "Edited from stdin" } }),
  );
  assert.equal(
    z.object({ title: z.string() }).parse(JSON.parse((await edited).stdout)).title,
    "Edited from stdin",
  );
  await assert.rejects(
    exec(
      cli,
      [
        "task",
        "update",
        created.key,
        "--config",
        clientConfig,
        "--expected-version",
        String(created.version),
        "--changes",
        '{"title":"Stale"}',
      ],
      options,
    ),
    (error: unknown) => error instanceof Error && "code" in error && error.code === 5,
  );
  // Exercise the existing recovery command against only this smoke test's owner.
  const recovery = exec(cli, ["recover", "--email", "package@example.test"], options);
  recovery.child.stdin?.end("Replacement package password 42!\n");
  assert.match((await recovery).stdout, /Local password replaced/);
  const recovered = await fetch(`${base}/api/auth/sign-in/email`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: "https://kanvil.example.test" },
    body: JSON.stringify({
      email: "package@example.test",
      password: "Replacement package password 42!",
    }),
  });
  assert.equal(recovered.status, 200);
  server.kill("SIGTERM");
  await exited;
  server = undefined;
  console.info(
    "Installed npm tarball verified: CLI, private config, migrations, web assets, health, and owner setup.",
  );
  writeScriptReport("package", "scripts/package-smoke.ts", started);
} finally {
  if (server && server.exitCode === null && server.signalCode === null) {
    const exited = once(server, "exit");
    server.kill("SIGKILL");
    await exited;
  }
  await fixture.close();
  await rm(directory, { recursive: true, force: true });
}
