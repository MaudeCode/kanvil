import { defineConfig } from "vite-plus";
export default defineConfig({
  pack: {
    entry: { index: "src/index.ts", migrate: "src/cli/migrate.ts", recover: "src/cli/recover.ts" },
    deps: { alwaysBundle: [/^@kanvil\/contracts(?:\/|$)/] },
    platform: "node",
    target: "node24",
    format: "esm",
  },
});
