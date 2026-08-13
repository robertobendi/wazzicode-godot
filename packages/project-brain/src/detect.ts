import { promises as fs } from "node:fs";
import path from "node:path";

export interface UnityProjectDetection {
  isUnityProject: boolean;
  projectPath: string;
  unityVersion?: string;
  unityRevision?: string;
  productName?: string;
  companyName?: string;
  bundleIdentifier?: string;
  defaultBuildTarget?: string;
  packages?: Array<{ name: string; version: string }>;
  renderPipeline?: string;
  inputSystem?: string;
  scriptingBackend?: string;
}

export async function detectUnityProject(projectPath: string): Promise<UnityProjectDetection> {
  const result: UnityProjectDetection = {
    isUnityProject: false,
    projectPath,
  };

  const assetsExists = await pathExists(path.join(projectPath, "Assets"));
  const settingsExists = await pathExists(path.join(projectPath, "ProjectSettings"));
  const packagesExists = await pathExists(path.join(projectPath, "Packages"));
  if (!(assetsExists && settingsExists && packagesExists)) {
    return result;
  }

  result.isUnityProject = true;

  const versionTxt = await readFileOrNull(path.join(projectPath, "ProjectSettings", "ProjectVersion.txt"));
  if (versionTxt) {
    const v = /m_EditorVersion:\s*(\S+)/.exec(versionTxt);
    if (v) result.unityVersion = v[1];
    const r = /m_EditorVersionWithRevision:\s*([^\n\r]+)/.exec(versionTxt);
    if (r) result.unityRevision = r[1].trim();
  }

  const projectSettings = await readFileOrNull(path.join(projectPath, "ProjectSettings", "ProjectSettings.asset"));
  if (projectSettings) {
    const product = /productName:\s*(.+)/.exec(projectSettings);
    if (product) result.productName = product[1].trim();
    const company = /companyName:\s*(.+)/.exec(projectSettings);
    if (company) result.companyName = company[1].trim();
    const bundle = /bundleVersion:\s*(.+)/.exec(projectSettings); // version, not bundleId
    if (bundle) {
      // continue; bundleIdentifier comes below
    }
    // applicationIdentifier and scriptingBackend are per-platform maps. The
    // serialized order is arbitrary (often a stale Android/iPhone entry first),
    // so grabbing the first sub-entry yields the wrong value. Prefer the
    // Standalone key — that's what the editor surfaces for a desktop project —
    // and fall back to any entry. (These remain heuristic; the live bridge,
    // which applies defaults/migrations, is the ground truth.)
    const appId = preferStandalone(extractPlatformMap(projectSettings, "applicationIdentifier"));
    if (appId) result.bundleIdentifier = appId;
    const sbVal = preferStandalone(extractPlatformMap(projectSettings, "scriptingBackend"));
    if (sbVal !== undefined) result.scriptingBackend = sbVal === "1" ? "IL2CPP" : "Mono";
    const at = /activeBuildTarget:\s*(\d+)/.exec(projectSettings);
    if (at) result.defaultBuildTarget = mapBuildTarget(Number(at[1]));
  }

  const manifestRaw = await readFileOrNull(path.join(projectPath, "Packages", "manifest.json"));
  if (manifestRaw) {
    try {
      const json = JSON.parse(manifestRaw) as { dependencies?: Record<string, string> };
      const deps = json.dependencies ?? {};
      result.packages = Object.entries(deps).map(([name, version]) => ({ name, version }));
      result.renderPipeline = inferRenderPipeline(result.packages);
      result.inputSystem = inferInputSystem(result.packages);
    } catch {
      /* ignore */
    }
  }

  return result;
}

// Parse a YAML per-platform map nested under `key:` into { Platform: value }.
// Handles both the empty inline form (`key: {}`) and the indented block form.
function extractPlatformMap(text: string, key: string): Record<string, string> | null {
  const re = new RegExp(`^([ \\t]*)${key}:[ \\t]*(\\{\\})?[ \\t]*$`, "m");
  const m = re.exec(text);
  if (!m) return null;
  if (m[2] === "{}") return {}; // explicit empty map → no platform overrides
  const parentIndent = m[1].length;
  const lines = text.slice(m.index + m[0].length).split(/\r?\n/);
  const map: Record<string, string> = {};
  let childIndent: number | null = null;
  for (const line of lines) {
    if (line.trim() === "") continue;
    const indent = line.length - line.trimStart().length;
    if (indent <= parentIndent) break; // dedented to sibling/parent → block ended
    if (childIndent === null) childIndent = indent;
    if (indent !== childIndent) continue; // deeper nesting belongs to a child value
    const kv = /^[ \t]*([A-Za-z0-9_]+):[ \t]*(.*)$/.exec(line);
    if (!kv) break;
    map[kv[1]] = kv[2].trim();
  }
  return map;
}

function preferStandalone(map: Record<string, string> | null): string | undefined {
  if (!map) return undefined;
  if (map.Standalone) return map.Standalone;
  for (const v of Object.values(map)) if (v) return v;
  return undefined;
}

function inferRenderPipeline(pkgs: Array<{ name: string; version: string }>): string {
  const names = pkgs.map((p) => p.name);
  if (names.includes("com.unity.render-pipelines.high-definition")) return "HDRP";
  if (names.includes("com.unity.render-pipelines.universal")) return "URP";
  return "Built-in";
}

function inferInputSystem(pkgs: Array<{ name: string; version: string }>): string {
  return pkgs.some((p) => p.name === "com.unity.inputsystem") ? "InputSystem" : "Legacy InputManager";
}

function mapBuildTarget(id: number): string {
  switch (id) {
    case 5: return "PCStandalone";
    case 9: return "iOS";
    case 13: return "Android";
    case 19: return "WebGL";
    case 24: return "StandaloneLinux64";
    case 25: return "StandaloneOSX";
    case 27: return "StandaloneWindows64";
    default: return `Unknown(${id})`;
  }
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function readFileOrNull(p: string): Promise<string | null> {
  try {
    return await fs.readFile(p, "utf8");
  } catch {
    return null;
  }
}
