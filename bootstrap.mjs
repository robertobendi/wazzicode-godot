#!/usr/bin/env node
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.dirname(fileURLToPath(import.meta.url));
const BUILD_ORDER = ["packages/core", "packages/bridge-client", "packages/safety", "packages/project-brain", "packages/mcp-server", "apps/cli"];
const REQUIRED_NODE_MAJOR = 20;

function parse(argv) { const flags = {}; const positional = []; for (const value of argv) { if (!value.startsWith("--")) positional.push(value); else { const split = value.indexOf("="); flags[value.slice(2, split < 0 ? undefined : split)] = split < 0 ? true : value.slice(split + 1); } } return { flags, positional }; }
function fail(message) { console.error(`\nError: ${message}`); process.exit(1); }
// `shell` is opt-in per call: it is needed only for the pnpm/corepack .cmd shims
// on Windows, and applying it everywhere breaks any argument containing a space
// (e.g. a project path under "C:\My Games\").
function command(name, args, options = {}) { console.log(`  $ ${name} ${args.join(" ")}`); const result = run(name, args, options); if (result.error || result.status !== 0) fail(`${name} failed${result.error ? `: ${result.error.message}` : ` with exit ${result.status}`}.`); }
function run(name, args, options = {}) { return spawnSync(name, args, { cwd: options.cwd ?? REPO, stdio: "inherit", shell: options.shell ?? false }); }
function which(name) { const result = spawnSync(process.platform === "win32" ? "where" : "which", [name], { encoding: "utf8" }); if (result.status !== 0) return null; const first = (result.stdout ?? "").split(/\r?\n/).find((line) => line.trim().length > 0); return first ? first.trim() : null; }
function pinnedPnpm() { try { const pkg = JSON.parse(readFileSync(path.join(REPO, "package.json"), "utf8")); if (typeof pkg.packageManager === "string" && pkg.packageManager.startsWith("pnpm@")) return pkg.packageManager; } catch { /* fall through */ } return "pnpm"; }
function isProject(directory) { return existsSync(path.join(directory, "project.godot")); }
function findProject(start) { let directory = path.resolve(start); for (let i = 0; i < 20; i++) { if (isProject(directory)) return directory; const parent = path.dirname(directory); if (parent === directory) break; directory = parent; } return null; }
function newest(directory) { let value = 0; let entries = []; try { entries = readdirSync(directory, { withFileTypes: true }); } catch { return value; } for (const entry of entries) { if (["node_modules", "dist"].includes(entry.name)) continue; const full = path.join(directory, entry.name); value = Math.max(value, entry.isDirectory() ? newest(full) : statSync(full).mtimeMs); } return value; }
function distStale(file) { if (!existsSync(file)) return true; const built = statSync(file).mtimeMs; return BUILD_ORDER.some((directory) => newest(path.join(REPO, directory, "src")) > built); }

// This is a pnpm workspace: deps use `workspace:*`, which npm cannot resolve
// (EUNSUPPORTEDPROTOCOL), so npm is never a fallback. Corepack is used only when
// it happens to be installed — it is unbundled from Node ≥25 and absent from
// several distro/Homebrew builds. Windows needs a shell for the .cmd shims.
function resolvePnpm() {
  if (which("pnpm")) return { name: "pnpm", prefix: [], shell: process.platform === "win32" };
  if (which("corepack")) return { name: "corepack", prefix: [pinnedPnpm()], shell: process.platform === "win32" };
  return fail(
    "This is a pnpm workspace and pnpm is not on PATH.\n" +
      "  Install it with:      npm install -g pnpm     (macOS: brew install pnpm)\n" +
      "  Or, if you have it:   corepack enable pnpm\n" +
      "  Then re-run this bootstrap.\n" +
      "  npm cannot install this repo — it does not understand workspace:* deps."
  );
}

function install(pnpm) {
  console.log(`  $ ${pnpm.name} ${[...pnpm.prefix, "install", "--frozen-lockfile"].join(" ")}`);
  const frozen = run(pnpm.name, [...pnpm.prefix, "install", "--frozen-lockfile"], { shell: pnpm.shell });
  if (!frozen.error && frozen.status === 0) return;
  // A lockfile that lags package.json (common right after a merge) fails the
  // frozen install; a plain install resolves it rather than dead-ending setup.
  console.log("  frozen-lockfile install failed; retrying with a plain install");
  command(pnpm.name, [...pnpm.prefix, "install"], { shell: pnpm.shell });
}

async function main() {
  const nodeMajor = parseInt(process.versions.node, 10);
  if (nodeMajor < REQUIRED_NODE_MAJOR) fail(`Node ${process.versions.node} is too old — this repo needs Node ${REQUIRED_NODE_MAJOR} or newer.`);

  const { flags, positional } = parse(process.argv.slice(2));
  const project = positional[0] ? path.resolve(positional[0]) : findProject(process.cwd());
  if (!project || !isProject(project)) fail(`No Godot project found. Pass a directory containing project.godot.`);
  const needsInstall = !flags["skip-install"] && (!existsSync(path.join(REPO, "node_modules")) || flags.rebuild);
  const cliEntry = path.join(REPO, "apps", "cli", "dist", "index.js");
  const needsBuild = !flags["skip-build"] && (flags.rebuild || distStale(cliEntry));
  const pnpm = needsInstall || needsBuild ? resolvePnpm() : null;
  if (needsInstall) install(pnpm);
  if (needsBuild) command(pnpm.name, [...pnpm.prefix, "--filter", "@gvibe/cli...", "build"], { shell: pnpm.shell });
  if (!existsSync(cliEntry)) fail(`CLI build is missing at ${cliEntry}.`);
  const cli = path.join(REPO, "apps", "cli", "bin", "gvibe");
  command(process.execPath, [cli, "setup", `--project=${project}`]);
  const config = JSON.parse(readFileSync(path.join(project, ".mcp.json"), "utf8"));
  if (!config?.mcpServers?.["godot-vibe-os"]) fail("Setup did not write the godot-vibe-os MCP entry.");
  console.log(`\nGodot Vibe OS setup is complete.\n\n1. Open ${project} in Godot 4.7.1.\n2. Restart your MCP client in that project.\n3. Run: node ${cli} doctor --project=${project}\n`);
}

main().catch((error) => {
  console.error(`\nError: ${error?.message ?? String(error)}`);
  process.exit(1);
});
