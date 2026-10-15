import { defineConfig } from "vite-plus";

export default defineConfig({
  fmt: {
    ignorePatterns: ["pnpm-lock.yaml", "**/drizzle/**", "**/auth-schema.ts"],
  },
  lint: {
    ignorePatterns: ["**/drizzle/**", "**/auth-schema.ts"],
    plugins: ["eslint", "typescript", "react", "unicorn", "oxc"],
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
