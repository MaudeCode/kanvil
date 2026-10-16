import { defineConfig } from "vite-plus";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

const api = process.env.KANVIL_API_URL ?? "http://localhost:5180";
export default defineConfig({
  resolve: { alias: { "@": new URL("./src", import.meta.url).pathname } },
  plugins: [react(), tailwindcss()],
  server: {
    proxy: {
      "/api": api,
      "/mcp": api,
      "/.well-known": api,
    },
  },
});
