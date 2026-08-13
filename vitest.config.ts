import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@uvibe/bridge-client": r("./packages/bridge-client/src/index.ts"),
      "@uvibe/core": r("./packages/core/src/index.ts"),
      "@uvibe/mcp-server": r("./packages/mcp-server/src/index.ts"),
      "@uvibe/project-brain": r("./packages/project-brain/src/index.ts"),
      "@uvibe/safety": r("./packages/safety/src/index.ts"),
      "@uvibe/cli": r("./apps/cli/src/index.ts"),
    },
  },
  test: {
    include: ["tests/**/*.test.ts"],
    testTimeout: 20_000,
    pool: "threads",
  },
});
