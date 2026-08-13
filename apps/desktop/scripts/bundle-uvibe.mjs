// Bundle the uvibe CLI into ONE self-contained CommonJS file, plus copy the
// Unity Editor package, so the Tauri app can ship its own MCP server without
// requiring employees to have Node or the monorepo on disk.
//
// Outputs:
//   src-tauri/resources/uvibe.cjs        — apps/cli + all @uvibe/* + zod + MCP SDK, bundled
//   src-tauri/resources/UnityVibeOS/     — the com.uvibe.os UPM package (source of truth)
//
// The bundled CLI is launched by the Node 20 sidecar (see fetch-node-sidecar.mjs
// and src-tauri/src/mcpconfig.rs). Version-locking both to the app release means
// the MCP server can never drift from the UI that drives it.
//
// Run standalone: `pnpm --filter @uvibe/desktop bundle` (also fetches the sidecar
// for the host triple). Dev builds do NOT depend on this — they use the
// dev_uvibe_entry fallback in mcpconfig.rs.

import { build } from "esbuild";
import { execSync } from "node:child_process";
import { existsSync, rmSync, mkdirSync, cpSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const desktopRoot = path.resolve(here, "..");
const repoRoot = path.resolve(here, "..", "..", "..");

const cliDir = path.join(repoRoot, "apps", "cli");
const cliEntry = path.join(cliDir, "dist", "index.js");
const resourcesDir = path.join(desktopRoot, "src-tauri", "resources");
const outFile = path.join(resourcesDir, "uvibe.cjs");
const unitySrc = path.join(repoRoot, "unity", "UnityVibeOS");
const unityDest = path.join(resourcesDir, "UnityVibeOS");

// The esbuild entry point resolves `.js` specifiers cleanly, so we bundle the
// compiled CLI (dist/*.js) rather than TS source. Ensure it's built first so a
// standalone `pnpm --filter @uvibe/desktop bundle` works from a clean tree.
if (!existsSync(cliEntry)) {
  console.log("[bundle] apps/cli not built yet — running the workspace build for it…");
  execSync('pnpm --filter "@uvibe/cli..." build', { cwd: repoRoot, stdio: "inherit" });
}
if (!existsSync(cliEntry)) {
  throw new Error(`CLI entry still missing after build: ${cliEntry}`);
}

mkdirSync(resourcesDir, { recursive: true });

// esbuild emits a CJS bundle. Two wrinkles handled here:
//  1. dist/index.js only *exports* main() — it doesn't run it. We feed a tiny
//     stdin entry that imports and invokes main(argv).
//  2. The CLI uses `import.meta.url` (mcpConfig/installUnityPackage path walking).
//     import.meta isn't available in CJS, so we define it to a real file URL of
//     the emitted bundle via the banner. Those path walks are dev-only fallbacks
//     (the app passes explicit --source / writes its own mcp config), so pointing
//     them at uvibe.cjs is harmless.
await build({
  stdin: {
    contents: `import { main } from ${JSON.stringify(cliEntry)};\nmain(process.argv.slice(2));\n`,
    resolveDir: cliDir,
    loader: "js",
    sourcefile: "uvibe-entry.js",
  },
  bundle: true,
  platform: "node",
  target: "node20",
  format: "cjs",
  outfile: outFile,
  banner: {
    js: "const __import_meta_url = require('url').pathToFileURL(__filename).href;",
  },
  define: { "import.meta.url": "__import_meta_url" },
  logLevel: "info",
});

const kb = Math.round(statSync(outFile).size / 1024);
console.log(`[bundle] wrote ${path.relative(repoRoot, outFile)} (${kb} KB)`);

// Copy the Unity package verbatim (it's ~0.5 MB). onboarding installs it into
// the employee's project with `uvibe install-unity-package --source <this>`.
if (!existsSync(path.join(unitySrc, "package.json"))) {
  throw new Error(`Unity package source missing: ${unitySrc}`);
}
rmSync(unityDest, { recursive: true, force: true });
cpSync(unitySrc, unityDest, { recursive: true });
console.log(`[bundle] copied ${path.relative(repoRoot, unityDest)}`);
