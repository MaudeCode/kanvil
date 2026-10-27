import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test } from "vite-plus/test";
import { createClient } from "@kanvil/client";
import { z } from "zod";
import { claimSchema, commentSchema, projectSchema, ticketSchema } from "@kanvil/contracts";
import { createApplication } from "../app.ts";
import { createFixture } from "../test-fixture.ts";
import { runClient } from "./client.ts";

let fixture: Awaited<ReturnType<typeof createFixture>>;
let application: Awaited<ReturnType<typeof createApplication>>;
let directory: string;
let cookie: string;
let loseNextCreate = false;
const request: typeof fetch = async (url, init) => {
  const incoming = new Request(url, init);
  const response = await application.app.fetch(incoming);
  if (loseNextCreate && incoming.method === "POST" && incoming.url.endsWith("/tickets")) {
    loseNextCreate = false;
    throw new TypeError("Response lost after commit");
  }
  return response;
};
const owner = () =>
  createClient({
    baseUrl: fixture.config.KANVIL_URL,
    fetch: request,
    headers: () => ({ Cookie: cookie, Origin: fixture.config.KANVIL_URL }),
  });
const run = async (args: string[], stdin = "") => {
  let stdout = "",
    stderr = "";
  const code = await runClient(args, {
    configPath: join(directory, "client.json"),
    fetch: request,
    stdin: async () => stdin,
    stdout: (text) => {
      stdout += text;
    },
    stderr: (text) => {
      stderr += text;
    },
  });
  return { code, stdout, stderr };
};
const call = async (args: string[], input?: object) => {
  const result = await run(
    input ? [...args, "--input", "-", "--json"] : [...args, "--json"],
    input ? JSON.stringify(input) : "",
  );
  expect(result.code, result.stderr).toBe(0);
  return JSON.parse(result.stdout) as unknown;
};
beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "kanvil-cli-server-"));
  fixture = await createFixture();
  application = await createApplication(fixture.database, fixture.config);
  const input = {
    name: "CLI owner",
    email: "cli@example.test",
    password: "CLI test password 42!",
    token: fixture.config.KANVIL_SETUP_TOKEN,
  };
  expect(
    (
      await request(`${fixture.config.KANVIL_URL}/api/v1/setup`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      })
    ).status,
  ).toBe(201);
  const login = await request(`${fixture.config.KANVIL_URL}/api/auth/sign-in/email`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: fixture.config.KANVIL_URL },
    body: JSON.stringify({ email: input.email, password: input.password }),
  });
  expect(login.status).toBe(200);
  cookie = login.headers
    .getSetCookie()
    .map((value) => value.split(";")[0])
    .join("; ");
});
afterAll(async () => {
  await application?.close();
  await fixture?.close();
  if (directory) await rm(directory, { recursive: true, force: true });
});
async function configure(
  name: string,
  projectId: string,
  scopes = ["read", "write", "claim", "admin"],
) {
  const token = await owner().request("/api/v1/credentials", z.object({ key: z.string() }), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, projectIds: [projectId], scopes }),
  });
  expect(
    (
      await run(
        [
          "profile",
          "set",
          name,
          "--server",
          fixture.config.KANVIL_URL,
          "--project",
          projectId,
          "--token-stdin",
        ],
        token.key,
      )
    ).code,
  ).toBe(0);
}

test("CLI discovers work and creates, edits, comments, claims, renews, releases and deletes through authenticated operations", async () => {
  const project = await owner().call("create_project", { key: "CLI", name: "CLI test project" });
  await configure("default", project.id);
  expect(
    z
      .array(projectSchema)
      .parse(await call(["project", "list"]))
      .map((item) => item.id),
  ).toContain(project.id);
  expect(projectSchema.parse(await call(["project", "get"])).id).toBe(project.id);
  expect(
    z.array(z.object({ id: z.string() })).parse(await call(["workspace", "list"])).length,
  ).toBeGreaterThan(0);
  loseNextCreate = true;
  const created = ticketSchema.parse(
    await call(["task", "create"], {
      title: "Work from stdin",
      description: "A complete task",
      acceptanceCriteria: "The task is testable",
      automationReady: true,
      difficulty: "med",
    }),
  );
  const list = z
    .object({ items: z.array(ticketSchema) })
    .parse(await call(["task", "list"], { q: "stdin" }));
  expect(list.items.map((item) => item.id)).toEqual([created.id]);
  const read = z.object({ ticket: ticketSchema }).parse(await call(["task", "get", created.key]));
  expect(read.ticket.version).toBe(created.version);
  const updated = ticketSchema.parse(
    await call([
      "task",
      "update",
      created.key,
      "--expected-version",
      String(created.version),
      "--changes",
      '{"title":"Updated from CLI"}',
    ]),
  );
  expect(updated.title).toBe("Updated from CLI");
  const stale = await run([
    "task",
    "update",
    created.key,
    "--expected-version",
    String(created.version),
    "--changes",
    '{"title":"Stale overwrite"}',
  ]);
  expect(stale.code).toBe(5);
  expect(stale.stderr).toContain("version_conflict");
  const comment = commentSchema.parse(
    await call(["comment", "add", created.key, "--body", "CLI comment"]),
  );
  expect(
    z
      .object({ items: z.array(commentSchema) })
      .parse(await call(["comment", "list", created.key]))
      .items.map((row) => row.id),
  ).toContain(comment.id);
  expect(
    z.object({ items: z.array(z.unknown()) }).parse(await call(["task", "ready"])).items,
  ).toHaveLength(1);
  const claim = claimSchema.parse(
    await call(["claim", "acquire", created.key], {
      expectedVersion: updated.version,
      workerId: "cli-worker",
    }),
  );
  expect(
    claimSchema.parse(await call(["claim", "renew", created.key], { claimId: claim.id })).id,
  ).toBe(claim.id);
  expect(await call(["claim", "release", created.key], { claimId: claim.id })).toEqual({
    ok: true,
  });
  const current = z
    .object({ ticket: ticketSchema })
    .parse(await call(["task", "get", created.key]));
  expect(
    await call(["task", "delete", created.key, "--yes"], {
      expectedVersion: current.ticket.version,
    }),
  ).toEqual({ ok: true });
  expect((await run(["task", "get", created.key])).code).toBe(4);
});

test("CLI recovers an expired claim, reschedules it at the observed version and claims it again", async () => {
  const project = await owner().call("create_project", { key: "REC", name: "CLI recovery" });
  await configure("recovery-admin", project.id);
  await configure("recovery-worker", project.id, ["read", "write", "claim"]);
  await configure("recovery-unclaimed", project.id, ["read", "write"]);
  const worker = (args: string[], input?: object) =>
    call([...args, "--profile", "recovery-worker"], input);
  const read = async (key: string) =>
    z
      .object({ ticket: ticketSchema, claim: claimSchema.nullable() })
      .parse(await worker(["task", "get", key]));
  const created = ticketSchema.parse(
    await worker(["task", "create"], {
      title: "Recover through the CLI",
      description: "A stopped worker leaves an expired claim",
      acceptanceCriteria: "A new worker claims it again",
      automationReady: true,
      difficulty: "low",
    }),
  );
  const attempt = (profile: string, input: object) =>
    run(["claim", "recover", created.key, "--profile", profile, "--input", JSON.stringify(input)]);
  const stopped = claimSchema.parse(
    await worker(["claim", "acquire", created.key], {
      expectedVersion: created.version,
      workerId: "stopped-worker",
    }),
  );
  const claimed = await read(created.key);
  const recovery = {
    claimId: stopped.id,
    reason: "Confirmed the old worker has stopped",
    confirmedStopped: true,
  };
  expect((await attempt("recovery-worker", recovery)).stderr).toContain("claim_not_expired");
  expect((await attempt("recovery-worker", { ...recovery, cancelActive: true })).code).toBe(3);
  await fixture.database.pool.query(
    "UPDATE claims SET expires_at = now() - interval '1 second' WHERE id = $1",
    [stopped.id],
  );
  const reschedule = { ...recovery, reschedule: true };
  for (const [profile, input, code] of [
    ["recovery-worker", { ...recovery, confirmedStopped: false }, 2],
    ["recovery-worker", reschedule, 2],
    ["recovery-worker", { ...reschedule, expectedVersion: created.version }, 5],
    ["recovery-unclaimed", { ...reschedule, expectedVersion: claimed.ticket.version }, 3],
  ] as const)
    expect((await attempt(profile, input)).code).toBe(code);
  const unchanged = await read(created.key);
  expect(unchanged.ticket).toEqual(claimed.ticket);
  expect(unchanged.claim?.id).toBe(stopped.id);
  const retry = [
    "claim",
    "recover",
    created.key,
    "--expected-version",
    String(claimed.ticket.version),
    "--request-id",
    crypto.randomUUID(),
  ];
  expect(await worker(retry, reschedule)).toEqual({ ok: true });
  expect(await worker(retry, reschedule)).toEqual({ ok: true });
  const rescheduled = await read(created.key);
  expect(rescheduled.claim).toBeNull();
  expect(rescheduled.ticket).toMatchObject({
    status: "todo",
    version: claimed.ticket.version + 1,
  });
  const fresh = claimSchema.parse(
    await worker(["claim", "acquire", created.key], {
      expectedVersion: rescheduled.ticket.version,
      workerId: "replacement-worker",
    }),
  );
  expect(fresh.id).not.toBe(stopped.id);
  expect(
    await call(["claim", "recover", created.key, "--profile", "recovery-admin"], {
      ...recovery,
      claimId: fresh.id,
      cancelActive: true,
    }),
  ).toEqual({ ok: true });
  expect((await read(created.key)).claim).toBeNull();
});

test("CLI enforces server credential permissions and project isolation", async () => {
  const project = await owner().call("create_project", { key: "READ", name: "Read-only CLI" });
  const other = await owner().call("create_project", { key: "OTHER", name: "Other project" });
  await configure("reader", project.id, ["read"]);
  expect((await run(["task", "create", "--profile", "reader", "--title", "Forbidden"])).code).toBe(
    3,
  );
  expect(
    (
      await run([
        "task",
        "list",
        "--profile",
        "reader",
        "--input",
        JSON.stringify({ projectId: other.id }),
      ])
    ).code,
  ).toBe(2);
  expect((await owner().call("list_tickets", { projectId: project.id })).items).toEqual([]);
});
