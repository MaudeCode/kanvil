import { defineConfig } from "vite-plus";
import metadata from "../../package.json" with { type: "json" };
import { releaseVersion } from "../../scripts/release-version.ts";
export default defineConfig({
  pack: {
    define: {
      KANVIL_BUILD_VERSION: JSON.stringify(
        releaseVersion(process.env.KANVIL_VERSION ?? metadata.version),
      ),
    },
    entry: {
      index: "src/index.ts",
      migrate: "src/cli/migrate.ts",
      recover: "src/cli/recover.ts",
      configure: "../../scripts/configure.ts",
    },
    deps: { alwaysBundle: [/^@kanvil\/contracts(?:\/|$)/] },
    platform: "node",
    target: "node24",
    format: "esm",
  },
});
