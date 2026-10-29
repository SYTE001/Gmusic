/// <reference types="vitest/config" />
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  build: {
    sourcemap: false,
    target: "es2020",
  },
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./src/test/setup.ts"],
    css: false,
    testTimeout: 15000,
    // The Cloudflare Worker has its own package, config, and test run
    // (worker/). Never pick its files up here.
    exclude: ["**/node_modules/**", "**/dist/**", "worker/**"],
  },
});
