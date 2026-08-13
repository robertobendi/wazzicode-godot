import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@gvibe/bridge-client": r("./packages/bridge-client/src/index.ts"),
      "@gvibe/core": r("./packages/core/src/index.ts"),
      "@gvibe/mcp-server": r("./packages/mcp-server/src/index.ts"),
      "@gvibe/project-brain": r("./packages/project-brain/src/index.ts"),
      "@gvibe/safety": r("./packages/safety/src/index.ts"),
      "@gvibe/cli": r("./apps/cli/src/index.ts"),
    },
  },
  test: {
    include: ["tests/**/*.test.ts"],
    testTimeout: 20_000,
    pool: "threads",
  },
});
