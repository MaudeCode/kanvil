// Writes this Playwright run's accounting report: every selected case once, with its result,
// duration, and the browser work it used, plus what the browser test server reached.
import { existsSync, readFileSync } from "node:fs";
import { relative } from "node:path";
import type { FullConfig, FullResult, Reporter, Suite, TestCase } from "@playwright/test/reporter";
import {
  activitySchema,
  countsSchema,
  environment,
  root,
  serverAccountingFile,
  writeReport,
  type CaseRecord,
} from "./policy.ts";

export default class AccountingReporter implements Reporter {
  private readonly startedAt = new Date().toISOString();
  private layer = "local-browser";
  private selected: TestCase[] = [];
  private workers = 1;
  onBegin(config: FullConfig, suite: Suite) {
    this.workers = config.workers;
    const base = process.env.KANVIL_TEST_LAYER ?? "local-browser";
    this.layer = config.shard ? `${base}-${config.shard.current}` : base;
    this.selected = suite.allTests();
  }
  async onEnd(result: FullResult) {
    const cases = this.selected.map((test): CaseRecord => {
      const file = relative(root, test.location.file);
      const last = test.results.at(-1);
      const boundaries = last?.annotations.find(({ type }) => type === "kanvil.boundaries");
      return {
        id: `${file} › ${test.titlePath().slice(3).join(" › ")}`,
        file,
        status: !last
          ? "notRun"
          : last.status === "passed" || last.status === "skipped"
            ? last.status
            : "failed",
        durationMs: last?.duration ?? 0,
        boundaries: boundaries?.description
          ? countsSchema.parse(JSON.parse(boundaries.description))
          : {},
      };
    });
    const server = existsSync(serverAccountingFile)
      ? activitySchema.parse(JSON.parse(readFileSync(serverAccountingFile, "utf8")))
      : undefined;
    writeReport({
      layer: this.layer,
      runner: "playwright",
      environment: { ...environment(), workers: this.workers },
      startedAt: this.startedAt,
      endedAt: new Date().toISOString(),
      complete: result.status === "passed" && cases.every((test) => test.status !== "notRun"),
      cases,
      setup: server ? [{ file: "apps/server/src/e2e-server.ts", boundaries: server.counts }] : [],
      ...(server?.violations.length ? { violations: server.violations } : {}),
    });
    if (server?.violations.length) {
      console.error(
        `The browser test server reached boundaries it does not allow: ${server.violations
          .map(({ boundary, target }) => `${boundary} (${target})`)
          .join(", ")}`,
      );
      return { status: "failed" as const };
    }
    return undefined;
  }
}
