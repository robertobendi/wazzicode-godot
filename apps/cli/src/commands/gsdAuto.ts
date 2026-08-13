import { promises as fs } from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { CommandResult, GlobalOptions } from "../options.js";

export interface GsdDetection {
  cliFound: boolean;
  cliPath?: string;
  planningDir: string;
  files: { path: string; exists: boolean }[];
  mode: "cli" | "internal" | "mixed";
  notes: string[];
}

export async function runGsdAuto(g: GlobalOptions): Promise<CommandResult> {
  const detection = await detect(g.project);
  if (g.json) {
    return { exitCode: 0, stdout: JSON.stringify(detection, null, 2) + "\n" };
  }
  const lines: string[] = [];
  lines.push("Unity Vibe OS — gsd-auto");
  lines.push(`mode: ${detection.mode}`);
  lines.push(`gsd CLI: ${detection.cliFound ? `found at ${detection.cliPath}` : "not found"}`);
  lines.push(`planning dir: ${detection.planningDir}`);
  for (const f of detection.files) {
    lines.push(`  ${f.exists ? "✓" : "·"} ${path.relative(g.project, f.path)}`);
  }
  if (detection.notes.length) {
    lines.push("");
    lines.push("notes:");
    for (const n of detection.notes) lines.push(`  • ${n}`);
  }
  return { exitCode: 0, stdout: lines.join("\n") + "\n" };
}

async function detect(projectPath: string): Promise<GsdDetection> {
  const planningDir = path.join(projectPath, ".planning");
  const wantedFiles = [
    "ROADMAP.md",
    "GSD_PLAN.md",
    "GSD_PHASES.md",
    "GSD_STATUS.md",
    "GSD_VERIFY.md",
    "GSD_DECISIONS.md",
  ];
  const files = await Promise.all(
    wantedFiles.map(async (f) => {
      const p = path.join(planningDir, f);
      return { path: p, exists: await fileExists(p) };
    })
  );

  const cli = await whichGsd();
  const notes: string[] = [];
  if (!cli) {
    notes.push("No `gsd` terminal binary found. Unity Vibe OS will mirror the GSD workflow internally via .planning/ files.");
    notes.push("If GSD is only present as Claude slash commands, that is expected. See docs/GSD_AUTOMATION.md.");
  } else {
    notes.push(`Found gsd at ${cli}. Future versions will delegate the loop to gsd directly.`);
  }
  if (files.every((f) => f.exists)) notes.push("All expected planning files are present.");
  else notes.push("Some planning files are missing. The internal workflow keeps them up-to-date.");

  const mode: GsdDetection["mode"] = cli ? "cli" : "internal";
  return { cliFound: Boolean(cli), cliPath: cli, planningDir, files, mode, notes };
}

function whichGsd(): Promise<string | undefined> {
  const cmd = process.platform === "win32" ? "where" : "which";
  return new Promise((resolve) => {
    execFile(cmd, ["gsd"], { encoding: "utf8" }, (e, stdout) => {
      if (e) return resolve(undefined);
      const first = stdout.split(/\r?\n/).find((l) => l.trim().length > 0);
      resolve(first?.trim());
    });
  });
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}
