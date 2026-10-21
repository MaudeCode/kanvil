import { runClient } from "./client.ts";

process.exitCode = await runClient(process.argv.slice(2), {
  stdin: async () => {
    process.stdin.setEncoding("utf8");
    let text = "";
    for await (const chunk of process.stdin) {
      text += String(chunk);
      if (Buffer.byteLength(text) > 1_000_000) throw new Error("Input exceeds the CLI limit.");
    }
    return text;
  },
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
});
