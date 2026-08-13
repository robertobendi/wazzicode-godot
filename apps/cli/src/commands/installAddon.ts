import { existsSync, promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveProjectPath } from "@gvibe/safety";
import type { CommandResult, GlobalOptions, ParsedArgs } from "../options.js";

export const ADDON_PLUGIN_PATH = "res://addons/godot_vibe_os/plugin.cfg";

export async function runInstallAddon(options: GlobalOptions, parsed: ParsedArgs): Promise<CommandResult> {
  let projectFile: string;
  let destination: string;
  try {
    [projectFile, destination] = await Promise.all([
      resolveProjectPath(options.project, "project.godot").then(({ absolute }) => absolute),
      resolveProjectPath(options.project, "addons/godot_vibe_os").then(({ absolute }) => absolute),
    ]);
  } catch (error) {
    return { exitCode: 2, stderr: `Refusing to install the addon: ${error instanceof Error ? error.message : String(error)}\n` };
  }
  if (!existsSync(projectFile)) return { exitCode: 2, stderr: `Not a Godot project: ${projectFile} is missing.\n` };
  const source = typeof parsed.flags.source === "string" ? path.resolve(parsed.flags.source) : locateAddonSource();
  if (!source || !existsSync(path.join(source, "plugin.cfg"))) return { exitCode: 2, stderr: "Could not locate godot/addons/godot_vibe_os. Pass --source=<addon-directory>.\n" };
  await fs.mkdir(path.dirname(destination), { recursive: true });
  await fs.cp(source, destination, { recursive: true, force: true });
  const before = await fs.readFile(projectFile, "utf8");
  const after = enableAddonInProjectFile(before, ADDON_PLUGIN_PATH);
  if (after !== before) await fs.writeFile(projectFile, after, "utf8");
  const result = { source, destination, enabled: true, projectFileChanged: after !== before };
  return options.json ? { exitCode: 0, stdout: JSON.stringify(result, null, 2) + "\n" } : { exitCode: 0, stdout: `Installed Godot Vibe OS addon at ${destination}\nEnabled ${ADDON_PLUGIN_PATH} in project.godot\nOpen or restart the project in Godot to start the bridge.\n` };
}

export function enableAddonInProjectFile(contents: string, pluginPath: string): string {
  if (isAddonEnabledInProjectFile(contents, pluginPath)) return contents;
  const entry = `enabled=PackedStringArray(\"${pluginPath}\")`;
  const section = editorPluginsSection(contents);
  if (!section) return contents.replace(/\s*$/, "\n\n") + `[editor_plugins]\n\n${entry}\n`;
  const body = contents.slice(section.start, section.end);
  const enabled = /^[ \t]*(enabled[ \t]*=[ \t]*PackedStringArray[ \t]*\(([^)\r\n]*)\))[ \t]*(?:[;#].*)?\r?$/m.exec(body);
  if (!enabled) return contents.slice(0, section.start) + entry + "\n" + contents.slice(section.start);
  const args = enabled[2].trim();
  const replacement = `enabled=PackedStringArray(${args ? `${args}, ` : ""}${JSON.stringify(pluginPath)})`;
  const assignmentOffset = enabled[0].indexOf(enabled[1]);
  const absoluteStart = section.start + (enabled.index ?? 0) + assignmentOffset;
  return contents.slice(0, absoluteStart) + replacement + contents.slice(absoluteStart + enabled[1].length);
}

export function isAddonEnabledInProjectFile(contents: string, pluginPath: string): boolean {
  const section = editorPluginsSection(contents);
  if (!section) return false;
  const body = contents.slice(section.start, section.end);
  const enabled = /^[ \t]*enabled[ \t]*=[ \t]*PackedStringArray[ \t]*\(([^)\r\n]*)\)[ \t]*(?:[;#].*)?\r?$/m.exec(body);
  if (!enabled) return false;
  const values: string[] = [];
  for (const match of enabled[1].matchAll(/"(?:\\.|[^"\\])*"/g)) {
    try { values.push(JSON.parse(match[0]) as string); } catch { /* invalid strings are not enabled plugins */ }
  }
  return values.includes(pluginPath);
}

function editorPluginsSection(contents: string): { start: number; end: number } | null {
  const section = /^[ \t]*\[editor_plugins\][ \t]*(?:[;#].*)?\r?$/m.exec(contents);
  if (!section) return null;
  let start = section.index + section[0].length;
  if (contents[start] === "\n") start += 1;
  const next = /^[ \t]*\[[^\]\r\n]+\][ \t]*(?:[;#].*)?\r?$/gm;
  next.lastIndex = start;
  const nextSection = next.exec(contents);
  return { start, end: nextSection?.index ?? contents.length };
}

function locateAddonSource(): string | null { let dir = path.dirname(fileURLToPath(import.meta.url)); for (let i = 0; i < 12; i++) { const candidate = path.join(dir, "godot", "addons", "godot_vibe_os"); if (existsSync(path.join(candidate, "plugin.cfg"))) return candidate; const parent = path.dirname(dir); if (parent === dir) break; dir = parent; } return null; }
