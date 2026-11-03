/// <reference types="vitest/config" />
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  build: {
    sourcemap: false,
    target: "es2020",
    rollupOptions: {
      output: {
        // Stable vendor chunks: the framework and the optional cloud SDK
        // cache independently of app code, and the browser fetches them in
        // parallel instead of one monolithic parse.
        manualChunks(id) {
          const normalized = id.replace(/\\/g, "/");
          if (normalized.includes("node_modules/@supabase/")) {
            return "supabase";
          }
          if (
            normalized.includes("node_modules/react/") ||
            normalized.includes("node_modules/react-dom/") ||
            normalized.includes("node_modules/scheduler/") ||
            normalized.includes("node_modules/react-router") ||
            normalized.includes("node_modules/zustand/")
          ) {
            return "react-vendor";
          }
        },
      },
    },
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
