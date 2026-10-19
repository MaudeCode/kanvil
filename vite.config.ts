import { defineConfig } from "vite-plus";
import { vitestSelection } from "./scripts/testing/policy.ts";

// The CI unit, broker, and search jobs select their files through the same policy as local runs.
const selection = vitestSelection();

export default defineConfig({
  test: {
    ...(selection.include && { include: selection.include }),
    exclude: ["**/node_modules/**", "**/dist/**", "e2e/**", ...selection.exclude],
    setupFiles: ["./scripts/testing/vitest-setup.ts"],
    reporters: ["default", "./scripts/testing/vitest-reporter.ts"],
  },
  fmt: {
    ignorePatterns: ["pnpm-lock.yaml", "**/drizzle/**", "**/auth-schema.ts"],
  },
  lint: {
    ignorePatterns: ["**/drizzle/**", "**/auth-schema.ts"],
    plugins: ["eslint", "typescript", "react", "unicorn", "oxc"],
    rules: { "react/react-in-jsx-scope": "off" },
    categories: {
      correctness: "error",
      suspicious: "error",
    },
    options: {
      typeAware: true,
      typeCheck: true,
      reportUnusedDisableDirectives: "error",
    },
  },
});
