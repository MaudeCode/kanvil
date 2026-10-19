// Writes this Vitest run's accounting report: every collected case once, with its result,
// duration, and the real boundaries it reached.
import { relative } from "node:path";
import type { Reporter, TestModule, TestRunEndReason } from "vite-plus/test/node";
import type { Counts } from "./boundaries.ts";
import { environment, root, writeReport, type CaseRecord } from "./policy.ts";

export default class AccountingReporter implements Reporter {
  private readonly startedAt = new Date().toISOString();
  onTestRunEnd(
    modules: ReadonlyArray<TestModule>,
    errors: ReadonlyArray<unknown>,
    reason: TestRunEndReason,
  ) {
    const cases: CaseRecord[] = [],
      setup: { file: string; boundaries: Counts }[] = [];
    for (const module of modules) {
      const file = relative(root, module.moduleId);
      setup.push({ file, boundaries: module.meta().boundaries ?? {} });
      for (const test of module.children.allTests()) {
        const { state } = test.result();
        cases.push({
          id: `${file} › ${test.fullName}`,
          file,
          // A case still pending when the run ends never finished.
          status: state === "pending" ? "notRun" : state,
          durationMs: Math.round(test.diagnostic()?.duration ?? 0),
          boundaries: test.meta().boundaries ?? {},
        });
      }
    }
    writeReport({
      layer: process.env.KANVIL_TEST_LAYER ?? "local-vitest",
      runner: "vitest",
      environment: environment(),
      startedAt: this.startedAt,
      endedAt: new Date().toISOString(),
      complete:
        reason === "passed" &&
        errors.length === 0 &&
        modules.every((module) => module.state() === "passed" || module.state() === "skipped"),
      cases,
      setup,
    });
  }
}
