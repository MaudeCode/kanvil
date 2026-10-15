import { defineConfig } from "vite-plus";

export default defineConfig({
  test: { exclude: ["**/node_modules/**", "**/dist/**", "e2e/**"] },
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
