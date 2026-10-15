import { spawnSync } from "node:child_process";
function run(command: string, args: string[], env = process.env) {
  const result = spawnSync(command, args, { stdio: "inherit", env });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} failed (${result.status ?? result.signal})`);
}
try {
  run("docker", ["compose", "-f", "compose.services-test.yml", "up", "-d", "--wait"]);
  run(
    "pnpm",
    [
      "exec",
      "vp",
      "test",
      "run",
      "apps/server/src/broker.integration.test.ts",
      "apps/server/src/search.integration.test.ts",
      "apps/server/src/instance.test.ts",
      "apps/server/src/blob-storage.test.ts",
    ],
    {
      ...process.env,
      TEST_RABBITMQ_URL: "amqp://kanvil-test:isolated-test-password@127.0.0.1:56672/kanvil-test",
      TEST_ELASTICSEARCH_URL: "http://127.0.0.1:57300",
    },
  );
} catch (error) {
  console.error(error instanceof Error ? error.message : "Optional service validation failed");
  process.exitCode = 1;
} finally {
  try {
    run("docker", ["compose", "-f", "compose.services-test.yml", "down"]);
  } catch {
    console.error(
      "Stop the isolated services with docker compose -f compose.services-test.yml down",
    );
    process.exitCode = 1;
  }
}
