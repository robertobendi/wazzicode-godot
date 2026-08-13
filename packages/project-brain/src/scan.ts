import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { resolveProjectPath } from "@gvibe/safety";

export type ProjectFileKind = "scene" | "resource" | "script" | "shader";
export type ProjectFileScope = "first-party" | "addon";

export interface ProjectFile {
  path: string;
  kind: ProjectFileKind;
  scope: ProjectFileScope;
  language?: "GDScript" | "C#";
}

export interface ProjectScanError {
  path: string;
  message: string;
}

export interface ProjectScanScope {
  root: "res://" | "res://addons";
  discovered: number;
  scanned: number;
  scripts: number;
}

export interface ProjectScanCoverage {
  cap: number;
  discovered: number;
  scanned: number;
  complete: boolean;
  truncated: boolean;
  errors: ProjectScanError[];
  scopes: {
    firstParty: ProjectScanScope;
    addons: ProjectScanScope;
  };
  sourceFingerprint: string;
}

export interface ProjectScan {
  files: ProjectFile[];
  scenes: string[];
  resources: string[];
  scripts: string[];
  gdScripts: string[];
  csharpScripts: string[];
  firstPartyScripts: string[];
  addonScripts: string[];
  shaders: string[];
  addons: string[];
  totalAssets: number;
  scannedRoots: string[];
  coverage: ProjectScanCoverage;
}

export interface ProjectScanOptions {
  maxFiles?: number;
}

export const DEFAULT_PROJECT_SCAN_CAP = 25_000;

const INDEXED_EXTENSIONS = new Map<string, ProjectFileKind>([
  [".gd", "script"],
  [".cs", "script"],
  [".tscn", "scene"],
  [".scn", "scene"],
  [".tres", "resource"],
  [".res", "resource"],
  [".gdshader", "shader"],
]);

const TEXT_EXTENSIONS = new Set([".gd", ".cs", ".tscn", ".tres", ".gdshader"]);

const SKIP_DIRECTORIES = new Set([
  ".git",
  ".godot",
  ".godot-vibe",
  ".idea",
  ".vscode",
  ".vs",
  "node_modules",
  "bin",
  "obj",
]);

interface DiscoveredFile extends ProjectFile {
  relativePath: string;
  extension: string;
  size: number;
  mtimeMs: number;
  contentDigest?: string;
}

export async function scanProject(projectPath: string, opts: ProjectScanOptions = {}): Promise<ProjectScan> {
  const cap = normalizeCap(opts.maxFiles);
  const errors: ProjectScanError[] = [];
  const discovered: DiscoveredFile[] = [];
  const rootExists = await exists(projectPath);
  if (rootExists) await discoverFiles(projectPath, projectPath, discovered, errors);
  discovered.sort(compareDiscovered);

  const prioritized = [...discovered].sort((a, b) => priority(a) - priority(b) || compareDiscovered(a, b));
  const selected = prioritized.slice(0, cap);
  await digestSelectedFiles(projectPath, selected, errors);
  const projectSettingsDigest = await digestProjectFile(projectPath, errors);
  const selectedFiles = selected.map(stripDiscoveryFields).sort((a, b) => a.path.localeCompare(b.path));
  const firstParty = discovered.filter((entry) => entry.scope === "first-party");
  const addons = discovered.filter((entry) => entry.scope === "addon");
  const selectedFirstParty = selectedFiles.filter((entry) => entry.scope === "first-party");
  const selectedAddons = selectedFiles.filter((entry) => entry.scope === "addon");
  const truncated = selected.length < discovered.length;

  const scan: ProjectScan = {
    files: selectedFiles,
    scenes: selectedFiles.filter((file) => file.kind === "scene").map((file) => file.path),
    resources: selectedFiles.filter((file) => file.kind === "resource").map((file) => file.path),
    scripts: selectedFiles.filter((file) => file.kind === "script").map((file) => file.path),
    gdScripts: selectedFiles.filter((file) => file.language === "GDScript").map((file) => file.path),
    csharpScripts: selectedFiles.filter((file) => file.language === "C#").map((file) => file.path),
    firstPartyScripts: selectedFiles
      .filter((file) => file.kind === "script" && file.scope === "first-party")
      .map((file) => file.path),
    addonScripts: selectedFiles
      .filter((file) => file.kind === "script" && file.scope === "addon")
      .map((file) => file.path),
    shaders: selectedFiles.filter((file) => file.kind === "shader").map((file) => file.path),
    addons: addonNames(discovered),
    totalAssets: selectedFiles.length,
    scannedRoots: rootExists ? ["res://"] : [],
    coverage: {
      cap,
      discovered: discovered.length,
      scanned: selected.length,
      complete: !truncated && errors.length === 0,
      truncated,
      errors,
      scopes: {
        firstParty: {
          root: "res://",
          discovered: firstParty.length,
          scanned: selectedFirstParty.length,
          scripts: selectedFirstParty.filter((file) => file.kind === "script").length,
        },
        addons: {
          root: "res://addons",
          discovered: addons.length,
          scanned: selectedAddons.length,
          scripts: selectedAddons.filter((file) => file.kind === "script").length,
        },
      },
      sourceFingerprint: sourceFingerprint(cap, rootExists, discovered, projectSettingsDigest, errors),
    },
  };
  return scan;
}

export function resourcePathToAbsolute(projectPath: string, resourcePath: string): string {
  if (!resourcePath.startsWith("res://")) {
    throw new Error(`Expected a res:// path, received ${resourcePath}`);
  }
  return path.join(projectPath, ...resourcePath.slice("res://".length).split("/"));
}

async function discoverFiles(
  directory: string,
  projectRoot: string,
  output: DiscoveredFile[],
  errors: ProjectScanError[],
): Promise<void> {
  let entries: import("node:fs").Dirent[];
  try {
    entries = await fs.readdir(directory, { withFileTypes: true });
  } catch (error) {
    errors.push({ path: toResourcePath(projectRoot, directory), message: errorMessage(error) });
    return;
  }
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRECTORIES.has(entry.name) || entry.name.endsWith("~")) continue;
      await discoverFiles(absolute, projectRoot, output, errors);
      continue;
    }
    if (!entry.isFile()) continue;
    const extension = path.extname(entry.name).toLowerCase();
    const kind = INDEXED_EXTENSIONS.get(extension);
    if (!kind) continue;
    try {
      const stat = await fs.stat(absolute);
      const relativePath = path.relative(projectRoot, absolute).split(path.sep).join("/");
      const resourcePath = `res://${relativePath}`;
      output.push({
        path: resourcePath,
        relativePath,
        kind,
        scope: relativePath.startsWith("addons/") ? "addon" : "first-party",
        language: extension === ".gd" ? "GDScript" : extension === ".cs" ? "C#" : undefined,
        extension,
        size: stat.size,
        mtimeMs: stat.mtimeMs,
      });
    } catch (error) {
      errors.push({ path: toResourcePath(projectRoot, absolute), message: errorMessage(error) });
    }
  }
}

async function digestSelectedFiles(
  projectPath: string,
  selected: DiscoveredFile[],
  errors: ProjectScanError[],
): Promise<void> {
  const textFiles = selected.filter((file) => TEXT_EXTENSIONS.has(file.extension));
  for (let start = 0; start < textFiles.length; start += 32) {
    await Promise.all(textFiles.slice(start, start + 32).map(async (file) => {
      try {
        const content = await fs.readFile(path.join(projectPath, file.relativePath));
        file.contentDigest = createHash("sha256").update(content).digest("hex");
      } catch (error) {
        errors.push({ path: file.path, message: errorMessage(error) });
      }
    }));
  }
}

async function digestProjectFile(
  projectPath: string,
  errors: ProjectScanError[],
): Promise<string | undefined> {
  try {
    const absolutePath = (await resolveProjectPath(projectPath, "project.godot")).absolute;
    return createHash("sha256").update(await fs.readFile(absolutePath)).digest("hex");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      errors.push({ path: "project.godot", message: errorMessage(error) });
    }
    return undefined;
  }
}

function sourceFingerprint(
  cap: number,
  rootExists: boolean,
  files: DiscoveredFile[],
  projectSettingsDigest: string | undefined,
  errors: ProjectScanError[],
): string {
  const hash = createHash("sha256");
  hash.update("godot-project-brain-source-v1\n");
  hash.update(`cap:${cap}\nroot:${rootExists}\nproject.godot:${projectSettingsDigest ?? "missing"}\n`);
  for (const file of [...files].sort(compareDiscovered)) {
    hash.update(`${file.path}\0${file.kind}\0${file.scope}\0${file.size}\0${file.mtimeMs}`);
    if (file.contentDigest) hash.update(`\0sha256:${file.contentDigest}`);
    hash.update("\n");
  }
  for (const error of [...errors].sort((a, b) => a.path.localeCompare(b.path))) {
    hash.update(`error:${error.path}\0${error.message}\n`);
  }
  return hash.digest("hex");
}

function stripDiscoveryFields(file: DiscoveredFile): ProjectFile {
  return {
    path: file.path,
    kind: file.kind,
    scope: file.scope,
    ...(file.language ? { language: file.language } : {}),
  };
}

function addonNames(files: DiscoveredFile[]): string[] {
  const names = new Set<string>();
  for (const file of files) {
    const match = /^addons\/([^/]+)\//.exec(file.relativePath);
    if (match) names.add(match[1]);
  }
  return [...names].sort();
}

function priority(file: DiscoveredFile): number {
  const scopeOffset = file.scope === "first-party" ? 0 : 1;
  switch (file.kind) {
    case "script": return scopeOffset;
    case "scene": return scopeOffset + 2;
    case "resource": return scopeOffset + 4;
    case "shader": return scopeOffset + 6;
  }
}

function compareDiscovered(left: DiscoveredFile, right: DiscoveredFile): number {
  return left.path.localeCompare(right.path);
}

function toResourcePath(projectRoot: string, absolute: string): string {
  const relative = path.relative(projectRoot, absolute).split(path.sep).join("/");
  return relative ? `res://${relative}` : "res://";
}

function normalizeCap(value: number | undefined): number {
  if (value === undefined) return DEFAULT_PROJECT_SCAN_CAP;
  if (!Number.isFinite(value) || value < 1) throw new RangeError("maxFiles must be a positive finite number");
  return Math.floor(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function exists(value: string): Promise<boolean> {
  try {
    await fs.access(value);
    return true;
  } catch {
    return false;
  }
}
