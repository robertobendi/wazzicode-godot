import { existsSync, promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveProjectPath } from "@gvibe/safety";
import type { CommandResult, GlobalOptions, ParsedArgs } from "../options.js";

export const ADDON_PLUGIN_PATH = "res://addons/godot_vibe_os/plugin.cfg";
export const RUNTIME_PROBE_AUTOLOAD_NAME = "FoundryRuntimeProbe";
export const RUNTIME_PROBE_AUTOLOAD_PATH = "res://addons/godot_vibe_os/runtime_probe.gd";

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
  if (!source || !existsSync(path.join(source, "plugin.cfg")) || !existsSync(path.join(source, "runtime_probe.gd"))) {
    return { exitCode: 2, stderr: "Could not locate a complete godot/addons/godot_vibe_os addon with plugin.cfg and runtime_probe.gd. Pass --source=<addon-directory>.\n" };
  }
  const before = await fs.readFile(projectFile, "utf8");
  let after: string;
  try {
    after = enableRuntimeProbeAutoload(enableAddonInProjectFile(before, ADDON_PLUGIN_PATH));
  } catch (error) {
    return { exitCode: 2, stderr: `${error instanceof Error ? error.message : String(error)}\n` };
  }
  await fs.mkdir(path.dirname(destination), { recursive: true });
  await fs.cp(source, destination, { recursive: true, force: true });
  if (after !== before) await fs.writeFile(projectFile, after, "utf8");
  const result = { source, destination, enabled: true, runtimeProbeConfigured: true, projectFileChanged: after !== before };
  return options.json ? { exitCode: 0, stdout: JSON.stringify(result, null, 2) + "\n" } : { exitCode: 0, stdout: `Installed Godot Vibe OS addon at ${destination}\nEnabled ${ADDON_PLUGIN_PATH} and ${RUNTIME_PROBE_AUTOLOAD_NAME} in project.godot\nOpen or restart the project in Godot to start the bridge.\n` };
}

export function enableRuntimeProbeAutoload(contents: string): string {
  const expected = `*${RUNTIME_PROBE_AUTOLOAD_PATH}`;
  const section = namedSection(contents, "autoload");
  if (!section) return contents.replace(/\s*$/, "\n\n") + `[autoload]\n\n${RUNTIME_PROBE_AUTOLOAD_NAME}=${JSON.stringify(expected)}\n`;
  const body = contents.slice(section.start, section.end);
  const assignment = new RegExp(`^[ \\t]*${RUNTIME_PROBE_AUTOLOAD_NAME}[ \\t]*=[ \\t]*(.+?)[ \\t]*(?:[;#].*)?\\r?$`, "m").exec(body);
  if (assignment) {
    let configured: unknown;
    try { configured = JSON.parse(assignment[1]); } catch { configured = null; }
    if (configured === expected) return contents;
    throw new Error(`${RUNTIME_PROBE_AUTOLOAD_NAME} already exists in project.godot with a different value; refusing to replace it.`);
  }
  return contents.slice(0, section.start) + `${RUNTIME_PROBE_AUTOLOAD_NAME}=${JSON.stringify(expected)}\n` + contents.slice(section.start);
}

export function isRuntimeProbeAutoloadConfigured(contents: string): boolean {
  const section = namedSection(contents, "autoload");
  if (!section) return false;
  const body = contents.slice(section.start, section.end);
  const assignment = new RegExp(`^[ \\t]*${RUNTIME_PROBE_AUTOLOAD_NAME}[ \\t]*=[ \\t]*(.+?)[ \\t]*(?:[;#].*)?\\r?$`, "m").exec(body);
  if (!assignment) return false;
  try { return JSON.parse(assignment[1]) === `*${RUNTIME_PROBE_AUTOLOAD_PATH}`; } catch { return false; }
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
  return namedSection(contents, "editor_plugins");
}

function namedSection(contents: string, name: string): { start: number; end: number } | null {
  const section = new RegExp(`^[ \\t]*\\[${name}\\][ \\t]*(?:[;#].*)?\\r?$`, "m").exec(contents);
  if (!section) return null;
  let start = section.index + section[0].length;
  if (contents[start] === "\n") start += 1;
  const next = /^[ \t]*\[[^\]\r\n]+\][ \t]*(?:[;#].*)?\r?$/gm;
  next.lastIndex = start;
  const nextSection = next.exec(contents);
  return { start, end: nextSection?.index ?? contents.length };
}

function locateAddonSource(): string | null { let dir = path.dirname(fileURLToPath(import.meta.url)); for (let i = 0; i < 12; i++) { const candidate = path.join(dir, "godot", "addons", "godot_vibe_os"); if (existsSync(path.join(candidate, "plugin.cfg"))) return candidate; const parent = path.dirname(dir); if (parent === dir) break; dir = parent; } return null; }
