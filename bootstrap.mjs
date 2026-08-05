#!/usr/bin/env node
/**
 * WazziCode Godot project bootstrap.
 *
 * The installer is intentionally dependency-free: Node starts it, then uv (or
 * a local Python fallback) provisions the repository's editable Python venv.
 * It never evaluates downloaded shell code and never writes global MCP config.
 */

import { spawnSync } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import {
  access,
  cp,
  lstat,
  mkdir,
  readFile,
  readlink,
  realpath,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const SERVER_NAME = "wazzicode-godot";
export const ADDON_RESOURCE_PATH = "res://addons/godot_ai/plugin.cfg";
export const GUIDANCE_BEGIN = "<!-- BEGIN wazzicode-godot -->";
export const GUIDANCE_END = "<!-- END wazzicode-godot -->";
export const IGNORE_BEGIN = "# BEGIN wazzicode-godot local artifacts";
export const IGNORE_END = "# END wazzicode-godot local artifacts";

const BOOTSTRAP_FILE = fileURLToPath(import.meta.url);
const DEFAULT_REPO_ROOT = path.dirname(BOOTSTRAP_FILE);
const COPY_MARKER = ".wazzicode-godot-copy.json";
const MIN_NODE_MAJOR = 20;
const MIN_PYTHON = [3, 11];

const GUIDANCE_BLOCK = `${GUIDANCE_BEGIN}
## WazziCode Godot MCP workflow

- Open this project in Godot and confirm the WazziCode Godot editor plugin is enabled.
- Start with \`godot_orient({task: "<current request>"})\`; use \`editor_state\` and paged \`scene_get_hierarchy\` for deeper inspection, and \`session_activate\` when multiple editors are connected.
- Read before writing. Prefer the named high-traffic tools, then a \`<domain>_manage\` operation for less-common work. \`batch_execute\` takes plugin command names.
- Inspect each write's diagnostics and use \`logs_read\` for editor/game errors. Use \`project_run(autosave=false)\` for non-persistent smoke checks.
- Finish with \`godot_verify\` (set \`run_tests=true\` when relevant), a play check, and \`editor_screenshot\` when visuals changed. Save scenes intentionally; direct filesystem writes are not undoable.
${GUIDANCE_END}`;

const IGNORE_BLOCK = `${IGNORE_BEGIN}
/.mcp.json
/addons/godot_ai/
/.wazzicode-godot/runtime/
/.wazzicode-godot/cache/
/.wazzicode-godot/logs/
/.wazzicode-godot/tmp/
${IGNORE_END}`;

export class SetupError extends Error {
  constructor(message) {
    super(message);
    this.name = "SetupError";
  }
}

export function helpText(repoRoot = DEFAULT_REPO_ROOT) {
  return `WazziCode Godot setup

Usage:
  node "${path.join(repoRoot, "bootstrap.mjs")}" [Godot project path] [options]

If the path is omitted, setup walks from the current directory upward until it
finds project.godot. A path may name either the project directory or the
project.godot file itself.

Options:
  --project <path>  Explicit Godot project (alternative to the positional path)
  --link            Link the addon to this checkout (default; junction on Windows)
  --copy            Copy the addon instead of linking it
  --dry-run         Validate and print the plan without installs or writes
  -h, --help        Show this help

Environment overrides:
  WAZZICODE_GODOT_PROJECT  Default project path
  WAZZICODE_UV             uv executable path
  WAZZICODE_PYTHON         Python 3.11+ executable path used only when uv is absent
`;
}

export function parseArgs(argv, env = process.env) {
  let project = null;
  let mode = "link";
  let dryRun = false;
  let help = false;
  const positional = [];

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--copy") {
      mode = "copy";
    } else if (arg === "--link") {
      mode = "link";
    } else if (arg === "--dry-run") {
      dryRun = true;
    } else if (arg === "--help" || arg === "-h") {
      help = true;
    } else if (arg === "--project") {
      i += 1;
      if (i >= argv.length || argv[i].startsWith("--")) {
        throw new SetupError("--project requires a path");
      }
      project = argv[i];
    } else if (arg.startsWith("--project=")) {
      project = arg.slice("--project=".length);
      if (!project) throw new SetupError("--project requires a path");
    } else if (arg.startsWith("-")) {
      throw new SetupError(`Unknown option: ${arg}`);
    } else {
      positional.push(arg);
    }
  }

  if (positional.length > 1) {
    throw new SetupError("Pass at most one Godot project path");
  }
  if (project && positional.length === 1) {
    throw new SetupError("Pass the project either positionally or with --project, not both");
  }

  return {
    project: project ?? positional[0] ?? env.WAZZICODE_GODOT_PROJECT ?? null,
    mode,
    dryRun,
    help,
  };
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

async function exists(file) {
  try {
    await access(file, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function isFile(file) {
  try {
    return (await stat(file)).isFile();
  } catch {
    return false;
  }
}

async function readOptional(file) {
  try {
    return await readFile(file, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw new SetupError(`Could not read ${file}: ${error.message}`);
  }
}

function normalizeCase(file, platform = process.platform) {
  const normalized = path.resolve(file);
  return platform === "win32" ? normalized.toLowerCase() : normalized;
}

export function isInside(root, candidate, platform = process.platform) {
  const normalizedRoot = normalizeCase(root, platform);
  const normalizedCandidate = normalizeCase(candidate, platform);
  const relative = path.relative(normalizedRoot, normalizedCandidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

async function nearestExistingAncestor(candidate) {
  let current = candidate;
  for (;;) {
    if (await exists(current)) return current;
    const parent = path.dirname(current);
    if (parent === current) return current;
    current = parent;
  }
}

async function assertSafeManagedPath(projectRoot, candidate, { allowExistingLink = false } = {}) {
  if (!isInside(projectRoot, candidate)) {
    throw new SetupError(`Refusing to write outside the Godot project: ${candidate}`);
  }

  const ancestor = await nearestExistingAncestor(path.dirname(candidate));
  const physicalAncestor = await realpath(ancestor);
  if (!isInside(projectRoot, physicalAncestor)) {
    throw new SetupError(
      `Refusing to write through a directory link outside the Godot project: ${candidate}`,
    );
  }

  try {
    const info = await lstat(candidate);
    if (info.isSymbolicLink() && !allowExistingLink) {
      throw new SetupError(`Refusing to overwrite linked managed file: ${candidate}`);
    }
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

export async function resolveGodotProject(explicitPath, startDirectory = process.cwd()) {
  if (explicitPath) {
    const requested = path.resolve(startDirectory, explicitPath);
    const requestedInfo = await stat(requested).catch(() => null);
    if (!requestedInfo) throw new SetupError(`Godot project path does not exist: ${requested}`);

    const directory = requestedInfo.isFile() ? path.dirname(requested) : requested;
    if (requestedInfo.isFile() && path.basename(requested) !== "project.godot") {
      throw new SetupError(`Expected a project directory or project.godot, got: ${requested}`);
    }
    if (!(await isFile(path.join(directory, "project.godot")))) {
      throw new SetupError(`Not a Godot project (project.godot is missing): ${directory}`);
    }
    return await realpath(directory);
  }

  let directory = path.resolve(startDirectory);
  const startInfo = await stat(directory).catch(() => null);
  if (startInfo?.isFile()) directory = path.dirname(directory);
  for (;;) {
    if (await isFile(path.join(directory, "project.godot"))) return await realpath(directory);
    const parent = path.dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  throw new SetupError(
    `No project.godot found from ${path.resolve(startDirectory)} upward. Pass the project path explicitly.`,
  );
}

function parsePackedStringArray(inner) {
  const values = [];
  let index = 0;
  const skipWhitespace = () => {
    while (/\s/.test(inner[index] ?? "")) index += 1;
  };

  skipWhitespace();
  if (index >= inner.length) return values;
  for (;;) {
    skipWhitespace();
    if (inner[index] !== '"') {
      throw new SetupError("editor_plugins/enabled is not a simple PackedStringArray of strings");
    }
    const start = index;
    index += 1;
    let escaped = false;
    for (; index < inner.length; index += 1) {
      const char = inner[index];
      if (!escaped && char === '"') break;
      if (!escaped && char === "\\") escaped = true;
      else escaped = false;
    }
    if (index >= inner.length) {
      throw new SetupError("Unterminated string in editor_plugins/enabled");
    }
    const token = inner.slice(start, index + 1);
    try {
      values.push(JSON.parse(token));
    } catch {
      throw new SetupError("Unsupported string escape in editor_plugins/enabled");
    }
    index += 1;
    skipWhitespace();
    if (index >= inner.length) return values;
    if (inner[index] !== ",") {
      throw new SetupError("Malformed editor_plugins/enabled PackedStringArray");
    }
    index += 1;
    skipWhitespace();
    if (index >= inner.length) {
      throw new SetupError("Trailing comma in editor_plugins/enabled is not supported");
    }
  }
}

export function enablePluginInProjectGodot(source) {
  const eol = source.includes("\r\n") ? "\r\n" : "\n";
  const hadFinalEol = source.endsWith("\n") || source.endsWith("\r");
  const lines = source === "" ? [] : source.split(/\r\n|\n|\r/);
  if (hadFinalEol) lines.pop();

  const headers = [];
  for (let i = 0; i < lines.length; i += 1) {
    const match = lines[i].replace(/^\uFEFF/, "").match(/^\s*\[([^\]]+)\]\s*(?:;.*)?$/);
    if (match) headers.push({ name: match[1].trim(), index: i });
  }
  const editorHeaders = headers.filter((header) => header.name === "editor_plugins");
  if (editorHeaders.length > 1) {
    throw new SetupError("project.godot contains multiple [editor_plugins] sections");
  }

  if (editorHeaders.length === 0) {
    if (lines.length > 0 && lines.at(-1) !== "") lines.push("");
    lines.push("[editor_plugins]", `enabled=PackedStringArray(${JSON.stringify(ADDON_RESOURCE_PATH)})`);
    return lines.join(eol) + (hadFinalEol ? eol : "");
  }

  const sectionStart = editorHeaders[0].index;
  const nextHeader = headers.find((header) => header.index > sectionStart);
  const sectionEnd = nextHeader?.index ?? lines.length;
  const enabledLines = [];
  for (let i = sectionStart + 1; i < sectionEnd; i += 1) {
    if (/^\s*enabled\s*=/.test(lines[i])) enabledLines.push(i);
  }
  if (enabledLines.length > 1) {
    throw new SetupError("project.godot contains multiple editor_plugins/enabled values");
  }

  if (enabledLines.length === 0) {
    lines.splice(sectionEnd, 0, `enabled=PackedStringArray(${JSON.stringify(ADDON_RESOURCE_PATH)})`);
    return lines.join(eol) + (hadFinalEol ? eol : "");
  }

  const enabledIndex = enabledLines[0];
  const match = lines[enabledIndex].match(
    /^(\s*enabled\s*=\s*)PackedStringArray\((.*)\)(\s*(?:;.*)?)$/,
  );
  if (!match) {
    throw new SetupError(
      "Refusing to replace editor_plugins/enabled because it is not a one-line PackedStringArray",
    );
  }
  const plugins = parsePackedStringArray(match[2]);
  if (!plugins.includes(ADDON_RESOURCE_PATH)) plugins.push(ADDON_RESOURCE_PATH);
  lines[enabledIndex] = `${match[1]}PackedStringArray(${plugins.map(JSON.stringify).join(", ")})${match[3]}`;
  return lines.join(eol) + (hadFinalEol ? eol : "");
}

function countOccurrences(source, needle) {
  let count = 0;
  let offset = 0;
  for (;;) {
    const found = source.indexOf(needle, offset);
    if (found < 0) return count;
    count += 1;
    offset = found + needle.length;
  }
}

export function upsertMarkedBlock(source, begin, end, block) {
  const eol = source.includes("\r\n") ? "\r\n" : "\n";
  const renderedBlock = block.replace(/\n/g, eol);
  const beginCount = countOccurrences(source, begin);
  const endCount = countOccurrences(source, end);
  if (beginCount !== endCount || beginCount > 1) {
    throw new SetupError(`Managed markers are incomplete or duplicated: ${begin} / ${end}`);
  }
  if (beginCount === 0) {
    if (!source) return `${renderedBlock}${eol}`;
    const separator = source.endsWith(`${eol}${eol}`) ? "" : source.endsWith(eol) ? eol : `${eol}${eol}`;
    return `${source}${separator}${renderedBlock}${eol}`;
  }

  const start = source.indexOf(begin);
  const finish = source.indexOf(end, start + begin.length);
  if (finish < start) throw new SetupError(`Managed end marker precedes begin marker: ${end}`);
  return source.slice(0, start) + renderedBlock + source.slice(finish + end.length);
}

function parseJsonObject(source, label) {
  let value;
  try {
    value = JSON.parse(source.replace(/^\uFEFF/, ""));
  } catch (error) {
    throw new SetupError(`Refusing to overwrite invalid ${label}: ${error.message}`);
  }
  if (!isObject(value)) throw new SetupError(`Refusing to overwrite ${label}: top level must be an object`);
  return value;
}

export function mergeMcpConfig(existing, entry) {
  const config = existing === null ? {} : structuredClone(existing);
  if (!isObject(config)) throw new SetupError(".mcp.json top level must be an object");
  if (config.mcpServers !== undefined && !isObject(config.mcpServers)) {
    throw new SetupError(".mcp.json mcpServers must be an object");
  }
  config.mcpServers ??= {};

  const previous = config.mcpServers[SERVER_NAME];
  if (previous !== undefined && !isObject(previous)) {
    throw new SetupError(`.mcp.json entry ${SERVER_NAME} must be an object`);
  }
  if (previous?.env !== undefined && !isObject(previous.env)) {
    throw new SetupError(`.mcp.json entry ${SERVER_NAME}.env must be an object`);
  }

  const merged = { ...(previous ?? {}), ...entry };
  merged.env = { ...(previous?.env ?? {}), ...entry.env };
  // A stale URL/type pair makes a command-based entry ambiguous in several clients.
  delete merged.url;
  delete merged.type;
  config.mcpServers[SERVER_NAME] = merged;
  return config;
}

function venvPythonPath(repoRoot, platform = process.platform) {
  return platform === "win32"
    ? path.join(repoRoot, ".venv", "Scripts", "python.exe")
    : path.join(repoRoot, ".venv", "bin", "python");
}

function venvUvPath(repoRoot, platform = process.platform) {
  return platform === "win32"
    ? path.join(repoRoot, ".venv", "Scripts", "uv.exe")
    : path.join(repoRoot, ".venv", "bin", "uv");
}

export function buildMcpEntry(repoRoot, pythonPath = venvPythonPath(repoRoot)) {
  return {
    command: pythonPath,
    args: ["-m", "godot_ai", "attach", "--disable-telemetry"],
    env: {
      GODOT_AI_DISABLE_TELEMETRY: "true",
      PYTHONPATH: path.join(repoRoot, "src"),
    },
  };
}

function quoteCommandPart(part) {
  const value = String(part);
  return /[\s"'<>|&]/.test(value) ? JSON.stringify(value) : value;
}

function displayCommand(command, args) {
  return [command, ...args].map(quoteCommandPart).join(" ");
}

function runChecked(command, args, { cwd, env = process.env, dryRun = false, quiet = false } = {}) {
  if (!quiet) console.log(`    $ ${displayCommand(command, args)}`);
  if (dryRun) return { status: 0, stdout: "", stderr: "" };
  const result = spawnSync(command, args, {
    cwd,
    env,
    encoding: "utf8",
    stdio: quiet ? ["ignore", "pipe", "pipe"] : "inherit",
    shell: false,
  });
  if (result.error) {
    throw new SetupError(`Could not run ${command}: ${result.error.message}`);
  }
  if (result.status !== 0) {
    const detail = quiet ? `\n${(result.stderr || result.stdout || "").trim()}` : "";
    throw new SetupError(`Command failed (${result.status}): ${displayCommand(command, args)}${detail}`);
  }
  return result;
}

function probePython(command, prefixArgs = []) {
  const result = spawnSync(
    command,
    [...prefixArgs, "-c", "import json,sys;print(json.dumps(list(sys.version_info[:2])))"],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], shell: false },
  );
  if (result.error || result.status !== 0) return null;
  try {
    const version = JSON.parse(result.stdout.trim());
    if (!Array.isArray(version) || version.length !== 2) return null;
    if (version[0] > MIN_PYTHON[0] || (version[0] === MIN_PYTHON[0] && version[1] >= MIN_PYTHON[1])) {
      return { command, prefixArgs, version };
    }
  } catch {
    return null;
  }
  return null;
}

function findPython(env = process.env, platform = process.platform) {
  if (env.WAZZICODE_PYTHON) {
    const found = probePython(env.WAZZICODE_PYTHON);
    if (!found) throw new SetupError("WAZZICODE_PYTHON must point to Python 3.11 or newer");
    return found;
  }
  const candidates =
    platform === "win32"
      ? [
          ["py", ["-3.14"]],
          ["py", ["-3.13"]],
          ["py", ["-3.12"]],
          ["py", ["-3.11"]],
          ["python", []],
          ["python3", []],
        ]
      : [
          ["python3", []],
          ["python", []],
        ];
  for (const [command, prefixArgs] of candidates) {
    const found = probePython(command, prefixArgs);
    if (found) return found;
  }
  return null;
}

function findUv(env = process.env) {
  const command = env.WAZZICODE_UV || "uv";
  const result = spawnSync(command, ["--version"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    shell: false,
  });
  if (!result.error && result.status === 0) return { command, prefixArgs: [] };
  if (env.WAZZICODE_UV) {
    throw new SetupError(`WAZZICODE_UV is not executable: ${env.WAZZICODE_UV}`);
  }
  return null;
}

async function ensureToolchain(
  repoRoot,
  { dryRun = false, env = process.env, platform = process.platform } = {},
) {
  const pythonPath = venvPythonPath(repoRoot, platform);
  const localUvPath = venvUvPath(repoRoot, platform);
  let uv = findUv(env);
  const hasVenv = await isFile(pythonPath);

  if (!hasVenv) {
    if (uv) {
      runChecked(uv.command, [...uv.prefixArgs, "venv", path.join(repoRoot, ".venv"), "--python", ">=3.11"], {
        cwd: repoRoot,
        env,
        dryRun,
      });
    } else {
      const bootstrapPython = findPython(env, platform);
      if (!bootstrapPython) {
        throw new SetupError(
          "uv is not on PATH and Python 3.11+ was not found. Install uv with your package manager, or install Python 3.11+, then rerun setup.",
        );
      }
      runChecked(
        bootstrapPython.command,
        [...bootstrapPython.prefixArgs, "-m", "venv", path.join(repoRoot, ".venv")],
        { cwd: repoRoot, env, dryRun },
      );
      runChecked(pythonPath, ["-m", "pip", "install", "--disable-pip-version-check", "uv>=0.7"], {
        cwd: repoRoot,
        env,
        dryRun,
      });
      uv = { command: localUvPath, prefixArgs: [] };
    }
  }

  if (dryRun && !hasVenv) {
    console.log(`    [dry-run] local Python will be ${pythonPath}`);
    console.log(`    [dry-run] would install this repository editable into the local venv`);
    return pythonPath;
  }

  const venvProbe = probePython(pythonPath);
  if (!venvProbe) {
    throw new SetupError(`Local venv is missing Python 3.11+: ${pythonPath}`);
  }
  if (!uv) {
    const localUv = spawnSync(localUvPath, ["--version"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
    });
    if (localUv.error || localUv.status !== 0) {
      const localPip = spawnSync(pythonPath, ["-m", "pip", "--version"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        shell: false,
      });
      if (localPip.error || localPip.status !== 0) {
        runChecked(pythonPath, ["-m", "ensurepip", "--upgrade"], {
          cwd: repoRoot,
          env,
          dryRun,
        });
      }
      runChecked(pythonPath, ["-m", "pip", "install", "--disable-pip-version-check", "uv>=0.7"], {
        cwd: repoRoot,
        env,
        dryRun,
      });
    }
    uv = { command: localUvPath, prefixArgs: [] };
  }

  runChecked(
    uv.command,
    [...uv.prefixArgs, "pip", "install", "--python", pythonPath, "--editable", repoRoot],
    { cwd: repoRoot, env, dryRun },
  );
  if (!dryRun) {
    runChecked(pythonPath, ["-c", "import godot_ai; print(godot_ai.__version__)"], {
      cwd: repoRoot,
      env: { ...env, PYTHONPATH: path.join(repoRoot, "src") },
      quiet: true,
    });
  }
  return pythonPath;
}

async function inspectAddon(source, destination, mode) {
  let destinationInfo;
  try {
    destinationInfo = await lstat(destination);
  } catch (error) {
    if (error?.code === "ENOENT") return { action: mode === "copy" ? "copy" : "link" };
    throw error;
  }

  if (destinationInfo.isSymbolicLink()) {
    let resolved;
    try {
      resolved = await realpath(destination);
    } catch (error) {
      throw new SetupError(`Addon link is broken and was left untouched: ${destination} (${error.message})`);
    }
    if (normalizeCase(resolved) !== normalizeCase(source)) {
      const rawTarget = await readlink(destination).catch(() => "unknown");
      throw new SetupError(
        `Addon path already links somewhere else (${rawTarget}). Remove or move it before setup: ${destination}`,
      );
    }
    if (mode === "copy") {
      throw new SetupError(`Addon is already linked. Remove it first if you intentionally want --copy: ${destination}`);
    }
    return { action: "none", detail: "existing link is correct" };
  }

  if (!destinationInfo.isDirectory()) {
    throw new SetupError(`Addon destination exists and is not a directory: ${destination}`);
  }
  const markerPath = path.join(destination, COPY_MARKER);
  const markerSource = await readOptional(markerPath);
  if (mode !== "copy" || markerSource === null) {
    throw new SetupError(
      `Addon destination already contains unmanaged content and was left untouched: ${destination}`,
    );
  }
  const marker = parseJsonObject(markerSource, markerPath);
  if (marker.managedBy !== SERVER_NAME || marker.mode !== "copy") {
    throw new SetupError(`Addon copy marker is not owned by ${SERVER_NAME}: ${markerPath}`);
  }
  return { action: "refresh-copy", detail: "refreshing managed copy without deleting unknown files" };
}

async function applyAddon(source, destination, mode, plan, { dryRun = false } = {}) {
  if (plan.action === "none") {
    console.log(`    addon: ${plan.detail}`);
    return;
  }
  const verb = plan.action === "link" ? "create link" : plan.action === "copy" ? "copy" : "refresh copy";
  console.log(`    ${dryRun ? "[dry-run] would " : ""}${verb}: ${destination}`);
  if (dryRun) return;

  await mkdir(path.dirname(destination), { recursive: true });
  if (plan.action === "link") {
    await symlink(source, destination, process.platform === "win32" ? "junction" : "dir");
    return;
  }

  await cp(source, destination, { recursive: true, force: true, errorOnExist: false });
  const marker = {
    schemaVersion: 1,
    managedBy: SERVER_NAME,
    mode: "copy",
    source,
  };
  await writeFile(path.join(destination, COPY_MARKER), `${JSON.stringify(marker, null, 2)}\n`, "utf8");
}

async function prepareProjectWrites(projectRoot, repoRoot, mode, pythonPath) {
  const projectFile = path.join(projectRoot, "project.godot");
  const mcpFile = path.join(projectRoot, ".mcp.json");
  const configFile = path.join(projectRoot, ".wazzicode-godot", "config.json");
  const gitignoreFile = path.join(projectRoot, ".gitignore");
  const guidanceFiles = [path.join(projectRoot, "AGENTS.md"), path.join(projectRoot, "CLAUDE.md")];
  const managedFiles = [projectFile, mcpFile, configFile, gitignoreFile, ...guidanceFiles];
  for (const file of managedFiles) await assertSafeManagedPath(projectRoot, file);

  const projectSource = await readFile(projectFile, "utf8");
  const writes = [
    {
      file: projectFile,
      label: "enable editor plugin",
      content: enablePluginInProjectGodot(projectSource),
      previous: projectSource,
    },
  ];

  const mcpSource = await readOptional(mcpFile);
  const existingMcp =
    mcpSource === null
      ? null
      : mcpSource.replace(/^\uFEFF/, "").trim() === ""
        ? {}
        : parseJsonObject(mcpSource, mcpFile);
  const mergedMcp = mergeMcpConfig(existingMcp, buildMcpEntry(repoRoot, pythonPath));
  writes.push({
    file: mcpFile,
    label: "merge project MCP entry",
    content: `${JSON.stringify(mergedMcp, null, 2)}\n`,
    previous: mcpSource,
  });

  for (const file of guidanceFiles) {
    const previous = await readOptional(file);
    writes.push({
      file,
      label: `update ${path.basename(file)} workflow guidance`,
      content: upsertMarkedBlock(previous ?? "", GUIDANCE_BEGIN, GUIDANCE_END, GUIDANCE_BLOCK),
      previous,
    });
  }

  const gitignoreSource = await readOptional(gitignoreFile);
  writes.push({
    file: gitignoreFile,
    label: "gitignore local runtime artifacts",
    content: upsertMarkedBlock(gitignoreSource ?? "", IGNORE_BEGIN, IGNORE_END, IGNORE_BLOCK),
    previous: gitignoreSource,
  });

  const configSource = await readOptional(configFile);
  const existingConfig = configSource === null ? {} : parseJsonObject(configSource, configFile);
  const config = {
    ...existingConfig,
    schemaVersion: 1,
    serverName: SERVER_NAME,
    projectRoot,
    repoRoot,
    venvPython: pythonPath,
    telemetryEnabled: false,
    addon: {
      mode,
      source: path.join(repoRoot, "plugin", "addons", "godot_ai"),
      destination: path.join(projectRoot, "addons", "godot_ai"),
    },
  };
  writes.push({
    file: configFile,
    label: "write .wazzicode-godot/config.json",
    content: `${JSON.stringify(config, null, 2)}\n`,
    previous: configSource,
  });
  return writes;
}

async function applyWrites(writes, { dryRun = false } = {}) {
  for (const item of writes) {
    if (item.previous === item.content) {
      console.log(`    unchanged: ${item.file}`);
      continue;
    }
    console.log(`    ${dryRun ? "[dry-run] would update" : "updated"}: ${item.file}`);
    if (dryRun) continue;
    await mkdir(path.dirname(item.file), { recursive: true });
    await writeFile(item.file, item.content, "utf8");
  }
}

/**
 * Programmatic entry point. `skipDependencies` is a test seam only; the CLI
 * always provisions and verifies the editable local venv.
 */
export async function runBootstrap({
  projectPath = null,
  startDirectory = process.cwd(),
  repoRoot = DEFAULT_REPO_ROOT,
  mode = "link",
  dryRun = false,
  skipDependencies = false,
  env = process.env,
} = {}) {
  if (!['link', 'copy'].includes(mode)) throw new SetupError(`Unsupported addon mode: ${mode}`);
  if (Number(process.versions.node.split(".")[0]) < MIN_NODE_MAJOR) {
    throw new SetupError(`Node ${MIN_NODE_MAJOR}+ is required (found ${process.versions.node})`);
  }

  const physicalRepoRoot = await realpath(path.resolve(repoRoot));
  const projectRoot = await resolveGodotProject(projectPath, startDirectory);
  if (normalizeCase(physicalRepoRoot) === normalizeCase(projectRoot)) {
    throw new SetupError(
      "Refusing to use the WazziCode server repository itself as the setup target. Pass a separate Godot project.",
    );
  }

  const addonSource = path.join(physicalRepoRoot, "plugin", "addons", "godot_ai");
  const addonDestination = path.join(projectRoot, "addons", "godot_ai");
  if (!(await isFile(path.join(addonSource, "plugin.cfg")))) {
    throw new SetupError(`Canonical Godot addon is missing: ${addonSource}`);
  }
  await assertSafeManagedPath(projectRoot, addonDestination, { allowExistingLink: true });

  const pythonPath = venvPythonPath(physicalRepoRoot);
  // Parse and validate all user-owned files before commands or project writes.
  const writes = await prepareProjectWrites(projectRoot, physicalRepoRoot, mode, pythonPath);
  const addonPlan = await inspectAddon(addonSource, addonDestination, mode);

  console.log(`WazziCode Godot setup${dryRun ? " (dry run)" : ""}`);
  console.log(`  repository: ${physicalRepoRoot}`);
  console.log(`  project:    ${projectRoot}`);
  console.log(`  addon mode: ${mode}`);

  console.log("\n[1/3] Local Python toolchain and editable dependencies");
  if (skipDependencies) {
    console.log("    skipped by programmatic test seam");
  } else {
    await ensureToolchain(physicalRepoRoot, { dryRun, env });
  }

  console.log("\n[2/3] Godot editor addon");
  await applyAddon(addonSource, addonDestination, mode, addonPlan, { dryRun });

  console.log("\n[3/3] Project configuration and agent guidance");
  await applyWrites(writes, { dryRun });

  if (!dryRun) {
    const nextSteps =
      mode === "copy"
        ? `  1. Start your MCP client from ${projectRoot} and approve ${SERVER_NAME}.
  2. Then open ${projectRoot} in Godot 4.5+ (restart the editor if it was open).
  3. Ask the client to call godot_orient; it should identify the project and report live readiness.`
        : `  1. Open ${projectRoot} in Godot 4.5+ (restart the editor if it was open).
  2. Start your MCP client from the project directory and approve ${SERVER_NAME}.
  3. Ask the client to call godot_orient; it should identify the project and report live readiness.`;
    console.log(`
WazziCode Godot setup complete.

Next:
${nextSteps}
`);
  }
  return { projectRoot, repoRoot: physicalRepoRoot, pythonPath, addonDestination, mode, dryRun };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(helpText());
    return;
  }
  await runBootstrap({
    projectPath: options.project,
    mode: options.mode,
    dryRun: options.dryRun,
  });
}

if (path.resolve(process.argv[1] ?? "") === path.resolve(BOOTSTRAP_FILE)) {
  main().catch((error) => {
    const message = error instanceof SetupError ? error.message : error?.stack ?? String(error);
    console.error(`\nSetup failed: ${message}`);
    process.exitCode = 1;
  });
}
