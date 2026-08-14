import { promises as fs } from "node:fs";
import path from "node:path";
import { resolveProjectPath, writeConfigIfMissing } from "@gvibe/safety";
import { DEFAULT_CONVENTIONS_MD } from "@gvibe/project-brain";
import type { CommandResult, GlobalOptions } from "../options.js";

const BEGIN = "<!-- BEGIN godot-vibe-os -->";
const END = "<!-- END godot-vibe-os -->";
const GITIGNORE_ENTRIES = [
  ".godot/",
  ".godot-vibe/action_log.jsonl",
  ".godot-vibe/brain/",
  ".godot-vibe/brain.lock*/",
  ".godot-vibe/write.lock*/",
  ".godot-vibe/inbox/",
  ".godot-vibe/loop/",
  ".godot-vibe/snapshots/",
  ".godot-vibe/studio/",
];

export async function runInit(options: GlobalOptions): Promise<CommandResult> {
  let projectFile: string;
  let conventions: string;
  let agents: string;
  let claude: string;
  let gitignore: string;
  try {
    [projectFile, conventions, agents, claude, gitignore] = await Promise.all([
      resolveProjectPath(options.project, "project.godot").then(({ absolute }) => absolute),
      resolveProjectPath(options.project, ".godot-vibe/conventions.md").then(({ absolute }) => absolute),
      resolveProjectPath(options.project, "AGENTS.md").then(({ absolute }) => absolute),
      resolveProjectPath(options.project, "CLAUDE.md").then(({ absolute }) => absolute),
      resolveProjectPath(options.project, ".gitignore").then(({ absolute }) => absolute),
    ]);
    await resolveProjectPath(options.project, ".godot-vibe/config.json");
  } catch (error) {
    return { exitCode: 2, stderr: `Refusing to initialize ${options.project}: ${errorMessage(error)}\n` };
  }
  if (!(await exists(projectFile))) return { exitCode: 2, stderr: `Not a Godot project: ${projectFile} is missing.\n` };
  const actions: string[] = [];
  const config = await writeConfigIfMissing(options.project);
  actions.push(`${config.written ? "wrote" : "kept"} ${config.path}`);
  if (!(await exists(conventions))) { await fs.mkdir(path.dirname(conventions), { recursive: true }); await fs.writeFile(conventions, DEFAULT_CONVENTIONS_MD, "utf8"); actions.push(`wrote ${conventions}`); }
  for (const file of [agents, claude]) {
    actions.push(`${await upsert(file, agentBlock())} ${file}`);
  }
  actions.push(`${await upsertGitignore(gitignore)} ${gitignore}`);
  return options.json ? { exitCode: 0, stdout: JSON.stringify({ project: options.project, actions }, null, 2) + "\n" } : { exitCode: 0, stdout: ["Godot Vibe OS — init", ...actions].join("\n") + "\n" };
}

function agentBlock(): string { return [BEGIN, "## Godot Vibe OS", "", "Use the `godot_*` MCP tools for live editor state. Do not guess NodePaths or Godot APIs, and do not hand-edit `.tscn`/`.tres` when a dedicated editor tool exists.", "", "- Start with `godot_orient({ task: \"<current request>\" })`.", "- Resolve ‘this’ or ‘selected’ with `godot_inspect_selected`.", "- Verify unfamiliar engine APIs with `godot_reflect` before writing code.", "- Read scripts first and pass their sha256 to `godot_apply_text_edits`.", "- After text changes, run `godot_refresh_filesystem`, then `godot_verify`. Import/syntax checks are not unit tests; run `godot_test_run` when the project has a test runner.", "- For runtime bugs, use `godot_debug_run`; it only stops play sessions it starts and a clean verdict covers only its bounded observation window.", "- Scene writes use editor UndoRedo; file writes are snapshotted and action-logged under `.godot-vibe/`.", "", "Diagnose setup with `gvibe doctor --project=.`.", END].join("\n"); }
async function upsert(file: string, block: string): Promise<"created" | "updated" | "appended"> { let current = ""; try { current = await fs.readFile(file, "utf8"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; await fs.writeFile(file, block + "\n", "utf8"); return "created"; } const start = current.indexOf(BEGIN); const end = current.indexOf(END); if (start >= 0 && end >= start) { await fs.writeFile(file, current.slice(0, start) + block + current.slice(end + END.length), "utf8"); return "updated"; } await fs.writeFile(file, current.replace(/\s*$/, "\n\n") + block + "\n", "utf8"); return "appended"; }
async function upsertGitignore(file: string): Promise<"created" | "updated" | "kept"> {
  let current = "";
  try { current = await fs.readFile(file, "utf8"); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const present = new Set(current.split(/\r?\n/).map((line) => line.trim()));
  const missing = GITIGNORE_ENTRIES.filter((entry) => !present.has(entry));
  if (missing.length === 0) return "kept";
  const prefix = current.length === 0 ? "" : current.endsWith("\n") ? current : `${current}\n`;
  const heading = current.includes("Godot Vibe OS generated state") ? "" : `${prefix.length ? "\n" : ""}# Godot Vibe OS generated state\n`;
  await fs.writeFile(file, `${prefix}${heading}${missing.join("\n")}\n`, "utf8");
  return current.length === 0 ? "created" : "updated";
}
async function exists(file: string): Promise<boolean> { return fs.access(file).then(() => true, () => false); }
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }
