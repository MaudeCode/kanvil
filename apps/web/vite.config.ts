import { defineConfig } from "vite-plus";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    proxy: {
      "/api": "http://localhost:5180",
      "/mcp": "http://localhost:5180",
      "/.well-known": "http://localhost:5180",
    },
  },
});
