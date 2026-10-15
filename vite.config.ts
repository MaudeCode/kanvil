import { defineConfig } from "vite-plus";

export default defineConfig({
  fmt: {
    ignorePatterns: ["pnpm-lock.yaml"],
  },
  lint: {
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
