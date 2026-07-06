/// <reference types="vitest" />
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  // Desktop build serves from "/"; the hosted web build sets GEOMIND_WEB_BASE
  // (e.g. "/gm/") so nginx can mount it under a path. Env-gated so the Tauri
  // build is unaffected.
  base: process.env.GEOMIND_WEB_BASE || "/",
  plugins: [react()],
  resolve: {
    alias: {
      "@": r("./src"),
      "@ai4s/shared": r("../../packages/shared/src/index.ts"),
      "@ai4s/sdk/mock-server": r("../../packages/sdk/src/mockServer.ts"),
      "@ai4s/sdk": r("../../packages/sdk/src/index.ts"),
    },
  },
  test: {
    globals: true,
    environment: "jsdom",
    setupFiles: ["./src/test/setup.ts"],
    css: false,
  },
});
