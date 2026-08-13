import { promises as fs } from "node:fs";
import path from "node:path";
import { CommandResult, GlobalOptions, ParsedArgs } from "../options.js";
import { runInit } from "./init.js";
import { runBrain } from "./brain.js";
import { runDoctor } from "./doctor.js";
import { runMcpConfig } from "./mcpConfig.js";
import { runInstallUnityPackage } from "./installUnityPackage.js";

export async function runSetup(g: GlobalOptions, parsed: ParsedArgs): Promise<CommandResult> {
  const project = path.resolve(g.project);
  const lines: string[] = [];
  const log = (s: string) => lines.push(s);

  log(`Unity Vibe OS — setup`);
  log(`project: ${project}`);
  log("");

  if (!(await isUnityProject(project))) {
    return {
      exitCode: 1,
      stderr: `Not a Unity project at ${project}. Pass --project=<unity-dir> or run from inside a Unity project (must contain Assets/, Packages/, ProjectSettings/).\n`,
    };
  }

  const skipUnityInstall = parsed.flags["skip-unity-install"] === true;
  // Default to embedding a portable copy so the package resolves on every machine that clones the
  // project (an absolute manifest `file:` path only works on the installer's machine).
  const installMode = (typeof parsed.flags["unity-install-mode"] === "string"
    ? parsed.flags["unity-install-mode"]
    : "copy") as "manifest" | "symlink" | "copy";

  // Step 1: init scaffold
  log("[1/5] init  — .unity-vibe/config.json + conventions.md + CLAUDE.md + AGENTS.md");
  const initRes = await runInit(g);
  if (initRes.exitCode !== 0) return passthrough(initRes, lines);
  pushIndented(lines, initRes.stdout);

  // Step 2: install Unity package (manifest entry by default)
  if (!skipUnityInstall) {
    log("");
    log("[2/5] install-unity-package  — embed portable copy under Packages/");
    const ipRes = await runInstallUnityPackage(g, {
      command: "install-unity-package",
      positional: [],
      flags: { mode: installMode },
    });
    if (ipRes.exitCode !== 0) {
      pushIndented(lines, ipRes.stderr ?? "");
      return { exitCode: ipRes.exitCode, stdout: lines.join("\n") + "\n", stderr: ipRes.stderr };
    }
    pushIndented(lines, ipRes.stdout);
  } else {
    log("");
    log("[2/5] install-unity-package  — skipped (--skip-unity-install)");
  }

  // Step 3: project brain
  log("");
  log("[3/5] brain  — complete source-backed map under .unity-vibe/knowledge/");
  const brainRes = await runBrain(g);
  if (brainRes.exitCode !== 0) return passthrough(brainRes, lines);
  pushIndented(lines, brainRes.stdout);

  // Step 4: write .mcp.json (per-project; auto-discovered by Claude Code)
  log("");
  log("[4/5] mcp-config --write  — .mcp.json (Claude Code auto-discovers)");
  const mcpRes = await runMcpConfig(g, {
    command: "mcp-config",
    positional: [],
    flags: { write: true },
  });
  if (mcpRes.exitCode !== 0) return passthrough(mcpRes, lines);
  pushIndented(lines, mcpRes.stdout);

  // Step 5: doctor
  log("");
  log("[5/5] doctor");
  const doctorRes = await runDoctor(g);
  pushIndented(lines, doctorRes.stdout);

  log("");
  log("✅ Unity Vibe OS setup complete.");
  log("");
  log("Next steps:");
  log("  1. Open the Unity project in Unity Editor — the bridge auto-starts on 127.0.0.1:38578.");
  log(`  2. cd ${project}  — Claude Code reads .mcp.json from the project root.`);
  log("  3. Restart Claude Code in this directory and approve the unity-vibe-os server when prompted.");
  log("  4. Verify with:  claude mcp list   (or run `uvibe doctor` again).");
  log("");
  log("Using the Codex CLI instead of Claude Code?");
  log("  Codex reads TOML, not .mcp.json:  uvibe mcp-config --target=codex");
  log("  (it prints the `codex mcp add` one-liner that registers the server for you).");

  return { exitCode: 0, stdout: lines.join("\n") + "\n" };
}

async function isUnityProject(p: string): Promise<boolean> {
  for (const sub of ["Assets", "Packages", "ProjectSettings"]) {
    try {
      const s = await fs.stat(path.join(p, sub));
      if (!s.isDirectory()) return false;
    } catch {
      return false;
    }
  }
  return true;
}

function pushIndented(buf: string[], s?: string): void {
  if (!s) return;
  for (const line of s.split("\n")) {
    if (line.length === 0) continue;
    buf.push("    " + line);
  }
}

function passthrough(r: CommandResult, lines: string[]): CommandResult {
  pushIndented(lines, r.stdout ?? r.stderr ?? "");
  return { exitCode: r.exitCode, stdout: lines.join("\n") + "\n", stderr: r.stderr };
}
