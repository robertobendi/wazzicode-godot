import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

export interface ProjectScanError {
  path: string;
  message: string;
}

export interface ProjectScanScope {
  root: "Assets" | "Packages";
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
    packages: ProjectScanScope;
  };
  sourceFingerprint: string;
}

export interface ProjectScan {
  scenes: string[];
  prefabs: string[];
  scripts: string[];
  firstPartyScripts: string[];
  packageScripts: string[];
  scriptableObjectAssets: string[];
  materials: string[];
  textures: string[];
  audio: string[];
  totalAssets: number;
  scannedRoots: string[];
  coverage: ProjectScanCoverage;
}

export interface ProjectScanOptions {
  maxFiles?: number;
}

export const DEFAULT_PROJECT_SCAN_CAP = 25_000;

const SCENE_EXT = ".unity";
const PREFAB_EXT = ".prefab";
const SCRIPT_EXT = ".cs";
const SO_LIKELY_EXT = ".asset";
const MATERIAL_EXT = ".mat";
const TEXTURE_EXTS = new Set([".png", ".jpg", ".jpeg", ".tga", ".psd", ".tif", ".tiff", ".exr", ".hdr"]);
const AUDIO_EXTS = new Set([".wav", ".ogg", ".mp3", ".aif", ".aiff", ".flac"]);

const SKIP_DIR_NAMES = new Set([
  "Library",
  "Temp",
  "Logs",
  "obj",
  "Build",
  "Builds",
  ".git",
  "node_modules",
  ".unity-vibe",
  ".vs",
  ".idea",
  ".vscode",
]);

interface DiscoveredFile {
  path: string;
  root: "Assets" | "Packages" | "ProjectSettings";
  extension: string;
  size: number;
  mtimeMs: number;
  contentDigest?: string;
}

const CONTENT_SENSITIVE_PATHS = new Set([
  "Packages/manifest.json",
  "ProjectSettings/ProjectSettings.asset",
  "ProjectSettings/ProjectVersion.txt",
]);

export async function scanProject(projectPath: string, opts: ProjectScanOptions = {}): Promise<ProjectScan> {
  const cap = normalizeCap(opts.maxFiles);
  const errors: ProjectScanError[] = [];
  const discovered: DiscoveredFile[] = [];
  const scannedRoots: string[] = [];
  const rootPresence = new Map<string, boolean>();

  for (const root of ["Assets", "Packages"] as const) {
    const abs = path.join(projectPath, root);
    const present = await exists(abs);
    rootPresence.set(root, present);
    if (!present) continue;
    scannedRoots.push(root);
    await discoverFiles(abs, root, projectPath, discovered, errors);
  }

  rootPresence.set("ProjectSettings", await exists(path.join(projectPath, "ProjectSettings")));

  for (const rel of ["ProjectSettings/ProjectVersion.txt", "ProjectSettings/ProjectSettings.asset"]) {
    const entry = await describeFile(projectPath, rel, "ProjectSettings", errors);
    if (entry) discovered.push(entry);
  }

  const assetFiles = discovered.filter((entry) => entry.root === "Assets");
  const packageFiles = discovered.filter((entry) => entry.root === "Packages");
  const prioritized = [
    ...assetFiles.filter(isScript),
    ...packageFiles.filter(isScript),
    ...assetFiles.filter((entry) => !isScript(entry)),
    ...packageFiles.filter((entry) => !isScript(entry)),
  ];
  const selected = prioritized.slice(0, cap);
  const selectedPaths = new Set(selected.map((entry) => entry.path));
  const firstPartySelected = selected.filter((entry) => entry.root === "Assets");
  const packageSelected = selected.filter((entry) => entry.root === "Packages");
  await digestContentInputs(projectPath, discovered, selectedPaths, errors);

  const scan: ProjectScan = {
    scenes: [],
    prefabs: [],
    scripts: [],
    firstPartyScripts: [],
    packageScripts: [],
    scriptableObjectAssets: [],
    materials: [],
    textures: [],
    audio: [],
    totalAssets: selected.length,
    scannedRoots,
    coverage: {
      cap,
      discovered: prioritized.length,
      scanned: selected.length,
      complete: selected.length === prioritized.length && errors.length === 0,
      truncated: selected.length < prioritized.length,
      errors,
      scopes: {
        firstParty: {
          root: "Assets",
          discovered: assetFiles.length,
          scanned: firstPartySelected.length,
          scripts: firstPartySelected.filter(isScript).length,
        },
        packages: {
          root: "Packages",
          discovered: packageFiles.length,
          scanned: packageSelected.length,
          scripts: packageSelected.filter(isScript).length,
        },
      },
      sourceFingerprint: sourceFingerprint(cap, discovered, errors, rootPresence),
    },
  };

  for (const entry of discovered) {
    if (!selectedPaths.has(entry.path)) continue;
    classify(entry, scan);
  }
  sortScan(scan);

  return scan;
}

async function discoverFiles(
  absDir: string,
  root: "Assets" | "Packages",
  projectRoot: string,
  out: DiscoveredFile[],
  errors: ProjectScanError[],
): Promise<void> {
  let entries: import("node:fs").Dirent[];
  try {
    entries = await fs.readdir(absDir, { withFileTypes: true });
  } catch (error) {
    errors.push({ path: relativePath(projectRoot, absDir), message: errorMessage(error) });
    return;
  }
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    const abs = path.join(absDir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIR_NAMES.has(entry.name) || entry.name.endsWith("~")) continue;
      await discoverFiles(abs, root, projectRoot, out, errors);
      continue;
    }
    if (!entry.isFile() || entry.name.toLowerCase().endsWith(".meta")) continue;
    const rel = relativePath(projectRoot, abs);
    const described = await describeFile(projectRoot, rel, root, errors);
    if (described) out.push(described);
  }
}

async function describeFile(
  projectRoot: string,
  rel: string,
  root: DiscoveredFile["root"],
  errors: ProjectScanError[],
): Promise<DiscoveredFile | null> {
  try {
    const stat = await fs.stat(path.join(projectRoot, rel));
    if (!stat.isFile()) return null;
    return {
      path: rel.split(path.sep).join("/"),
      root,
      extension: path.extname(rel).toLowerCase(),
      size: stat.size,
      mtimeMs: stat.mtimeMs,
    };
  } catch (error) {
    errors.push({ path: rel.split(path.sep).join("/"), message: errorMessage(error) });
    return null;
  }
}

function classify(entry: DiscoveredFile, scan: ProjectScan): void {
  const rel = entry.path;
  const ext = entry.extension;
  if (ext === SCENE_EXT) scan.scenes.push(rel);
  else if (ext === PREFAB_EXT) scan.prefabs.push(rel);
  else if (ext === SCRIPT_EXT) {
    scan.scripts.push(rel);
    if (entry.root === "Assets") scan.firstPartyScripts.push(rel);
    else if (entry.root === "Packages") scan.packageScripts.push(rel);
  } else if (ext === SO_LIKELY_EXT) scan.scriptableObjectAssets.push(rel);
  else if (ext === MATERIAL_EXT) scan.materials.push(rel);
  else if (TEXTURE_EXTS.has(ext)) scan.textures.push(rel);
  else if (AUDIO_EXTS.has(ext)) scan.audio.push(rel);
}

function sortScan(scan: ProjectScan): void {
  scan.scenes.sort();
  scan.prefabs.sort();
  scan.scripts.sort();
  scan.firstPartyScripts.sort();
  scan.packageScripts.sort();
  scan.scriptableObjectAssets.sort();
  scan.materials.sort();
  scan.textures.sort();
  scan.audio.sort();
}

async function digestContentInputs(
  projectRoot: string,
  files: DiscoveredFile[],
  selectedPaths: Set<string>,
  errors: ProjectScanError[],
): Promise<void> {
  const inputs = files.filter((file) =>
    CONTENT_SENSITIVE_PATHS.has(file.path) || (file.extension === SCRIPT_EXT && selectedPaths.has(file.path)));
  const batchSize = 32;
  for (let start = 0; start < inputs.length; start += batchSize) {
    await Promise.all(inputs.slice(start, start + batchSize).map(async (file) => {
      try {
        const contents = await fs.readFile(path.join(projectRoot, file.path));
        file.contentDigest = createHash("sha256").update(contents).digest("hex");
      } catch (error) {
        errors.push({ path: file.path, message: errorMessage(error) });
      }
    }));
  }
}

function sourceFingerprint(
  cap: number,
  files: DiscoveredFile[],
  errors: ProjectScanError[],
  rootPresence: Map<string, boolean>,
): string {
  const hash = createHash("sha256");
  hash.update("format:content-v1\n");
  hash.update(`cap:${cap}\n`);
  for (const root of ["Assets", "Packages", "ProjectSettings"]) {
    hash.update(`root:${root}\u0000${rootPresence.get(root) === true}\n`);
  }
  for (const file of files.slice().sort((a, b) => a.path.localeCompare(b.path))) {
    hash.update(`file:${file.root}\u0000${file.path}\u0000${file.extension}\u0000${file.size}\u0000${file.mtimeMs}`);
    if (file.contentDigest) hash.update(`\u0000sha256:${file.contentDigest}`);
    hash.update("\n");
  }
  for (const error of errors.slice().sort((a, b) => a.path.localeCompare(b.path))) {
    hash.update(`error:${error.path}\u0000${error.message}\n`);
  }
  return hash.digest("hex");
}

function normalizeCap(value: number | undefined): number {
  if (value === undefined) return DEFAULT_PROJECT_SCAN_CAP;
  if (!Number.isFinite(value) || value < 1) throw new RangeError("maxFiles must be a positive finite number");
  return Math.floor(value);
}

function isScript(entry: DiscoveredFile): boolean {
  return entry.extension === SCRIPT_EXT;
}

function relativePath(projectRoot: string, absolutePath: string): string {
  return path.relative(projectRoot, absolutePath).split(path.sep).join("/");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}
