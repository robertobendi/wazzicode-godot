import { promises as fs } from "node:fs";
import path from "node:path";
import { resolveProjectPath } from "@gvibe/safety";

export interface GodotAutoload {
  name: string;
  path: string;
  singleton: boolean;
}

export interface GodotProjectDetection {
  isGodotProject: boolean;
  projectPath: string;
  configVersion?: number;
  projectName?: string;
  mainScene?: string;
  features: string[];
  renderer?: string;
  viewport?: { width?: number; height?: number };
  autoloads: GodotAutoload[];
  inputActions: string[];
  usesDotnet: boolean;
}

export interface ParsedGodotProjectSettings {
  configVersion?: number;
  sections: Map<string, Map<string, string>>;
}

export async function detectGodotProject(projectPath: string): Promise<GodotProjectDetection> {
  const result: GodotProjectDetection = {
    isGodotProject: false,
    projectPath,
    features: [],
    autoloads: [],
    inputActions: [],
    usesDotnet: false,
  };
  let text: string;
  try {
    const file = (await resolveProjectPath(projectPath, "project.godot")).absolute;
    text = await fs.readFile(file, "utf8");
  } catch {
    return result;
  }

  const parsed = parseGodotProjectSettings(text);
  result.isGodotProject = true;
  result.configVersion = parsed.configVersion;
  const application = parsed.sections.get("application");
  const rendering = parsed.sections.get("rendering");
  const display = parsed.sections.get("display");
  result.projectName = decodeGodotString(application?.get("config/name"));
  result.mainScene = decodeGodotString(application?.get("run/main_scene"));
  result.features = parsePackedStringArray(application?.get("config/features"));
  result.renderer = decodeGodotString(rendering?.get("renderer/rendering_method"))
    ?? decodeGodotString(rendering?.get("renderer/rendering_method.mobile"));
  result.viewport = compactDimensions(
    parseGodotNumber(display?.get("window/size/viewport_width")),
    parseGodotNumber(display?.get("window/size/viewport_height")),
  );

  for (const [name, raw] of parsed.sections.get("autoload") ?? []) {
    const decoded = decodeGodotString(raw);
    if (!decoded) continue;
    result.autoloads.push({
      name,
      path: decoded.startsWith("*") ? decoded.slice(1) : decoded,
      singleton: decoded.startsWith("*"),
    });
  }
  result.autoloads.sort((a, b) => a.name.localeCompare(b.name));
  result.inputActions = [...(parsed.sections.get("input")?.keys() ?? [])].sort();
  result.usesDotnet = result.features.some((feature) => /\bc#\b|mono|dotnet/i.test(feature))
    || await hasFileWithExtension(projectPath, ".csproj");
  return result;
}

export function parseGodotProjectSettings(text: string): ParsedGodotProjectSettings {
  const sections = new Map<string, Map<string, string>>();
  let current = "";
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith(";") || line.startsWith("#")) continue;
    const section = /^\[([^\]]+)\]$/.exec(line);
    if (section) {
      current = section[1].trim();
      if (!sections.has(current)) sections.set(current, new Map());
      continue;
    }
    const assignment = /^([^=]+?)\s*=\s*(.*)$/.exec(line);
    if (!assignment) continue;
    const key = assignment[1].trim();
    if (!current && key === "config_version") continue;
    const values = sections.get(current) ?? new Map<string, string>();
    values.set(key, assignment[2].trim());
    sections.set(current, values);
  }
  const versionMatch = /^\s*config_version\s*=\s*(\d+)\s*$/m.exec(text);
  return {
    configVersion: versionMatch ? Number(versionMatch[1]) : undefined,
    sections,
  };
}

export function decodeGodotString(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const value = raw.trim();
  if (!(value.startsWith('"') && value.endsWith('"'))) return value || undefined;
  try {
    return JSON.parse(value) as string;
  } catch {
    return value.slice(1, -1)
      .replace(/\\"/g, '"')
      .replace(/\\n/g, "\n")
      .replace(/\\\\/g, "\\");
  }
}

function parsePackedStringArray(raw: string | undefined): string[] {
  if (!raw) return [];
  const values: string[] = [];
  const re = /"((?:\\.|[^"\\])*)"/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(raw)) !== null) {
    try {
      values.push(JSON.parse(`"${match[1]}"`) as string);
    } catch {
      values.push(match[1]);
    }
  }
  return values;
}

function parseGodotNumber(raw: string | undefined): number | undefined {
  if (!raw) return undefined;
  const value = Number(raw);
  return Number.isFinite(value) ? value : undefined;
}

function compactDimensions(
  width: number | undefined,
  height: number | undefined,
): GodotProjectDetection["viewport"] {
  return width === undefined && height === undefined ? undefined : { width, height };
}

async function hasFileWithExtension(projectPath: string, extension: string): Promise<boolean> {
  try {
    const entries = await fs.readdir(projectPath, { withFileTypes: true });
    return entries.some((entry) => entry.isFile() && path.extname(entry.name).toLowerCase() === extension);
  } catch {
    return false;
  }
}
