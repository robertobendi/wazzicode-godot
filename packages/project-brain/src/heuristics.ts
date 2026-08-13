import { promises as fs } from "node:fs";
import path from "node:path";
import { resourcePathToAbsolute } from "./scan.js";

export interface GDScriptFunction {
  name: string;
  signature: string;
  line: number;
}

export interface GDScriptSignal {
  name: string;
  signature: string;
  line: number;
}

export interface GDScriptExport {
  name: string;
  type?: string;
  annotation: string;
  line: number;
}

export interface GDScriptDependency {
  path: string;
  loader: "preload" | "load" | "extends";
  line: number;
}

export interface GDScriptAnalysis {
  path: string;
  className?: string;
  classNameLine?: number;
  extends?: string;
  extendsPath?: string;
  extendsLine?: number;
  tool: boolean;
  functions: GDScriptFunction[];
  signals: GDScriptSignal[];
  exports: GDScriptExport[];
  dependencies: GDScriptDependency[];
}

export interface CSharpAnalysis {
  path: string;
  classes: Array<{ name: string; base?: string; line: number }>;
}

export interface ScriptHeuristics {
  totalScripts: number;
  gdScriptCount: number;
  csharpScriptCount: number;
  toolScripts: string[];
  namedClasses: string[];
  baseTypes: string[];
  managers: string[];
  signalCount: number;
  functionCount: number;
  exportCount: number;
  hasNetworking: boolean;
  hasSaveSystem: boolean;
  hasInputHandling: boolean;
  gdScripts: GDScriptAnalysis[];
  csharpScripts: CSharpAnalysis[];
}

export async function analyzeScripts(projectPath: string, scripts: string[]): Promise<ScriptHeuristics> {
  const output: ScriptHeuristics = {
    totalScripts: scripts.length,
    gdScriptCount: 0,
    csharpScriptCount: 0,
    toolScripts: [],
    namedClasses: [],
    baseTypes: [],
    managers: [],
    signalCount: 0,
    functionCount: 0,
    exportCount: 0,
    hasNetworking: false,
    hasSaveSystem: false,
    hasInputHandling: false,
    gdScripts: [],
    csharpScripts: [],
  };

  for (const resourcePath of scripts) {
    let text: string;
    try {
      text = await fs.readFile(resourcePathToAbsolute(projectPath, resourcePath), "utf8");
    } catch {
      continue;
    }
    if (resourcePath.endsWith(".gd")) {
      const analysis = parseGDScript(resourcePath, text);
      output.gdScripts.push(analysis);
      if (analysis.tool) output.toolScripts.push(resourcePath);
      if (analysis.className) output.namedClasses.push(analysis.className);
      if (analysis.extends && !analysis.extends.startsWith("res://")) output.baseTypes.push(analysis.extends);
      output.signalCount += analysis.signals.length;
      output.functionCount += analysis.functions.length;
      output.exportCount += analysis.exports.length;
    } else if (resourcePath.endsWith(".cs")) {
      output.csharpScripts.push(parseCSharp(resourcePath, text));
    }
    const name = path.posix.basename(resourcePath, path.posix.extname(resourcePath));
    if (/(?:manager|controller|service|system|coordinator|director)$/i.test(name)) {
      output.managers.push(resourcePath);
    }
    if (!output.hasNetworking && /\b(?:MultiplayerAPI|MultiplayerSpawner|MultiplayerSynchronizer|rpc)\b/.test(text)) {
      output.hasNetworking = true;
    }
    if (!output.hasSaveSystem && /\b(?:FileAccess|ConfigFile|ResourceSaver|save_game|save_data)\b/i.test(text)) {
      output.hasSaveSystem = true;
    }
    if (!output.hasInputHandling && /\b(?:Input\.|InputEvent|_input|_unhandled_input)\b/.test(text)) {
      output.hasInputHandling = true;
    }
  }

  output.gdScripts.sort((a, b) => a.path.localeCompare(b.path));
  output.csharpScripts.sort((a, b) => a.path.localeCompare(b.path));
  output.gdScriptCount = output.gdScripts.length;
  output.csharpScriptCount = output.csharpScripts.length;
  output.toolScripts = uniqueSorted(output.toolScripts);
  output.namedClasses = uniqueSorted(output.namedClasses);
  output.baseTypes = uniqueSorted(output.baseTypes);
  output.managers = uniqueSorted(output.managers);
  return output;
}

export function parseGDScript(resourcePath: string, text: string): GDScriptAnalysis {
  const analysis: GDScriptAnalysis = {
    path: resourcePath,
    tool: false,
    functions: [],
    signals: [],
    exports: [],
    dependencies: [],
  };
  let pendingExportAnnotation: { value: string; line: number } | null = null;
  const dependencyKeys = new Set<string>();
  const lines = text.split(/\r?\n/);
  for (let index = 0; index < lines.length; index++) {
    const lineNumber = index + 1;
    const line = stripGDScriptComment(lines[index]).trim();
    if (!line) continue;
    if (line === "@tool") analysis.tool = true;
    const className = /^class_name\s+([A-Za-z_]\w*)\b/.exec(line);
    if (className) {
      analysis.className = className[1];
      analysis.classNameLine = lineNumber;
    }
    const extendsMatch = /^extends\s+(.+?)\s*$/.exec(line);
    if (extendsMatch) {
      const rawBase = extendsMatch[1].trim();
      const pathMatch = /["'](res:\/\/[^"']+)["']/.exec(rawBase);
      analysis.extendsPath = pathMatch?.[1];
      analysis.extends = pathMatch?.[1] ?? rawBase;
      analysis.extendsLine = lineNumber;
      if (pathMatch) addDependency(analysis, dependencyKeys, pathMatch[1], "extends", lineNumber);
    }
    const signal = /^signal\s+([A-Za-z_]\w*)\s*(?:\((.*)\))?\s*$/.exec(line);
    if (signal) {
      analysis.signals.push({ name: signal[1], signature: normalizeWhitespace(line), line: lineNumber });
    }
    const fn = /^(?:(?:static|async)\s+)*func\s+([A-Za-z_]\w*)\s*\((.*)\)\s*(?:->\s*([^:]+))?\s*:/.exec(line);
    if (fn) {
      analysis.functions.push({ name: fn[1], signature: normalizeWhitespace(line), line: lineNumber });
    }

    if (/^@export(?:_|\b)/.test(line) && !/\bvar\s+/.test(line)) {
      pendingExportAnnotation = { value: line, line: lineNumber };
    }
    const exported = /^(?<annotation>@export(?:_[A-Za-z_]\w*)?(?:\([^)]*\))?\s+)?(?:@onready\s+)?var\s+(?<name>[A-Za-z_]\w*)(?:\s*:\s*(?<type>[^=]+?))?\s*(?:=|$)/.exec(line);
    if (exported?.groups && (exported.groups.annotation || pendingExportAnnotation)) {
      const pending = pendingExportAnnotation;
      analysis.exports.push({
        name: exported.groups.name,
        type: exported.groups.type?.trim(),
        annotation: exported.groups.annotation?.trim() ?? pending?.value ?? "@export",
        line: exported.groups.annotation ? lineNumber : pending?.line ?? lineNumber,
      });
      pendingExportAnnotation = null;
    } else if (!line.startsWith("@")) {
      pendingExportAnnotation = null;
    }

    const loadPattern = /\b(preload|load)\s*\(\s*["'](res:\/\/[^"']+)["']\s*\)/g;
    let dependency: RegExpExecArray | null;
    while ((dependency = loadPattern.exec(line)) !== null) {
      addDependency(
        analysis,
        dependencyKeys,
        dependency[2],
        dependency[1] as "preload" | "load",
        lineNumber,
      );
    }
  }
  return analysis;
}

export function parseCSharp(resourcePath: string, text: string): CSharpAnalysis {
  const classes: CSharpAnalysis["classes"] = [];
  const regex = /\bclass\s+([A-Za-z_]\w*)(?:\s*:\s*([A-Za-z_][\w.<>]*))?/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(text)) !== null) {
    classes.push({
      name: match[1],
      base: match[2],
      line: 1 + text.slice(0, match.index).split("\n").length - 1,
    });
  }
  return { path: resourcePath, classes };
}

function addDependency(
  analysis: GDScriptAnalysis,
  keys: Set<string>,
  dependencyPath: string,
  loader: GDScriptDependency["loader"],
  line: number,
): void {
  const key = `${loader}\0${dependencyPath}`;
  if (keys.has(key)) return;
  keys.add(key);
  analysis.dependencies.push({ path: dependencyPath, loader, line });
}

function stripGDScriptComment(line: string): string {
  let quote: "'" | '"' | null = null;
  let escaped = false;
  for (let index = 0; index < line.length; index++) {
    const character = line[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === "\\" && quote) {
      escaped = true;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = quote === character ? null : quote ?? character;
      continue;
    }
    if (character === "#" && !quote) return line.slice(0, index);
  }
  return line;
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values)].sort();
}
