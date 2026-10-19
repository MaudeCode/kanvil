import { spawn } from "node:child_process";
import { lookup } from "node:dns/promises";
import { connect, createServer } from "node:net";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { createHttpSender, DeliveryError } from "../../apps/server/src/adapters/outbound.ts";
import { watchBoundaries } from "./boundaries.ts";
import { reconcile, requiredLayers, type CaseRecord, type LayerReport } from "./policy.ts";

// This file is a fast family: the guard allows it no real boundary. Each case that widens or
// trips the guard on purpose clears what it recorded and restores that policy afterwards.
afterEach(() => {
  watchBoundaries([]).take();
});
const refusal = (attempt: Promise<unknown>) =>
  attempt.then(
    () => "reached",
    (error: unknown) => (error instanceof Error ? error.message : String(error)),
  );

describe("boundary guard", () => {
  it("refuses an unexpected process, socket, or DNS lookup and records it even when caught", async () => {
    const watch = watchBoundaries([]);
    expect(() => spawn(process.execPath, ["--version"])).toThrow(/process/);
    const socket = connect(9, "127.0.0.1");
    expect(
      await refusal(new Promise((done, fail) => socket.on("error", fail).on("connect", done))),
    ).toMatch(/loopback 127\.0\.0\.1:9/);
    expect(await refusal(lookup("example.com"))).toMatch(/dns example\.com/);
    const unreachable = connect(443, "kanvil.example");
    expect(
      await refusal(new Promise((done, fail) => unreachable.on("error", fail).on("connect", done))),
    ).toMatch(/dns kanvil\.example/);
    expect(watch.take().violations.map(({ boundary }) => boundary)).toEqual([
      "process",
      "loopback",
      "network",
      "network",
    ]);
  });

  it("treats a named test database host as the database, not the network", async () => {
    const configured = process.env.TEST_DATABASE_URL;
    process.env.TEST_DATABASE_URL = "postgres://kanvil:kanvil@kanvil-db.invalid:5432/kanvil";
    try {
      const watch = watchBoundaries([]);
      expect(await refusal(lookup("kanvil-db.invalid"))).toMatch(/database dns kanvil-db\.invalid/);
      const socket = connect(5432, "kanvil-db.invalid");
      expect(
        await refusal(new Promise((done, fail) => socket.on("error", fail).on("connect", done))),
      ).toMatch(/database kanvil-db\.invalid:5432/);
      expect(watch.take().violations.map(({ boundary }) => boundary)).toEqual([
        "database",
        "database",
      ]);
    } finally {
      if (configured === undefined) delete process.env.TEST_DATABASE_URL;
      else process.env.TEST_DATABASE_URL = configured;
    }
  });

  it("lets a boundary fake answer without reaching anything", async () => {
    const watch = watchBoundaries([]);
    const error: unknown = await createHttpSender({
      allowPrivate: false,
      resolve: (hostname, _options, callback) =>
        callback(Object.assign(new Error(hostname), { code: "ENOTFOUND" }), []),
    })({ url: "https://hooks.kanvil.invalid/in", body: "{}" }).catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(DeliveryError);
    expect(watch.take()).toEqual({ counts: {}, violations: [] });
  });

  it("allows the loopback boundary an integration family is classified for", async () => {
    const watch = watchBoundaries(["loopback"]);
    const server = createServer((socket) => socket.end());
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected a TCP listener");
    await new Promise<void>((done, fail) =>
      connect(address.port, "127.0.0.1")
        .on("error", fail)
        .on("close", () => done()),
    );
    await new Promise((done) => server.close(done));
    expect(watch.take()).toEqual({ counts: { listen: 1, loopback: 1 }, violations: [] });
  });
});

const passed = (file: string, title: string): CaseRecord => ({
  id: `${file} › ${title}`,
  file,
  status: "passed",
  durationMs: 1,
  boundaries: {},
});
const report = (layer: string, cases: CaseRecord[], complete = true): LayerReport => ({
  layer,
  runner: layer.startsWith("browser") ? "playwright" : "vitest",
  environment: { node: "v24", platform: "linux", arch: "x64", cpus: 4, ci: true, command: "" },
  startedAt: "2026-01-01T00:00:00.000Z",
  endedAt: "2026-01-01T00:00:01.000Z",
  complete,
  cases,
  setup: [],
});
const outbound = "apps/server/src/adapters/outbound.test.ts",
  domain = "apps/server/src/domain.test.ts",
  branding = "e2e/branding.spec.ts";

const local = (cases: CaseRecord[]) => [report("local-vitest", cases)];

describe("accounting reconciliation", () => {
  it("accepts fast cases and a classified family at its bound", () => {
    const cases = Array.from({ length: 33 }, (_, index) => passed(domain, `case ${index}`));
    expect(reconcile(local([passed(outbound, "fast"), ...cases]), [])).toEqual(
      expect.not.arrayContaining([expect.stringContaining(domain)]),
    );
  });
  it("refuses an expanded family and an unclassified case that reached a real boundary", () => {
    const cases = Array.from({ length: 34 }, (_, index) => passed(domain, `case ${index}`));
    const unclassified = {
      ...passed("apps/server/src/new.test.ts", "opens a socket"),
      boundaries: { loopback: 1 },
    };
    const problems = reconcile(local([...cases, unclassified]), []);
    expect(problems).toContainEqual(
      expect.stringMatching(/domain\.test\.ts collected 34 heavyweight cases/),
    );
    expect(problems).toContainEqual(
      expect.stringMatching(/new\.test\.ts › opens a socket uses real infrastructure/),
    );
  });
  it("refuses an unclassified browser case", () => {
    const problems = reconcile([report("browser-1", [passed("e2e/new.spec.ts", "draws")])], []);
    expect(problems).toContainEqual(
      expect.stringMatching(/new\.spec\.ts › draws uses real infrastructure/),
    );
  });
  it("fails incomplete, missing, duplicated, skipped, and unfinished execution", () => {
    const problems = reconcile(
      [
        report("browser-1", [passed(branding, "serves")], false),
        report("browser-2", [passed(branding, "serves")]),
        report("unit", [
          { ...passed(outbound, "skipped"), status: "skipped" },
          { ...passed(outbound, "cancelled"), status: "notRun" },
        ]),
      ],
      requiredLayers,
    );
    for (const expected of [
      /Layer browser-1 did not complete/,
      /Layer browser-3 reported 0 times/,
      /branding\.spec\.ts › serves ran in both browser-1 and browser-2/,
      /outbound\.test\.ts › skipped skipped in unit/,
      /outbound\.test\.ts › cancelled notRun in unit/,
      /domain\.test\.ts completed 0 of its 33 required cases/,
    ])
      expect(problems).toContainEqual(expect.stringMatching(expected));
  });
  it("lets a local run skip optional-service cases that their CI layer runs", () => {
    const broker = "apps/server/src/broker.integration.test.ts";
    expect(
      reconcile(local([{ ...passed(broker, "delivers"), status: "skipped" }]), []).filter(
        (problem) => problem.includes(broker),
      ),
    ).toEqual([]);
  });
});
