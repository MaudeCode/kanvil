import { constants } from "node:fs";
import { mkdir, open, rename, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { parseArgs } from "node:util";
import { z } from "zod";
import { createClient, ApiError } from "@kanvil/client";
import { operations, type Operation } from "@kanvil/contracts";

// The registry owns input validation, paths, permissions and retry eligibility.
const commands = {
  "workspace list": "list_workspaces",
  "project list": "list_projects",
  "project get": "get_project",
  "project create": "create_project",
  "task list": "list_tickets",
  "task get": "get_ticket",
  "task create": "create_ticket",
  "task update": "update_ticket",
  "task delete": "delete_ticket",
  "task ready": "list_eligible_tickets",
  "comment list": "list_comments",
  "comment add": "add_comment",
  "claim acquire": "claim_ticket",
  "claim renew": "renew_claim",
  "claim release": "release_claim",
} satisfies Record<string, Operation>;

export const clientHelp = `Usage: kanvil <namespace> <action> [ticket-key] [options]
${Object.keys(commands).join("\n")}
profile set <name> --server <url> [--project <id>] --token-stdin
profile list | profile remove <name> --yes

--profile <name>       Named server/project credential (default: default)
--config <path>        Private configuration (default: ~/.config/kanvil/client.json)
--input <json|->       Operation input as a JSON object; - reads stdin
--title <text>         Ticket title
--body <markdown>      Comment body
--expected-version <n> Required version for update, delete and acquire
--changes <json>       Ticket update changes as a JSON object
--request-id <uuid>    Reuse for a deliberate retry across invocations
--json                Compact JSON output (default: indented JSON)
--yes                 Confirm task deletion or profile removal
--help                Show commands and input conventions

All operation fields also accept --input. A profile's project cannot be overridden.
Writes never refresh versions or retry conflicts. Credentials are never command arguments.
`;

const profileSchema = z.object({
  server: z.string().transform((value, context) => {
    try {
      const url = new URL(value);
      if (
        url.username ||
        url.password ||
        url.search ||
        url.hash ||
        url.pathname !== "/" ||
        (url.protocol !== "https:" &&
          !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))
      )
        throw new Error();
      return url.origin;
    } catch {
      context.addIssue({
        code: "custom",
        message: "Use an HTTPS server origin (HTTP only on loopback).",
      });
      return z.NEVER;
    }
  }),
  projectId: z.string().min(1).optional(),
  token: z
    .string()
    .trim()
    .min(1)
    .max(8192)
    .regex(/^[^\s]+$/),
});
const configSchema = z
  .object({ version: z.literal(1), profiles: z.record(z.string(), profileSchema) })
  .strict();
type Config = z.output<typeof configSchema>;
const objectSchema = z.record(z.string(), z.unknown());
// Unlike remote ApiError messages, these messages contain only our own fixed copy.
class UsageError extends ApiError {
  constructor(message: string) {
    super(400, "invalid_arguments", message);
  }
}
function usage(message: string): never {
  throw new UsageError(message);
}
function jsonObject(value: string): Record<string, unknown> {
  try {
    return objectSchema.parse(JSON.parse(value));
  } catch {
    return usage("Input must be a JSON object.");
  }
}
async function readConfig(path: string): Promise<Config> {
  let file;
  try {
    file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      return { version: 1, profiles: {} };
    throw new ApiError(400, "invalid_config", "Cannot open private CLI configuration.");
  }
  try {
    const info = await file.stat();
    if (!info.isFile() || (info.mode & 0o077) !== 0)
      usage("CLI configuration must be a private file (chmod 600).");
    return configSchema.parse(JSON.parse(await file.readFile("utf8")));
  } catch {
    throw new ApiError(
      400,
      "invalid_config",
      "Invalid CLI configuration; require a private file (chmod 600).",
    );
  } finally {
    await file.close();
  }
}
async function saveConfig(path: string, config: Config) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${crypto.randomUUID()}.tmp`;
  try {
    const file = await open(temporary, "wx", 0o600);
    try {
      await file.writeFile(JSON.stringify(config) + "\n");
    } finally {
      await file.close();
    }
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

export async function runClient(
  args: string[],
  io: {
    stdin: () => Promise<string>;
    stdout: (text: string) => void;
    stderr: (text: string) => void;
    configPath?: string;
    fetch?: typeof fetch;
  },
): Promise<number> {
  let secret = "";
  let compact = args.includes("--json");
  const serialize = (value: unknown, pretty = false) =>
    JSON.stringify(
      value,
      (_key, item: unknown) =>
        typeof item === "string" && secret ? item.replaceAll(secret, "[redacted]") : item,
      pretty ? 2 : undefined,
    );
  const output = (value: unknown) => io.stdout(serialize(value, !compact) + "\n");
  try {
    const { values, positionals } = parseArgs({
      args,
      allowPositionals: true,
      options: {
        help: { type: "boolean" },
        json: { type: "boolean" },
        yes: { type: "boolean" },
        profile: { type: "string", default: "default" },
        config: { type: "string" },
        input: { type: "string" },
        server: { type: "string" },
        project: { type: "string" },
        "token-stdin": { type: "boolean" },
        title: { type: "string" },
        body: { type: "string" },
        "expected-version": { type: "string" },
        changes: { type: "string" },
        "request-id": { type: "string" },
      },
    });
    compact = values.json ?? false;
    if (values.help) {
      io.stdout(clientHelp);
      return 0;
    }
    const [namespace, action, identifier, ...extra] = positionals;
    if (extra.length) usage("Too many command arguments.");
    const path =
      values.config ?? io.configPath ?? join(homedir(), ".config", "kanvil", "client.json");
    const config = await readConfig(path);
    if (namespace === "profile") {
      if (action === "list" && !identifier) {
        output(
          Object.entries(config.profiles).map(([name, { server, projectId }]) => ({
            name,
            server,
            projectId,
          })),
        );
      } else if (action === "set" && identifier) {
        if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(identifier))
          usage("Use a profile name containing letters, digits, hyphens or underscores.");
        if (!values["token-stdin"] || values.input)
          usage("Pass the credential privately with --token-stdin; do not use --input.");
        secret = (await io.stdin()).trim();
        const profile = profileSchema.parse({
          server: values.server,
          projectId: values.project,
          token: secret,
        });
        if (Object.hasOwn(config.profiles, identifier) && !values.yes)
          usage("Replacing a profile requires --yes.");
        Object.defineProperty(config.profiles, identifier, {
          value: profile,
          enumerable: true,
          configurable: true,
          writable: true,
        });
        await saveConfig(path, config);
        output({ name: identifier, server: profile.server, projectId: profile.projectId });
      } else if (action === "remove" && identifier) {
        if (!values.yes) usage("Removing a profile requires --yes.");
        if (!Object.hasOwn(config.profiles, identifier)) usage("Unknown profile.");
        delete config.profiles[identifier];
        await saveConfig(path, config);
        output({ ok: true });
      } else usage("Unknown profile command. Use --help.");
      return 0;
    }
    if (values.server || values.project || values["token-stdin"])
      usage("Server, project and token options belong to profile set.");
    const command = Object.entries(commands).find(
      ([name]) => name === `${namespace} ${action}`,
    )?.[1];
    if (!command) usage("Unknown client command. Use --help.");
    const profile = Object.hasOwn(config.profiles, values.profile)
      ? config.profiles[values.profile]
      : undefined;
    if (!profile) usage("Unknown profile. Use profile set first.");
    secret = profile.token;
    const input = values.input
      ? jsonObject(values.input === "-" ? await io.stdin() : values.input)
      : {};
    if (profile.projectId) {
      if (input.projectId !== undefined && input.projectId !== profile.projectId)
        usage("Input project differs from the selected profile.");
      if ("projectId" in operations[command].input.shape) input.projectId = profile.projectId;
    }
    if (identifier) {
      if (!("ticketId" in operations[command].input.shape))
        usage("This command takes no ticket argument.");
      if (input.ticketId !== undefined && input.ticketId !== identifier)
        usage("Conflicting ticket identifiers.");
      input.ticketId = identifier;
    }
    for (const key of ["title", "body"] as const)
      if (values[key] !== undefined) input[key] = values[key];
    if (values["expected-version"] !== undefined)
      input.expectedVersion = Number(values["expected-version"]);
    if (values["request-id"] !== undefined) input.requestId = values["request-id"];
    if (values.changes !== undefined) input.changes = jsonObject(values.changes);
    if (command === "delete_ticket" && !values.yes)
      usage("Deleting a task requires --yes and --expected-version.");
    // Validate unknown keys too: a misspelled field must not silently produce a different write.
    const spec = operations[command];
    if (Object.keys(input).some((key) => !Object.hasOwn(spec.input.shape, key)))
      usage("Unknown operation input field. See the API operation schema.");
    const parsed = spec.input.parse(input);
    const api = createClient({
      baseUrl: profile.server,
      headers: () => ({ Authorization: `Bearer ${profile.token}` }),
      credentials: "omit",
      fetch: (url, init) =>
        (io.fetch ?? fetch)(url, {
          ...init,
          redirect: "error",
          signal: AbortSignal.timeout(30_000),
        }),
    });
    output(await api.call(command, parsed));
    return 0;
  } catch (error) {
    const status = error instanceof ApiError ? error.status : 0;
    const code =
      error instanceof ApiError
        ? error.code
        : error instanceof z.ZodError
          ? "invalid_arguments"
          : "client_error";
    // Server, parser and transport errors can echo credentials or private input; never print them.
    const message =
      error instanceof UsageError
        ? error.message
        : error instanceof z.ZodError
          ? "Invalid input. Check the operation schema and required fields."
          : "Command failed. Check the error code, profile, permissions and server connection.";
    io.stderr(serialize({ error: { code, message } }) + "\n");
    return status === 401 || status === 403
      ? 3
      : status === 404
        ? 4
        : status === 409
          ? 5
          : status === 400 ||
              error instanceof z.ZodError ||
              error instanceof SyntaxError ||
              (error instanceof TypeError && "code" in error)
            ? 2
            : error instanceof TypeError ||
                (error instanceof Error && error.name === "TimeoutError")
              ? 6
              : 1;
  }
}
