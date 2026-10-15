import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, chmod, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: { simulator: { type: "string" }, https: { type: "boolean", default: false } },
});
const directory = await mkdtemp(join(tmpdir(), "kanvil-native-auth-"));
await chmod(directory, 0o700);
const certificate = join(directory, "cert.pem"),
  key = join(directory, "key.pem");
const env = { ...process.env, KANVIL_TEST_TLS_DIR: directory };
const compose = ["compose", "-f", "compose.auth-test.yml", "-f", "compose.native-auth-test.yml"];
function run(command: string, args: string[]) {
  const result = spawnSync(command, args, { env, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} failed (${result.status ?? result.signal})`);
}
let child: ReturnType<typeof spawn> | undefined;
try {
  run("openssl", [
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-noenc",
    "-sha256",
    "-days",
    "2",
    "-subj",
    "/CN=localhost",
    "-addext",
    "subjectAltName=DNS:localhost,IP:127.0.0.1",
    "-addext",
    "basicConstraints=critical,CA:TRUE",
    "-keyout",
    key,
    "-out",
    certificate,
  ]);
  await chmod(key, 0o600);
  if (values.simulator)
    run("xcrun", ["simctl", "keychain", values.simulator, "add-root-cert", certificate]);
  run("docker", [...compose, "up", "-d", "--wait"]);
  console.info(`Native fixture CA: ${certificate}`);
  child = spawn(process.execPath, ["apps/server/src/e2e-server.ts"], {
    env: {
      ...env,
      NODE_EXTRA_CA_CERTS: certificate,
      KANVIL_TEST_PORT: "5188",
      KANVIL_TEST_POCKET_ID: "1",
      KANVIL_TEST_POCKET_TLS: "1",
      ...(values.https ? { KANVIL_TEST_TLS_CERT: certificate, KANVIL_TEST_TLS_KEY: key } : {}),
    },
    stdio: "inherit",
  });
  const stop = () => child?.kill("SIGTERM");
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  const code = await new Promise<number | null>((resolve, reject) => {
    child?.once("error", reject);
    child?.once("exit", resolve);
  });
  if (code) process.exitCode = code;
} finally {
  child?.kill("SIGTERM");
  try {
    run("docker", [...compose, "down"]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
