#!/usr/bin/env node
// Unity Vibe OS bootstrap.
//
// Usage:
//   node /path/to/wazzicode-unity/bootstrap.mjs <unity-project-path>
//   node /path/to/wazzicode-unity/bootstrap.mjs            # auto-detect Unity project from cwd
//
// Flags:
//   --rebuild                  Force a rebuild of the TypeScript packages.
//   --build-only               Recompile only: skip install, force rebuild (use after a `git pull` that only changed TS source).
//   --skip-install             Skip the dependency install step (use existing node_modules).
//   --skip-build               Skip the TypeScript build (use existing dist/).
//   --skip-unity-install       Skip installing the package into the Unity project.
//   --unity-install-mode=...   copy | manifest | symlink (default: copy — embeds a portable copy).
//
// What it does:
//   1) Detects the Unity project (or uses the path you pass).
//   2) Installs Node deps (pnpm if available, else npm).
//   3) Builds the TypeScript packages in topological order.
//   4) Calls `uvibe setup` against the Unity project, which:
//        a) writes .unity-vibe/{config.json, conventions.md, project_brain.{md,json}, claude_context.md}
//        b) embeds com.uvibe.os under the project's Packages/ (portable; auto-discovered)
//        c) writes .mcp.json at the Unity project root (Claude Code auto-discovers)
//        d) updates CLAUDE.md and AGENTS.md with usage rules (marker-delimited; preserves your content)
//        e) runs `uvibe doctor`
//
// Idempotent. Safe to re-run.

import { existsSync, readFileSync, statSync, readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));

function parseArgs(argv) {
  const flags = {};
  const positional = [];
  for (const a of argv) {
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      if (eq >= 0) flags[a.substring(2, eq)] = a.substring(eq + 1);
      else flags[a.substring(2)] = true;
    } else {
      positional.push(a);
    }
  }
  return { flags, positional };
}

function step(n, total, msg) {
  console.log(`\n[${n}/${total}] ${msg}`);
}

function info(msg) {
  console.log(`    ${msg}`);
}

function fail(msg) {
  console.error(`\n❌ ${msg}`);
  process.exit(1);
}

function which(cmd) {
  const probe = process.platform === "win32" ? "where" : "which";
  const r = spawnSync(probe, [cmd], { encoding: "utf8" });
  if (r.status !== 0) return null;
  const first = (r.stdout ?? "").split(/\r?\n/).find((l) => l.trim().length > 0);
  return first ? first.trim() : null;
}

function run(cmd, args, opts = {}) {
  info(`$ ${cmd} ${args.join(" ")}`);
  const r = spawnSync(cmd, args, {
    stdio: "inherit",
    cwd: opts.cwd ?? HERE,
    env: process.env,
    // .cmd/.bat shims (pnpm, corepack) can't be spawned directly on Windows —
    // spawnSync returns status:null. A shell lets cmd.exe resolve them via PATHEXT.
    shell: opts.shell ?? false,
  });
  if (r.error) fail(`Command failed: ${cmd} ${args.join(" ")} — ${r.error.message}`);
  if (r.status !== 0) {
    fail(`Command failed: ${cmd} ${args.join(" ")} (exit ${r.status})`);
  }
}

// Pinned package manager from package.json (e.g. "pnpm@10.29.1"), so corepack
// drives the exact pnpm this repo expects.
function readPinnedPnpm() {
  try {
    const pkg = JSON.parse(readFileSync(path.join(HERE, "package.json"), "utf8"));
    if (typeof pkg.packageManager === "string" && pkg.packageManager.startsWith("pnpm@")) {
      return pkg.packageManager;
    }
  } catch {
    /* fall through */
  }
  return "pnpm";
}

// Newest mtime under a directory, ignoring node_modules/ and dist/.
function newestMtime(dir) {
  let newest = 0;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return newest;
  }
  for (const e of entries) {
    if (e.isDirectory()) {
      if (e.name === "node_modules" || e.name === "dist") continue;
      newest = Math.max(newest, newestMtime(path.join(dir, e.name)));
    } else {
      try {
        newest = Math.max(newest, statSync(path.join(dir, e.name)).mtimeMs);
      } catch {
        /* ignore */
      }
    }
  }
  return newest;
}

// True when any package's src/ is newer than the built CLI entry — i.e. dist/ is
// stale (e.g. after a `git pull` that changed TS source).
function distIsStale(distFile) {
  let distM;
  try {
    distM = statSync(distFile).mtimeMs;
  } catch {
    return true;
  }
  let srcM = 0;
  for (const pkg of PACKAGES_BUILD_ORDER) {
    srcM = Math.max(srcM, newestMtime(path.join(HERE, pkg, "src")));
  }
  return srcM > distM;
}

function isUnityProject(p) {
  for (const sub of ["Assets", "Packages", "ProjectSettings"]) {
    try {
      const s = statSync(path.join(p, sub));
      if (!s.isDirectory()) return false;
    } catch {
      return false;
    }
  }
  return true;
}

function findUnityProject(start) {
  let dir = path.resolve(start);
  for (let i = 0; i < 20; i++) {
    if (isUnityProject(dir)) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
  return null;
}

const PACKAGES_BUILD_ORDER = [
  "packages/core",
  "packages/safety",
  "packages/project-brain",
  "packages/mcp-server",
  "apps/cli",
];

async function main() {
  const { flags, positional } = parseArgs(process.argv.slice(2));

  // --build-only: recompile without touching node_modules (handy after a pull
  // that only changed TS source). Implemented as skip-install + force rebuild.
  if (flags["build-only"]) {
    flags["skip-install"] = true;
    flags.rebuild = true;
  }

  let project = positional[0] ?? process.env.UVIBE_PROJECT ?? null;
  if (project) {
    project = path.resolve(project);
    if (!isUnityProject(project)) {
      fail(`Path is not a Unity project: ${project}\n   (it must contain Assets/, Packages/, ProjectSettings/)`);
    }
  } else {
    project = findUnityProject(process.cwd());
    if (!project) {
      fail(
        `No Unity project found from ${process.cwd()} upward.\n` +
          `Pass it explicitly:  node ${path.relative(process.cwd(), path.join(HERE, "bootstrap.mjs"))} /path/to/UnityProject`
      );
    }
    console.log(`Auto-detected Unity project: ${project}`);
  }

  const total = 4;

  // Step 1: install deps
  step(1, total, "Installing Node dependencies");
  if (flags["skip-install"]) {
    info("--skip-install set; skipping");
  } else if (existsSync(path.join(HERE, "node_modules")) && !flags.rebuild) {
    info(`node_modules exists at ${path.join(HERE, "node_modules")} — skipping (use --rebuild to force)`);
  } else {
    // This is a pnpm workspace: package.json pins pnpm and deps use `workspace:*`,
    // which npm cannot resolve (EUNSUPPORTEDPROTOCOL). So npm is never a valid
    // fallback. Prefer a real pnpm on PATH; otherwise drive the pinned pnpm via
    // corepack (ships with Node ≥16). Use a shell so Windows .cmd shims resolve.
    const winShell = process.platform === "win32";
    if (which("pnpm")) {
      info("using pnpm");
      run("pnpm", ["install"], { shell: winShell });
    } else if (which("corepack")) {
      const pinned = readPinnedPnpm();
      info(`pnpm not on PATH; using corepack (${pinned})`);
      run("corepack", [pinned, "install"], { shell: winShell });
    } else {
      fail(
        "This is a pnpm workspace and pnpm is not on PATH.\n" +
          "   Enable it once with:  corepack enable pnpm\n" +
          "   (corepack ships with Node ≥16.) Then re-run this bootstrap.\n" +
          "   npm cannot install this repo — it does not understand workspace:* deps."
      );
    }
  }

  // Step 2: build
  step(2, total, "Building TypeScript packages");
  const cliDistEntry = path.join(HERE, "apps", "cli", "dist", "index.js");
  if (flags["skip-build"]) {
    info("--skip-build set; skipping");
    if (!existsSync(cliDistEntry)) fail(`Skipped build but ${cliDistEntry} does not exist. Re-run without --skip-build.`);
  } else if (existsSync(cliDistEntry) && !flags.rebuild && !distIsStale(cliDistEntry)) {
    info(`${path.relative(HERE, cliDistEntry)} is up to date — skipping (use --rebuild to force)`);
  } else {
    if (existsSync(cliDistEntry) && !flags.rebuild) {
      info("TypeScript source is newer than dist/ — rebuilding");
    }
    // Compile each package via the TypeScript compiler's JS entrypoint using the
    // current Node binary. This deliberately avoids spawning node_modules/.bin/
    // tsc.cmd, which spawnSync cannot execute on Windows without a shell (it
    // returns status:null and the build silently "fails").
    const tscJs = path.join(HERE, "node_modules", "typescript", "lib", "tsc.js");
    if (!existsSync(tscJs))
      fail(`TypeScript is not installed (missing ${tscJs}). Re-run without --skip-install.`);
    for (const pkg of PACKAGES_BUILD_ORDER) {
      const cfg = path.join(HERE, pkg, "tsconfig.json");
      info(`building ${pkg}`);
      run(process.execPath, [tscJs, "-p", cfg]);
    }
  }

  // Step 3: bin/uvibe sanity
  step(3, total, "Locating uvibe CLI");
  const uvibeBin = path.join(HERE, "apps", "cli", "bin", "uvibe");
  if (!existsSync(uvibeBin)) fail(`bin/uvibe missing at ${uvibeBin}. Re-run with --rebuild.`);
  info(`found ${uvibeBin}`);

  // Step 4: setup
  step(4, total, `Running uvibe setup against ${project}`);
  run(process.execPath, [uvibeBin, "setup", `--project=${project}`]);

  // Sanity-check the generated .mcp.json so we can give the user concrete next steps.
  const mcpJson = path.join(project, ".mcp.json");
  if (existsSync(mcpJson)) {
    try {
      const cfg = JSON.parse(readFileSync(mcpJson, "utf8"));
      const entry = cfg?.mcpServers?.["unity-vibe-os"];
      if (entry) {
        console.log(`\n.mcp.json sanity check at ${mcpJson}:`);
        console.log(`  command: ${entry.command}`);
        console.log(`  args:    ${(entry.args ?? []).join(" ")}`);
        console.log(`  env:     ${JSON.stringify(entry.env ?? {})}`);
      }
    } catch {
      console.warn(`Warning: .mcp.json exists at ${mcpJson} but failed to parse.`);
    }
  }

  console.log(`
✅ Unity Vibe OS bootstrap complete.

Next steps:
  1. Open the Unity project in Unity Editor:  ${project}
     (the bridge auto-starts at 127.0.0.1:38578)
  2. Restart Claude Code in the project directory:
       cd "${project}"
       claude
     Claude Code reads .mcp.json from the project root and will prompt you to
     approve the unity-vibe-os MCP server.
  3. Verify:  claude mcp list
     or:      node "${uvibeBin}" doctor --project="${project}"

Tip: Claude (the assistant) now has everything it needs in CLAUDE.md and
.unity-vibe/claude_context.md. Just open Claude Code in the project and ask
"what is selected in Unity?" or "show me the game view".
`);
}

main().catch((e) => {
  console.error(`\n❌ ${e?.stack ?? e?.message ?? String(e)}`);
  process.exit(1);
});
