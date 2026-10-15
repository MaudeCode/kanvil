import { defineConfig } from "vite-plus";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  resolve: { alias: { "@": new URL("./src", import.meta.url).pathname } },
  plugins: [react(), tailwindcss()],
  server: {
    proxy: {
      "/api": "http://localhost:5180",
      "/mcp": "http://localhost:5180",
      "/.well-known": "http://localhost:5180",
    },
  },
});
