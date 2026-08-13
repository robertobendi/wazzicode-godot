#!/usr/bin/env node
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.dirname(fileURLToPath(import.meta.url));
const BUILD_ORDER = ["packages/core", "packages/bridge-client", "packages/safety", "packages/project-brain", "packages/mcp-server", "apps/cli"];

function parse(argv) { const flags = {}; const positional = []; for (const value of argv) { if (!value.startsWith("--")) positional.push(value); else { const split = value.indexOf("="); flags[value.slice(2, split < 0 ? undefined : split)] = split < 0 ? true : value.slice(split + 1); } } return { flags, positional }; }
function fail(message) { console.error(`\nError: ${message}`); process.exit(1); }
function command(name, args, cwd = REPO) { console.log(`  $ ${name} ${args.join(" ")}`); const result = spawnSync(name, args, { cwd, stdio: "inherit", shell: process.platform === "win32" }); if (result.error || result.status !== 0) fail(`${name} failed${result.error ? `: ${result.error.message}` : ` with exit ${result.status}`}.`); }
function isProject(directory) { return existsSync(path.join(directory, "project.godot")); }
function findProject(start) { let directory = path.resolve(start); for (let i = 0; i < 20; i++) { if (isProject(directory)) return directory; const parent = path.dirname(directory); if (parent === directory) break; directory = parent; } return null; }
function newest(directory) { let value = 0; let entries = []; try { entries = readdirSync(directory, { withFileTypes: true }); } catch { return value; } for (const entry of entries) { if (["node_modules", "dist"].includes(entry.name)) continue; const full = path.join(directory, entry.name); value = Math.max(value, entry.isDirectory() ? newest(full) : statSync(full).mtimeMs); } return value; }
function distStale(file) { if (!existsSync(file)) return true; const built = statSync(file).mtimeMs; return BUILD_ORDER.some((directory) => newest(path.join(REPO, directory, "src")) > built); }

const { flags, positional } = parse(process.argv.slice(2));
const project = positional[0] ? path.resolve(positional[0]) : findProject(process.cwd());
if (!project || !isProject(project)) fail(`No Godot project found. Pass a directory containing project.godot.`);
if (!flags["skip-install"] && (!existsSync(path.join(REPO, "node_modules")) || flags.rebuild)) command("pnpm", ["install", "--frozen-lockfile"]);
const cliEntry = path.join(REPO, "apps", "cli", "dist", "index.js");
if (!flags["skip-build"] && (flags.rebuild || distStale(cliEntry))) command("pnpm", ["--filter", "@gvibe/cli...", "build"]);
if (!existsSync(cliEntry)) fail(`CLI build is missing at ${cliEntry}.`);
const cli = path.join(REPO, "apps", "cli", "bin", "gvibe");
command(process.execPath, [cli, "setup", `--project=${project}`]);
const config = JSON.parse(readFileSync(path.join(project, ".mcp.json"), "utf8"));
if (!config?.mcpServers?.["godot-vibe-os"]) fail("Setup did not write the godot-vibe-os MCP entry.");
console.log(`\nGodot Vibe OS setup is complete.\n\n1. Open ${project} in Godot 4.7.1.\n2. Restart your MCP client in that project.\n3. Run: node ${cli} doctor --project=${project}\n`);
