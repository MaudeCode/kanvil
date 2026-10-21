// The test boundary policy: which test families may reach real infrastructure and why, which
// files each required layer selects, and the accounting every layer reports. Vitest, Playwright,
// the smoke scripts, and the CI Checks job all read this file.
//
//   node scripts/testing/policy.ts reconcile [directory]   every required CI layer, exactly once
//   node scripts/testing/policy.ts reconcile --local       the reports a local run produced
//   node scripts/testing/policy.ts summary [directory]     per-layer cases, time, and boundaries
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { arch, availableParallelism, platform, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  boundaries,
  countNames,
  type Boundary,
  type Counts,
  type Violation,
} from "./boundaries.ts";

export const root = fileURLToPath(new URL("../..", import.meta.url));
export const accountingDirectory = join(root, "test-accounting");
// The browser test server records what it reached here; the Playwright reporter reads it.
export const serverAccountingFile = join(
  tmpdir(),
  `kanvil-e2e-${process.env.KANVIL_TEST_PORT ?? "5190"}.accounting.json`,
);

export interface CaseRecord {
  id: string;
  file: string;
  // notRun: selected but never started or finished, as in a cancelled run.
  status: (typeof statuses)[number];
  durationMs: number;
  boundaries: Counts;
}
export interface Environment {
  node: string;
  platform: string;
  arch: string;
  cpus: number;
  ci: boolean;
  command: string;
  workers?: number;
}
export interface LayerReport {
  layer: string;
  runner: (typeof runners)[number];
  environment: Environment;
  startedAt: string;
  endedAt: string;
  // The runner reached its normal end and every selected case finished.
  complete: boolean;
  cases: CaseRecord[];
  // Activity outside any one case: module setup, the browser test server.
  setup: { file: string; boundaries: Counts }[];
  // Refused attempts outside any case.
  violations?: Violation[];
}
const statuses = ["passed", "failed", "skipped", "notRun"] as const;
const runners = ["vitest", "playwright", "script"] as const;

// Reports are read without dependencies, so the CI Checks job needs only Node. A report that
// does not have this shape is partial and cannot pass.
function invalid(): never {
  throw new Error("An accounting report is incomplete or malformed.");
}
const record = (value: unknown) =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? value : invalid();
const field = (value: unknown, name: string): unknown => Reflect.get(record(value), name);
const text = (value: unknown) => (typeof value === "string" ? value : invalid());
const amount = (value: unknown) => (typeof value === "number" ? value : invalid());
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : invalid());
const choice = <T extends string>(options: readonly T[], value: unknown) =>
  options.find((option) => option === value) ?? invalid();
export function parseCounts(value: unknown): Counts {
  const counts: Counts = {};
  for (const name of Object.keys(record(value)))
    counts[choice(countNames, name)] = amount(field(value, name));
  return counts;
}
const parseViolation = (value: unknown): Violation => ({
  boundary: choice(boundaries, field(value, "boundary")),
  target: text(field(value, "target")),
});
export const parseActivity = (value: unknown) => ({
  counts: parseCounts(field(value, "counts")),
  violations: list(field(value, "violations")).map(parseViolation),
});
function parseReport(value: unknown): LayerReport {
  const setting = (name: string) => field(field(value, "environment"), name);
  const workers = setting("workers"),
    violations = field(value, "violations");
  return {
    layer: text(field(value, "layer")),
    runner: choice(runners, field(value, "runner")),
    environment: {
      node: text(setting("node")),
      platform: text(setting("platform")),
      arch: text(setting("arch")),
      cpus: amount(setting("cpus")),
      ci: setting("ci") === true,
      command: text(setting("command")),
      ...(workers === undefined ? {} : { workers: amount(workers) }),
    },
    startedAt: text(field(value, "startedAt")),
    endedAt: text(field(value, "endedAt")),
    complete: field(value, "complete") === true,
    cases: list(field(value, "cases")).map((entry) => ({
      id: text(field(entry, "id")),
      file: text(field(entry, "file")),
      status: choice(statuses, field(entry, "status")),
      durationMs: amount(field(entry, "durationMs")),
      boundaries: parseCounts(field(entry, "boundaries")),
    })),
    setup: list(field(value, "setup")).map((entry) => ({
      file: text(field(entry, "file")),
      boundaries: parseCounts(field(entry, "boundaries")),
    })),
    ...(violations === undefined ? {} : { violations: list(violations).map(parseViolation) }),
  };
}

const layers = ["unit", "broker", "search", "browser", "oidc", "package", "docker"] as const;
type Layer = (typeof layers)[number];
// A family of tests that reaches real infrastructure. `cases` bounds how many cases each file
// collects, so a new or expanded heavyweight case fails until it is classified here.
export interface Family {
  name: string;
  layer: Layer;
  // What the guard lets these Vitest files reach. Browser specs reach the browser test server,
  // whose own boundaries are set in apps/server/src/e2e-server.ts.
  boundaries: readonly Boundary[];
  // What a boundary fake cannot prove for these cases.
  property: string;
  cases: Readonly<Record<string, number>>;
}
const spec = (file: string, cases: number, property: string): Family => ({
  name: `browser: ${file}`,
  layer: "browser",
  boundaries: [],
  property,
  cases: { [`e2e/${file}`]: cases },
});

export const families: readonly Family[] = [
  {
    name: "PostgreSQL behavior",
    layer: "unit",
    boundaries: ["database"],
    property:
      "Transactions under the global write lock, constraints, version checks, idempotency receipts, exclusive claims, events committed with their writes, ordered replay, and permission queries run in PostgreSQL; an in-memory store would not prove them.",
    cases: {
      "apps/server/src/account-administration.test.ts": 7,
      "apps/server/src/account-deletion.test.ts": 8,
      "apps/server/src/authentication-policy.test.ts": 3,
      "apps/server/src/blob-storage.test.ts": 1,
      "apps/server/src/calendar.test.ts": 3,
      "apps/server/src/consumers.test.ts": 2,
      "apps/server/src/custom-fields.test.ts": 7,
      "apps/server/src/domain.test.ts": 33,
      "apps/server/src/foundation.test.ts": 5,
      "apps/server/src/imports.test.ts": 9,
      "apps/server/src/invitations.test.ts": 10,
      "apps/server/src/mentions.test.ts": 5,
      "apps/server/src/notification-categories.test.ts": 4,
      "apps/server/src/outbox.test.ts": 14,
      "apps/server/src/project-lifecycle.test.ts": 6,
      "apps/server/src/public-read.test.ts": 7,
      "apps/server/src/relocation.test.ts": 10,
      "apps/server/src/reminders.test.ts": 5,
      "apps/server/src/search-auth.test.ts": 1,
      "apps/server/src/staged-uploads.test.ts": 3,
      "apps/server/src/time-entries.test.ts": 7,
      "apps/server/src/workflow.test.ts": 6,
      "apps/server/src/workspace-ownership.test.ts": 5,
      "apps/server/src/workspace-roles.test.ts": 16,
      "apps/server/src/workspaces.test.ts": 12,
    },
  },
  {
    name: "PostgreSQL with loopback protocol fakes",
    layer: "unit",
    boundaries: ["database", "loopback"],
    property:
      "Adapters speak HTTP, SMTP, and OIDC to fakes on loopback, so request framing, headers, redirects, response limits, signatures, and the outbound sender's address checks run as in production, against PostgreSQL-backed services.",
    cases: {
      "apps/server/src/delivery.test.ts": 11,
      "apps/server/src/http.test.ts": 24,
      "apps/server/src/import-sources.test.ts": 26,
      "apps/server/src/instance.test.ts": 6,
      "apps/server/src/issue-sync.test.ts": 14,
      "apps/server/src/oidc-policy.test.ts": 25,
      "apps/server/src/repositories.test.ts": 15,
      "apps/server/src/sign-in-methods.test.ts": 26,
    },
  },
  {
    name: "Release publisher process",
    layer: "unit",
    boundaries: ["process"],
    property:
      "Runs the npm publishing script as a process against a stand-in npm on PATH, so its exit codes and the commands it issues are the real ones.",
    cases: { "scripts/publish-npm.test.ts": 1 },
  },
  {
    name: "RabbitMQ wakeups",
    layer: "broker",
    boundaries: ["database", "loopback"],
    property: "Event wakeups through a real RabbitMQ broker and its reconnect behavior.",
    cases: { "apps/server/src/broker.integration.test.ts": 1 },
  },
  {
    name: "Elasticsearch search",
    layer: "search",
    boundaries: ["database", "loopback"],
    property: "Indexing and authorized queries against a real Elasticsearch node.",
    cases: { "apps/server/src/search.integration.test.ts": 2 },
  },
  spec(
    "account-deletion.spec.ts",
    1,
    "Typed-confirmation gating, the signed-out redirect, and administration rows after deletion.",
  ),
  spec(
    "appearance.spec.ts",
    3,
    "Themes, responsive rows, skip link, sidebar, command palette, tooltips, the mobile sheet, and the sidebar and sheet transitions in a real layout engine.",
  ),
  spec(
    "auth-callback.spec.ts",
    2,
    "Callback errors survive a reload, hide provider details, and clear on retry in the browser.",
  ),
  spec(
    "authentication-policy.spec.ts",
    1,
    "The authentication administration form's layout and toggles across appearances and widths.",
  ),
  spec(
    "branding.spec.ts",
    1,
    "The built web app's served HTML, assets, manifest, and cache headers.",
  ),
  spec(
    "compact-list.spec.ts",
    1,
    "Narrow ticket-list layout, compact metadata, and label previews across widths and themes.",
  ),
  spec("context.spec.ts", 1, "Sidebar resizing, context menus, and clipboard actions."),
  spec(
    "custom-fields.spec.ts",
    1,
    "Custom fields through the composer, list columns, URL filters, and detail controls.",
  ),
  spec(
    "delivery.spec.ts",
    5,
    "Delivery and repository dialogs, write-only secret fields, and status rows that update from background delivery work.",
  ),
  spec(
    "import-export.spec.ts",
    3,
    "Export downloads, file-read races, preview invalidation, and per-provider connection fields.",
  ),
  spec(
    "invitations.spec.ts",
    1,
    "The invitation page's signed-out, wrong-account, and accepted states with real sessions.",
  ),
  spec(
    "linear-design.spec.ts",
    3,
    "Named themes, density, and appearance preferences in both appearances.",
  ),
  spec(
    "localization.spec.ts",
    3,
    "A language choice changes rendering, dates, direction, and layout but not stored values.",
  ),
  spec("manual-order.spec.ts", 3, "Keyboard, menu, and drag reordering across list and board."),
  spec(
    "oauth.spec.ts",
    1,
    "MCP authorization through the sign-in redirect, explicit consent, and PKCE in a browser.",
  ),
  spec(
    "product-ux.spec.ts",
    16,
    "Ticket writing, Inbox, mentions, notifications, composer, and preview interactions with real focus and keyboard.",
  ),
  spec(
    "project-lifecycle.spec.ts",
    1,
    "Archive, restore, move, and delete flows with read-only notices and typed confirmation.",
  ),
  spec(
    "public-sharing.spec.ts",
    1,
    "Read-only pages, the preview sheet, and revocation as a signed-out browser sees them.",
  ),
  spec(
    "relocation.spec.ts",
    1,
    "Moves and prefix changes from the context menu, with old links redirecting.",
  ),
  spec(
    "rich-text.spec.ts",
    3,
    "The visual editor, slash menu, Markdown and Mermaid rendering, and inline uploads.",
  ),
  spec(
    "schedule.spec.ts",
    3,
    "Calendar and timeline layouts, date pickers, and calendar feed dialogs.",
  ),
  spec("search.spec.ts", 1, "The search palette, keyboard navigation, hover cards, and paging."),
  spec(
    "settings.spec.ts",
    4,
    "Settings navigation, the avatar file chooser, palettes, preferences, and administration forms.",
  ),
  spec(
    "sign-in-methods.spec.ts",
    5,
    "Email code, sign-in link, password reset, and GitHub sign-in as a person performs them.",
  ),
  spec(
    "ticket-board.spec.ts",
    3,
    "Board drag and keyboard moves, workflow states in pickers and lanes, and backgrounds.",
  ),
  spec(
    "ticket-list.spec.ts",
    11,
    "List selection, the bulk toolbar, keyboard highlight, the preview sheet, labels, and saved views.",
  ),
  spec(
    "users.spec.ts",
    5,
    "Account administration dialogs, filters, cache purges on role changes, the workspace directory sheet, and the detail sheets' entry and exit transitions with normal and reduced motion.",
  ),
  spec(
    "workspace-ownership.spec.ts",
    1,
    "Ownership transfer and workspace deletion dialogs and their gating.",
  ),
  spec("workspace-roles.spec.ts", 1, "The role editor and reassignment dialogs."),
  spec(
    "workspace.spec.ts",
    3,
    "First-run owner setup, ticket detail, discussion, attachments, credentials, and realtime conflict banners.",
  ),
  spec(
    "workspaces.spec.ts",
    6,
    "Workspace switching, deep links, icons, empty-state layout, and role-gated controls.",
  ),
  {
    name: "PocketID sign-in",
    layer: "oidc",
    boundaries: [],
    property: "Discovery, passkey login, and explicit identity linking against a real PocketID.",
    cases: { "e2e/pocket-id.pocket.ts": 3 },
  },
  {
    name: "Installed npm package",
    layer: "package",
    boundaries: [],
    property: "The packed tarball installs, migrates, serves, and recovers as a user installs it.",
    cases: { "scripts/package-smoke.ts": 1 },
  },
  {
    name: "Native Docker image",
    layer: "docker",
    boundaries: [],
    property:
      "Each architecture's image serves the app, MCP, and attachments and restores a backup.",
    cases: { "scripts/docker-smoke.ts": 2 },
  },
];

// The reports a complete CI run requires, one per job and matrix entry.
export const requiredLayers = [
  "unit",
  "broker",
  "search",
  "browser-1",
  "browser-2",
  "browser-3",
  "browser-4",
  "oidc",
  "package",
  "docker-amd64",
  "docker-arm64",
] as const;

export function familyOf(file: string) {
  return families.find((family) => file in family.cases);
}
const owned = (layer: Layer) =>
  families.filter((family) => family.layer === layer).flatMap(({ cases }) => Object.keys(cases));
// Vitest files that belong to a dedicated service layer; every other file runs in the unit layer.
export function vitestSelection(layer = process.env.KANVIL_TEST_LAYER) {
  if (layer === "broker" || layer === "search") return { include: owned(layer), exclude: [] };
  return {
    include: undefined,
    exclude: layer === "unit" ? [...owned("broker"), ...owned("search")] : [],
  };
}

export function environment(): Environment {
  return {
    node: process.version,
    platform: platform(),
    arch: arch(),
    cpus: availableParallelism(),
    ci: process.env.CI === "true",
    command: process.argv.slice(1).join(" "),
  };
}

export function writeReport(report: LayerReport) {
  mkdirSync(accountingDirectory, { recursive: true });
  writeFileSync(join(accountingDirectory, `${report.layer}.json`), JSON.stringify(report, null, 1));
}
// Records a smoke script as one case of its layer once every check in it has passed.
export function writeScriptReport(layer: string, file: string, startedAt: Date, title = file) {
  writeReport({
    layer,
    runner: "script",
    environment: environment(),
    startedAt: startedAt.toISOString(),
    endedAt: new Date().toISOString(),
    complete: true,
    cases: [
      {
        id: title === file ? file : `${file} › ${title}`,
        file,
        status: "passed",
        durationMs: Date.now() - startedAt.getTime(),
        boundaries: {},
      },
    ],
    setup: [],
  });
}
export function readReports(directory = accountingDirectory) {
  return readdirSync(directory, { recursive: true })
    .map(String)
    .filter((name) => name.endsWith(".json"))
    .map((name): LayerReport =>
      parseReport(JSON.parse(readFileSync(join(directory, name), "utf8"))),
    );
}

// The family layers a report answers for. Local runs cover several CI layers at once and skip
// the optional-service cases whose services are not running.
function covered(layer: string): readonly Layer[] {
  if (layer === "local-vitest") return ["unit", "broker", "search"];
  if (layer === "local-browser") return ["browser", "oidc"];
  const name = layer.replace(/-(\d+|amd64|arm64)$/, "");
  return layers.filter((candidate) => candidate === name);
}
const optional: readonly Layer[] = ["broker", "search", "oidc"];
// Returns every reason these reports cannot pass. `required` lists the layers that must each
// report exactly once; a local run passes the layers it ran.
export function reconcile(reports: readonly LayerReport[], required: readonly string[]) {
  const problems: string[] = [];
  for (const layer of required) {
    const count = reports.filter((report) => report.layer === layer).length;
    if (count !== 1) problems.push(`Layer ${layer} reported ${count} times; it must report once.`);
  }
  const seen = new Map<string, string>(),
    collected = new Map<string, number>(),
    completed = new Map<string, number>(),
    answered = new Set<Layer>();
  for (const report of reports) {
    const answers = covered(report.layer),
      local = report.layer.startsWith("local-");
    if (!report.complete) problems.push(`Layer ${report.layer} did not complete.`);
    for (const violation of report.violations ?? [])
      problems.push(`Layer ${report.layer} reached ${violation.boundary} (${violation.target}).`);
    for (const layer of answers) if (!local || !optional.includes(layer)) answered.add(layer);
    for (const test of report.cases) {
      const family = familyOf(test.file);
      const previous = seen.get(test.id);
      if (previous) problems.push(`${test.id} ran in both ${previous} and ${report.layer}.`);
      seen.set(test.id, report.layer);
      collected.set(test.file, (collected.get(test.file) ?? 0) + 1);
      if (family && !answers.includes(family.layer))
        problems.push(`${test.id} ran in ${report.layer}, not its ${family.layer} layer.`);
      else if (
        !family &&
        (report.runner !== "vitest" || Object.values(test.boundaries).some(Boolean))
      )
        problems.push(
          `${test.id} uses real infrastructure but no family in scripts/testing/policy.ts classifies it.`,
        );
      if (test.status === "passed") completed.set(test.file, (completed.get(test.file) ?? 0) + 1);
      // A local run without an optional service skips the cases its CI layer runs.
      else if (!(local && test.status === "skipped" && family && optional.includes(family.layer)))
        problems.push(`${test.id} ${test.status} in ${report.layer}.`);
    }
  }
  for (const family of families)
    for (const [file, expected] of Object.entries(family.cases)) {
      const count = collected.get(file) ?? 0;
      if (count > expected)
        problems.push(
          `${file} collected ${count} heavyweight cases; ${family.name} allows ${expected}. Classify the new cases in scripts/testing/policy.ts or move them to a boundary fake.`,
        );
      else if (answered.has(family.layer) && (completed.get(file) ?? 0) < expected)
        problems.push(
          `${file} completed ${completed.get(file) ?? 0} of its ${expected} required cases.`,
        );
    }
  return problems;
}

export function summarize(reports: readonly LayerReport[]) {
  return reports
    .toSorted((a, b) => a.layer.localeCompare(b.layer))
    .map((report) => {
      const totals: Record<string, number> = {};
      for (const entry of [...report.cases, ...report.setup])
        for (const [name, count] of Object.entries(entry.boundaries))
          totals[name] = (totals[name] ?? 0) + (count ?? 0);
      return {
        layer: report.layer,
        cases: report.cases.length,
        caseSeconds: report.cases.reduce((sum, test) => sum + test.durationMs, 0) / 1000,
        wallSeconds: (Date.parse(report.endedAt) - Date.parse(report.startedAt)) / 1000,
        ...totals,
      };
    });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [command = "reconcile", ...rest] = process.argv.slice(2);
  const local = rest.includes("--local"),
    directory = rest.find((argument) => !argument.startsWith("--")) ?? accountingDirectory;
  const reports = readReports(directory);
  if (command === "summary") console.table(summarize(reports));
  else {
    const problems = reconcile(reports, local ? [] : requiredLayers);
    if (!local && reports.length === 0) problems.push(`No accounting reports in ${directory}.`);
    for (const problem of problems) console.error(problem);
    if (problems.length) process.exitCode = 1;
    else
      console.info(
        `${reports.reduce((sum, report) => sum + report.cases.length, 0)} cases across ${reports.length} layers reconciled.`,
      );
  }
}
