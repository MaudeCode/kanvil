import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { parseArgs } from "node:util";
import { z } from "zod";
import { createClient, type ApiClient } from "../packages/client/src/index.ts";
import { snapshotSchema } from "../packages/contracts/src/index.ts";
import { exampleConnection } from "./connection.ts";

const mirrorSchema = z.object({
  server: z.string(),
  projectId: z.string(),
  snapshot: snapshotSchema,
});

export async function mirrorProject(options: {
  client: ApiClient;
  baseUrl: string;
  projectId: string;
  output: string;
  signal: AbortSignal;
  onState?: (state: string) => void;
}) {
  const server = new URL(options.baseUrl).origin;
  let stored: z.output<typeof mirrorSchema> | undefined;
  try {
    stored = mirrorSchema.parse(JSON.parse(await readFile(options.output, "utf8")));
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }
  if (stored && (stored.server !== server || stored.projectId !== options.projectId))
    throw new Error("Choose a different output file for this server/project.");
  await mkdir(dirname(options.output), { recursive: true, mode: 0o700 });
  async function persist(snapshot: z.output<typeof snapshotSchema>) {
    const temporary = `${options.output}.${crypto.randomUUID()}.tmp`;
    const next = { server, projectId: options.projectId, snapshot };
    try {
      await writeFile(temporary, JSON.stringify(next), { mode: 0o600, flag: "wx", flush: true });
      await rename(temporary, options.output);
      stored = next;
    } finally {
      await rm(temporary, { force: true });
    }
  }
  async function refresh() {
    // shortcut: Refresh the full snapshot for each changed batch. Use incremental projection updates for large projects.
    const snapshot = await options.client.request(
      `/api/v1/snapshot?projectId=${encodeURIComponent(options.projectId)}`,
      snapshotSchema,
      { signal: options.signal },
    );
    await persist(snapshot);
    return snapshot.cursor;
  }
  const cursor = stored?.snapshot.cursor ?? (await refresh());
  await options.client.subscribe({
    projectId: options.projectId,
    cursor,
    signal: options.signal,
    ...(options.onState ? { onState: options.onState } : {}),
    onEvent: async (event) => {
      if (!stored || BigInt(event.id) > BigInt(stored.snapshot.cursor)) await refresh();
    },
    onCursor: async (position) => {
      if (stored && BigInt(position) > BigInt(stored.snapshot.cursor))
        await persist({ ...stored.snapshot, cursor: position });
    },
    onReset: refresh,
  });
}

if (import.meta.main) {
  const { values } = parseArgs({
    options: { project: { type: "string" }, output: { type: "string" } },
  });
  if (!values.project || !values.output)
    throw new Error("Pass --project <key-or-id> --output <private-file.json>.");
  const connection = exampleConnection(),
    controller = new AbortController();
  const stop = () => controller.abort();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    await mirrorProject({
      baseUrl: connection.baseUrl,
      client: createClient({
        baseUrl: connection.baseUrl,
        headers: () => ({ Authorization: `Bearer ${connection.key}` }),
      }),
      projectId: values.project,
      output: values.output,
      signal: controller.signal,
      onState: (state) => console.info(`Project mirror: ${state}`),
    });
  } catch (error) {
    if (!controller.signal.aborted) throw error;
  }
}
