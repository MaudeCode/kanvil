// Runs before every Vitest file: limits the file to the real boundaries its inventory family
// allows and records what each case reached. A refused attempt fails the case even when the code
// under test caught the error.
import { relative } from "node:path";
import { afterAll, afterEach, beforeEach, expect } from "vite-plus/test";
import { countNames, watchBoundaries, type Counts, type Violation } from "./boundaries.ts";
import { familyOf, root } from "./policy.ts";

const file = relative(root, expect.getState().testPath ?? "");
const watch = watchBoundaries(
  process.env.DISCOVER
    ? ["database", "loopback", "network", "process"]
    : (familyOf(file)?.boundaries ?? []),
);
const setup: Counts = {};
function settle(into: Counts | undefined) {
  const { counts, violations } = watch.take();
  if (into)
    for (const name of countNames) if (counts[name]) into[name] = (into[name] ?? 0) + counts[name];
  return violations;
}
function refuse(violations: Violation[]) {
  if (violations.length)
    throw new Error(
      `${file} reached boundaries its test family does not allow: ${violations
        .map(({ boundary, target }) => `${boundary} (${target})`)
        .join(", ")}. Use a boundary fake, or classify the family in scripts/testing/policy.ts.`,
    );
}
// File-level setup (beforeAll and module code) counts toward the file, not its first case.
beforeEach(() => refuse(settle(setup)));
afterEach(({ task }) => {
  const counts: Counts = {};
  const violations = settle(counts);
  task.meta.boundaries = counts;
  refuse(violations);
});
function recordFile(_context: object, suite: Readonly<{ meta: { boundaries?: Counts } }>) {
  const violations = settle(setup);
  suite.meta.boundaries = setup;
  refuse(violations);
}
// Bound so Vitest passes the file's suite without reading fixtures from the parameter list.
afterAll(recordFile.bind(undefined));

declare module "vite-plus/test" {
  interface TaskMeta {
    boundaries?: Counts;
  }
}
