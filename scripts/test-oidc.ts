import { spawnSync } from "node:child_process";
function run(command: string, args: string[], env = process.env) {
  const result = spawnSync(command, args, { stdio: "inherit", env });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} failed (${result.status ?? result.signal})`);
}
try {
  run("docker", ["compose", "-f", "compose.auth-test.yml", "up", "-d", "--wait"]);
  run("pnpm", ["test:e2e"], { ...process.env, KANVIL_TEST_POCKET_ID: "1" });
} catch (error) {
  console.error(error instanceof Error ? error.message : "OIDC browser validation failed");
  process.exitCode = 1;
} finally {
  try {
    run("docker", ["compose", "-f", "compose.auth-test.yml", "down"]);
  } catch {
    console.error(
      "Stop the isolated PocketID fixture with docker compose -f compose.auth-test.yml down",
    );
    process.exitCode = 1;
  }
}
