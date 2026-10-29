import { chmod, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vite-plus/test";
import { runClient } from "./client.ts";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});
async function harness() {
  const directory = await mkdtemp(join(tmpdir(), "kanvil-client-"));
  directories.push(directory);
  const path = join(directory, "private/client.json");
  const run = async (args: string[], stdin = "", request?: typeof fetch) => {
    let stdout = "",
      stderr = "";
    const code = await runClient(args, {
      configPath: path,
      stdin: async () => stdin,
      stdout: (text) => {
        stdout += text;
      },
      stderr: (text) => {
        stderr += text;
      },
      fetch:
        request ??
        (async () => {
          throw new Error("Unexpected request");
        }),
    });
    return { code, stdout, stderr };
  };
  const configure = (
    name = "default",
    server = "https://kanvil.example.test",
    project = "project-a",
  ) =>
    run(
      ["profile", "set", name, "--server", server, "--project", project, "--token-stdin"],
      `private-token-${name}\n`,
    );
  return { run, configure, path };
}

test("profiles are private, atomic, redacted, and isolated by name and project", async () => {
  const h = await harness();
  expect((await h.configure()).code).toBe(0);
  expect((await stat(h.path)).mode & 0o777).toBe(0o600);
  expect((await stat(join(h.path, ".."))).mode & 0o777).toBe(0o700);
  expect((await h.configure("other", "https://other.example.test", "project-b")).code).toBe(0);
  const listing = await h.run(["profile", "list"]);
  expect(listing.stdout).not.toContain("private-token");
  expect(JSON.parse(listing.stdout)).toHaveLength(2);
  const seen: string[] = [];
  const request: typeof fetch = async (url, init) => {
    seen.push(
      `${url instanceof Request ? url.url : url.toString()}|${new Headers(init?.headers).get("Authorization")}`,
    );
    expect(init?.redirect).toBe("error");
    return Response.json([]);
  };
  expect(
    (await h.run(["project", "list", "--profile", "other", "--json"], "", request)).stdout,
  ).toBe("[]\n");
  expect(seen).toEqual([
    "https://other.example.test/api/v1/projects?archived=exclude|Bearer private-token-other",
  ]);
  expect(
    (await h.run(["task", "list", "--input", '{"projectId":"project-b"}'], "", request)).code,
  ).toBe(2);
  expect(seen).toHaveLength(1);
  expect((await h.configure()).code).toBe(2);
  expect((await h.run(["profile", "remove", "default"])).code).toBe(2);
  expect((await h.run(["profile", "remove", "default", "--yes"])).code).toBe(0);
  expect((await h.run(["profile", "list"])).stdout).toContain("other");
});

test("lost write responses retry identical request IDs and versions, conflicts never retry", async () => {
  const h = await harness();
  await h.configure();
  const bodies: string[] = [];
  const request: typeof fetch = async (_url, init) => {
    bodies.push(typeof init?.body === "string" ? init.body : "");
    if (bodies.length === 1) throw new TypeError("lost response private-token-default");
    return Response.json(
      { error: { code: "version_conflict", message: "private-token-default" } },
      { status: 409 },
    );
  };
  const args = [
    "task",
    "update",
    "CLI-1",
    "--expected-version",
    "7",
    "--changes",
    '{"title":"Changed"}',
  ];
  expect((await h.run(args, "", request)).code).toBe(5);
  expect(bodies).toHaveLength(2);
  expect(bodies[0]).toBe(bodies[1]);
  expect(JSON.parse(bodies[0] ?? "{}")).toMatchObject({
    expectedVersion: 7,
    requestId: expect.any(String),
    changes: { title: "Changed" },
  });
  bodies.splice(0);
  const conflict: typeof fetch = async (_url, init) => {
    bodies.push(typeof init?.body === "string" ? init.body : "");
    return Response.json(
      { error: { code: "version_conflict", message: "private-token-default" } },
      { status: 409 },
    );
  };
  const result = await h.run(args, "", conflict);
  expect(result.code).toBe(5);
  expect(result.stderr).not.toContain("private-token-default");
  expect(bodies).toHaveLength(1);
});

test("stdin is validated as an operation object and destructive commands require confirmation", async () => {
  const h = await harness();
  await h.configure();
  for (const args of [
    ["task", "create", "--input", "-"],
    ["task", "update", "CLI-1", "--changes", '{"title":"x"}'],
    ["task", "delete", "CLI-1", "--expected-version", "1"],
    ["task", "delete", "CLI-1", "--yes"],
    ["task", "create", "--title", "x", "--input", '{"titel":"y"}'],
  ])
    expect((await h.run(args, "not json private-token-default")).code).toBe(2);
  let sent: unknown;
  const request: typeof fetch = async (_url, init) => {
    sent = JSON.parse(typeof init?.body === "string" ? init.body : "");
    return Response.json({ ok: true });
  };
  const requestId = crypto.randomUUID();
  expect(
    (
      await h.run(
        ["task", "delete", "CLI-1", "--yes", "--input", "-"],
        JSON.stringify({ expectedVersion: 3, requestId }),
        request,
      )
    ).code,
  ).toBe(0);
  expect(sent).toEqual({ expectedVersion: 3, requestId });
});

test("unsafe origins, public configuration and symlinks fail closed without exposing input", async () => {
  const h = await harness();
  for (const origin of [
    "http://remote.example.test",
    "https://user:secret@example.test",
    "https://example.test/path",
    "https://example.test?token=secret",
  ])
    expect((await h.configure("bad", origin)).code).toBe(2);
  await h.configure();
  await chmod(h.path, 0o644);
  expect((await h.run(["profile", "list"])).code).toBe(2);
  await chmod(h.path, 0o600);
  const content = await readFile(h.path, "utf8");
  await rm(h.path);
  const target = `${h.path}.target`;
  await writeFile(target, content, { mode: 0o600 });
  await symlink(target, h.path);
  expect((await h.run(["profile", "list"])).code).toBe(2);
});

test("stable failure codes and messages exclude echoed secrets, payloads and transport details", async () => {
  const h = await harness();
  await h.configure();
  for (const [status, expected] of [
    [401, 3],
    [403, 3],
    [404, 4],
    [409, 5],
    [500, 1],
  ] as const) {
    const result = await h.run(["workspace", "list"], "", async () =>
      Response.json({ error: { code: "denied", message: "private-token-default" } }, { status }),
    );
    expect(result.code).toBe(expected);
    expect(result.stderr).toContain('"code":"denied"');
    expect(result.stderr).not.toContain("private-token-default");
  }
  const malformed = await h.run(["workspace", "list"], "", async () =>
    Response.json({ wrong: "server output" }),
  );
  expect(malformed.code).toBe(1);
  expect(JSON.parse(malformed.stderr)).toMatchObject({ error: { code: "invalid_response" } });
  const network = await h.run(["workspace", "list"], "", async () => {
    throw new TypeError("private-token-default");
  });
  const echoed = await h.run(["workspace", "list"], "", async () =>
    Response.json(
      { error: { code: "invalid_arguments", message: "private payload must not echo" } },
      { status: 400 },
    ),
  );
  expect(echoed.code).toBe(2);
  expect(echoed.stderr).not.toContain("private payload");
  expect(network.code).toBe(6);
  expect(network.stderr).not.toContain("private-token-default");
  expect((await h.run(["task", "--token", "do-not-echo"])).stderr).not.toContain("do-not-echo");
  const special = 'token"with\\escape';
  expect(
    (
      await h.run(
        ["profile", "set", "special", "--server", "https://special.example.test", "--token-stdin"],
        special,
      )
    ).code,
  ).toBe(0);
  const redacted = await h.run(["workspace", "list", "--profile", "special"], "", async () =>
    Response.json({ error: { code: special, message: special } }, { status: 403 }),
  );
  expect(JSON.parse(redacted.stderr)).toMatchObject({ error: { code: "[redacted]" } });
  expect((await h.run(["task", "--help"])).stdout).toContain("task create");
});

test("claim recover sends only the registered recovery operation with explicit confirmation", async () => {
  const h = await harness();
  await h.configure();
  expect((await h.run(["--help"])).stdout).toContain("claim recover");
  const claimId = crypto.randomUUID();
  const recovery = { claimId, reason: "Confirmed the old worker has stopped" };
  for (const input of [
    recovery,
    { ...recovery, confirmedStopped: false },
    { ...recovery, confirmedStopped: true, reschedule: true },
    { ...recovery, confirmedStopped: true, reason: "short" },
    { reason: recovery.reason, confirmedStopped: true },
  ])
    expect(
      (await h.run(["claim", "recover", "CLI-1", "--input", JSON.stringify(input)])).code,
    ).toBe(2);
  const seen: { method: string | undefined; url: string; body: unknown }[] = [];
  const request: typeof fetch = async (url, init) => {
    seen.push({
      method: init?.method,
      url: url instanceof Request ? url.url : url.toString(),
      body: JSON.parse(typeof init?.body === "string" ? init.body : "{}"),
    });
    return Response.json({ ok: true });
  };
  const requestId = crypto.randomUUID();
  const result = await h.run(
    [
      "claim",
      "recover",
      "CLI-1",
      "--expected-version",
      "4",
      "--request-id",
      requestId,
      "--json",
      "--input",
      "-",
    ],
    JSON.stringify({ ...recovery, confirmedStopped: true, reschedule: true }),
    request,
  );
  expect(result).toMatchObject({ code: 0, stdout: '{"ok":true}\n' });
  expect(seen).toEqual([
    {
      method: "POST",
      url: "https://kanvil.example.test/api/v1/projects/project-a/tickets/CLI-1/claim/recover",
      body: {
        ...recovery,
        confirmedStopped: true,
        reschedule: true,
        expectedVersion: 4,
        requestId,
      },
    },
  ]);
});
