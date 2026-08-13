import { defineConfig } from "vitest/config";
import path from "node:path";

// Self-contained vitest config for the desktop app (kept separate from the
// Tauri-oriented vite.config.ts and from the repo-root vitest config).
export default defineConfig({
  resolve: {
    alias: { "@": path.resolve(__dirname, "src") },
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
