import { execFileSync, spawn } from "node:child_process";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import { chromium, expect } from "@playwright/test";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { z } from "zod";
import { experimentalVersion, isReleaseVersion } from "./release-version.ts";
import { writeScriptReport } from "./testing/policy.ts";

const started = new Date();
const project = `kanvil-smoke-${crypto.randomUUID().slice(0, 8)}`;
const base = "http://localhost:5191",
  directory = await mkdtemp(join(tmpdir(), project));
const env = {
  ...process.env,
  COMPOSE_PROJECT_NAME: project,
  KANVIL_IMAGE: process.env.KANVIL_IMAGE ?? "kanvil:local",
  KANVIL_PORT: "5191",
  KANVIL_DATABASE: "kanvil",
  POSTGRES_PASSWORD: randomBytes(32).toString("hex"),
  BETTER_AUTH_SECRET: randomBytes(48).toString("base64url"),
  KANVIL_SETUP_TOKEN: randomBytes(32).toString("base64url"),
  KANVIL_URL: "https://kanvil.example.test",
  KANVIL_TRUSTED_ORIGINS: base,
  OIDC_DISCOVERY_URL: "",
  OIDC_CLIENT_ID: "",
  OIDC_CLIENT_SECRET: "",
  KANVIL_PUSH_ENABLED: "false",
  EXPO_ACCESS_TOKEN: "",
};
async function run(
  command: string,
  args: string[],
  overrides = env,
  allowFailure = false,
  input?: string,
) {
  const child = spawn(command, args, {
    env: overrides,
    stdio: [
      input === undefined ? "inherit" : "pipe",
      allowFailure ? "ignore" : "inherit",
      allowFailure ? "ignore" : "inherit",
    ],
  });
  if (input !== undefined) child.stdin?.end(input);
  const code = await new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  if (code !== 0 && !allowFailure) throw new Error(`${command} failed (${code})`);
  return code;
}
const ticketResult = z.object({
  ticket: z.object({ id: z.uuid(), key: z.string(), version: z.number() }),
});
const credentials = z.object({ id: z.string(), key: z.string() });
const attachmentSchema = z.object({ id: z.uuid() });
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
try {
  const label = (name: string) =>
    execFileSync(
      "docker",
      ["image", "inspect", env.KANVIL_IMAGE, "--format", `{{index .Config.Labels "${name}"}}`],
      { encoding: "utf8" },
    ).trim();
  const expectedVersion = label("org.opencontainers.image.version");
  expect(isReleaseVersion(expectedVersion)).toBe(true);
  // An experimental build names the commit its revision label records.
  if (expectedVersion.includes("-experimental."))
    expect(expectedVersion).toBe(experimentalVersion(label("org.opencontainers.image.revision")));
  await run("docker", ["compose", "up", "-d", "--no-build", "--wait"]);
  browser = await chromium.launch();
  const page = await browser.newPage();
  const failures: string[] = [];
  page.on("pageerror", (error) => failures.push(error.message));
  await page.goto(base);
  await page.getByLabel("Name", { exact: true }).fill("Container owner");
  await page.getByLabel("Setup token", { exact: true }).fill(env.KANVIL_SETUP_TOKEN);
  await page.getByLabel("Email", { exact: true }).fill("container@example.test");
  await page.getByLabel("Password", { exact: true }).fill("Container smoke password 42!");
  await page.getByRole("button", { name: "Create account", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Projects", exact: true })).toBeVisible();
  const info = z
    .object({ version: z.string() })
    .parse(await (await page.request.get(`${base}/api/v1/info`)).json());
  expect(info.version).toBe(expectedVersion);
  const settings = z
    .object({ deployment: z.object({ version: z.string() }) })
    .parse(await (await page.request.get(`${base}/api/v1/admin/instance`)).json());
  expect(settings.deployment.version).toBe(expectedVersion);
  const document = z
    .object({ info: z.object({ version: z.string() }) })
    .parse(await (await page.request.get(`${base}/api/openapi.json`)).json());
  expect(document.info.version).toBe(expectedVersion);
  await page.getByRole("button", { name: "New project", exact: true }).last().click();
  await page.getByLabel("Project name").fill("Container project");
  await page.getByLabel("Ticket prefix").fill("OPS");
  await page.getByRole("button", { name: "Create project", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Container project", exact: true })).toBeVisible();
  const projectId = new URL(page.url()).pathname.split("/")[2];
  if (!projectId) throw new Error("The container project has no route ID");
  await page.getByRole("button", { name: "New ticket", exact: true }).click();
  await page
    .getByLabel("Title", { exact: true })
    .fill("Restore tickets, sessions, events, credentials, and binary attachments together");
  await page.getByRole("button", { name: "Create ticket", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page
    .getByRole("link", {
      name: "Restore tickets, sessions, events, credentials, and binary attachments together",
      exact: true,
    })
    .click();
  const ticketId = new URL(page.url()).pathname.split("/")[4];
  if (!ticketId) throw new Error("The container ticket has no route ID");
  const bytes = Buffer.from([0, 1, 2, 13, 10, 128, 255]);
  const uploaded = await page.request.post(
    `${base}/api/v1/projects/${projectId}/tickets/${ticketId}/attachments`,
    { data: { name: "binary-proof.bin", data: bytes.toString("base64") } },
  );
  expect(uploaded.ok()).toBe(true);
  const attachment = attachmentSchema.parse(await uploaded.json());
  const projectBeforeIcon = z
    .object({ version: z.number(), workspaceId: z.uuid() })
    .parse(await (await page.request.get(`${base}/api/v1/projects/${projectId}`)).json());
  const iconBytes = await readFile("apps/web/public/brand/icon-192.png");
  const savedIcon = await page.request.post(`${base}/api/v1/projects/${projectId}/icon`, {
    data: {
      expectedVersion: projectBeforeIcon.version,
      icon: { kind: "image", contentType: "image/png", data: iconBytes.toString("base64") },
    },
  });
  expect(savedIcon.ok()).toBe(true);

  const issued = await page.request.post(`${base}/api/v1/credentials`, {
    data: {
      name: "Container consumer",
      projectIds: [projectId],
      scopes: ["read", "write", "claim"],
    },
  });
  expect(issued.ok()).toBe(true);
  const key = credentials.parse(await issued.json());
  const sdk = new Client({ name: "kanvil-container-smoke", version: "1.0.0" });
  try {
    await sdk.connect(
      new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
        requestInit: { headers: { Authorization: `Bearer ${key.key}` } },
      }),
    );
    expect(sdk.getServerVersion()?.version).toBe(expectedVersion);
    expect((await sdk.listTools()).tools.some((tool) => tool.name === "claim_ticket")).toBe(true);
  } finally {
    await sdk.close();
  }
  const newPassword = "Container recovered smoke password 43!";
  await run(
    "docker",
    [
      "compose",
      "exec",
      "-T",
      "app",
      "node",
      "dist/recover.mjs",
      "--email",
      "container@example.test",
    ],
    env,
    false,
    newPassword,
  );
  expect((await page.request.get(`${base}/api/v1/projects`)).status()).toBe(401);
  await page.reload();
  await expect(page.getByRole("heading", { name: "Sign in", exact: true })).toBeVisible();
  await page.getByLabel("Email", { exact: true }).fill("container@example.test");
  await page.getByLabel("Password", { exact: true }).fill(newPassword);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(
    page.getByRole("heading", {
      name: "Restore tickets, sessions, events, credentials, and binary attachments together",
      exact: true,
    }),
  ).toBeVisible();
  const backup = join(directory, "kanvil.dump");
  await run(process.execPath, ["scripts/backup.ts", "--output", backup]);
  expect((await stat(backup)).mode & 0o777).toBe(0o600);
  expect((await readFile(backup)).subarray(0, 5).toString()).toBe("PGDMP");
  expect(
    await run(process.execPath, ["scripts/backup.ts", "--output", backup], env, true),
  ).not.toBe(0);
  await run(process.execPath, [
    "scripts/restore.ts",
    "--file",
    backup,
    "--database",
    "kanvil_restored",
  ]);
  expect(
    await run(
      process.execPath,
      ["scripts/restore.ts", "--file", backup, "--database", "kanvil"],
      env,
      true,
    ),
  ).not.toBe(0);
  await run("docker", ["compose", "up", "-d", "--no-deps", "--no-build", "--wait", "app"], {
    ...env,
    KANVIL_DATABASE: "kanvil_restored",
  });
  await page.goto(base);
  await expect(page.getByRole("heading", { name: "Projects", exact: true })).toBeVisible();
  const restored = await page.request.get(
    `${base}/api/v1/projects/${projectId}/tickets/${ticketId}`,
  );
  expect(restored.ok()).toBe(true);
  expect(ticketResult.parse(await restored.json()).ticket.key).toBe("OPS-1");
  const content = await page.request.get(
    `${base}/api/v1/projects/${projectId}/attachments/${attachment.id}/content`,
  );
  expect(content.ok()).toBe(true);
  expect(await content.body()).toEqual(bytes);
  const projectAfterRestore = z
    .object({ workspaceId: z.uuid(), image: z.string() })
    .parse(await (await page.request.get(`${base}/api/v1/projects/${projectId}`)).json());
  expect(projectAfterRestore.workspaceId).toBe(projectBeforeIcon.workspaceId);
  const restoredIcon = await page.request.get(`${base}${projectAfterRestore.image}`);
  expect(restoredIcon.ok()).toBe(true);
  expect(await restoredIcon.body()).toEqual(iconBytes);

  const credentialRead = await page.request.get(`${base}/api/v1/projects/${projectId}/tickets`, {
    headers: { Authorization: `Bearer ${key.key}` },
  });
  expect(credentialRead.ok()).toBe(true);
  const icon = await page.request.get(`${base}/icon.svg`);
  expect(icon.status()).toBe(200);
  expect(failures).toEqual([]);
  console.info(
    "Container verification passed: browser setup, ticket writes, MCP, authenticated sessions, scoped credentials, and restored workspace, attachment, and project icon content.",
  );
  // One case per native architecture, as the CI matrix runs it.
  const architecture = process.arch === "arm64" ? "arm64" : "amd64";
  writeScriptReport(`docker-${architecture}`, "scripts/docker-smoke.ts", started, architecture);
} catch (error) {
  await run("docker", ["compose", "logs", "--no-color", "--tail", "80", "app"], env).catch(
    () => {},
  );
  throw error;
} finally {
  await browser?.close();
  try {
    await run("docker", ["compose", "down", "--volumes", "--remove-orphans"], env);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
