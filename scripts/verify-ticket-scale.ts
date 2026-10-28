// Local performance gate; the CI policy owns deterministic DOM and workload checks instead.
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { basename, join } from "node:path";
import { z } from "zod";

const directory = process.argv[2];
assert(directory, "Pass the Playwright output directory from KANVIL_SCALE_BENCHMARK=1");
const files = readdirSync(directory, { recursive: true, encoding: "utf8" }).map((name) =>
  join(directory, name),
);
const read = (name: string): unknown => {
  const file = files.find((path) => basename(path) === name);
  assert(file, `Missing ${name}`);
  return JSON.parse(readFileSync(file, "utf8"));
};
const sample = z.object({
  metrics: z.array(z.object({ name: z.string(), value: z.number() })),
  longTasks: z.array(z.number()),
  mountedRows: z.number(),
  elements: z.number(),
  requests: z.array(z.object({ name: z.string(), duration: z.number(), bytes: z.number() })),
});
const families = ["initial", "board", "planning", "work", "realtime"];
let largestTask = 0,
  largestHeap = 0;
for (const family of families) {
  const samples = z
    .array(sample)
    .length(5)
    .parse(read(`${family}-performance-samples.json`));
  for (const value of samples) {
    const heap = value.metrics.find((metric) => metric.name === "JSHeapUsedSize")?.value;
    assert(heap !== undefined, "A post-GC heap sample is required");
    const task = Math.max(0, ...value.longTasks);
    assert(task <= 200, `${family}: main-thread task ${task} ms exceeds 200 ms`);
    assert(heap <= 200 * 1024 * 1024, `${family}: heap ${heap} exceeds 200 MiB`);
    assert(
      value.mountedRows <= 120 && value.elements <= 6000,
      `${family}: mounted DOM exceeds its bound`,
    );
    largestTask = Math.max(largestTask, task);
    largestHeap = Math.max(largestHeap, heap);
  }
}
const keyboard = ["list-keyboard-timing.json", "keyboard-timing.json"].map((name) => {
  const observation = z
    .object({
      trusted: z.literal(true),
      supported: z.literal(true),
      inputs: z.number().int().min(300),
      durations: z.array(z.number().nonnegative()),
    })
    .parse(read(name));
  assert(
    observation.durations.length <= observation.inputs,
    `${name}: timing phase contains unrelated inputs`,
  );
  // Event Timing omits events faster than its minimum 16 ms threshold; retain their upper bound.
  const values = [
    ...observation.durations,
    ...Array.from({ length: observation.inputs - observation.durations.length }, () => 16),
  ].toSorted((a, b) => a - b);
  const p95 = values[Math.ceil(values.length * 0.95) - 1];
  assert(p95 !== undefined && p95 <= 50, `${name}: p95 ${p95} ms exceeds 50 ms`);
  return { name, p95 };
});
console.info(
  JSON.stringify({
    samples: 25,
    largestTaskMs: largestTask,
    largestHeapMiB: largestHeap / 1024 / 1024,
    keyboard,
  }),
);
