import { promises as fs } from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import {
  PRODUCT_NAME,
  PRODUCT_VERSION,
  DEFAULT_BRIDGE_HOST,
  DEFAULT_BRIDGE_PORT,
} from "@uvibe/core";
import { createHttpBridgeClient, readBridgeDiscovery } from "@uvibe/bridge-client";
import { loadConfig } from "@uvibe/safety";
import { brainAgeMs } from "@uvibe/project-brain";
import { CommandResult, GlobalOptions } from "../options.js";

export interface DoctorReport {
  product: { name: string; version: string };
  projectPath: string;
  config: {
    path: string;
    exists: boolean;
    safetyMode: string;
    mockMode: boolean;
  };
  unityProject: {
    detected: boolean;
    unityVersion?: string;
  };
  unityPackage: {
    detectedAt?: string;
    manifestRef?: string;
    detected: boolean;
  };
  bridge: {
    host: string;
    port: number;
    reachable: boolean;
    error?: string;
    /** Editor loop frozen (unfocused + not ticking) while the bridge socket still answers. */
    editorStalled?: boolean;
    editorTickAgeMs?: number;
    /** Undefined when the Unity package predates the keep-awake driver. */
    keepAwakeEnabled?: boolean;
  };
  git: {
    isRepo: boolean;
    branch?: string;
    clean?: boolean;
    available: boolean;
  };
  brain: {
    exists: boolean;
    ageMs?: number;
  };
  suggestions: string[];
}

export async function runDoctor(g: GlobalOptions): Promise<CommandResult> {
  const report = await collectDoctorReport(g.project, { mock: g.mock });
  if (g.json) {
    return { exitCode: 0, stdout: JSON.stringify(report, null, 2) + "\n" };
  }
  return { exitCode: 0, stdout: formatDoctorReport(report) };
}

export async function collectDoctorReport(
  projectPath: string,
  opts: { mock?: boolean } = {}
): Promise<DoctorReport> {
  const cfg = await loadConfig(projectPath);
  const cfgPath = path.join(projectPath, ".unity-vibe", "config.json");
  const cfgExists = await fileExists(cfgPath);

  const unityVersionPath = path.join(projectPath, "ProjectSettings", "ProjectVersion.txt");
  let unityVersion: string | undefined;
  let unityProjectDetected = false;
  if (await fileExists(unityVersionPath)) {
    unityProjectDetected = true;
    const txt = await fs.readFile(unityVersionPath, "utf8");
    const m = /m_EditorVersion:\s*(\S+)/.exec(txt);
    if (m) unityVersion = m[1];
  }

  const candidates = [
    path.join(projectPath, "unity", "UnityVibeOS"),
    path.join(projectPath, "Packages", "com.uvibe.os"),
    path.join(projectPath, "Assets", "UnityVibeOS"),
  ];
  let unityPackageAt: string | undefined;
  for (const c of candidates) {
    if (await fileExists(path.join(c, "package.json"))) {
      unityPackageAt = c;
      break;
    }
  }

  // The default install mode adds `com.uvibe.os` to Packages/manifest.json as a
  // `file:` reference (Unity resolves/imports it lazily). That's a successful
  // install even though there's no package.json under the project tree, so the
  // on-disk probe above misses it. Read the manifest too.
  let unityPackageManifestRef: string | undefined;
  const manifestPath = path.join(projectPath, "Packages", "manifest.json");
  if (await fileExists(manifestPath)) {
    try {
      const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8")) as {
        dependencies?: Record<string, string>;
      };
      const dep = manifest.dependencies?.["com.uvibe.os"];
      if (typeof dep === "string") unityPackageManifestRef = dep;
    } catch {
      // Malformed manifest — leave undefined; doctor still reports other facts.
    }
  }
  const unityPackageDetected = Boolean(unityPackageAt || unityPackageManifestRef);

  // In mock mode the diagnostic must be deterministic and must not report a
  // real Unity Editor that happens to be running for some *other* project as
  // this project's bridge. Skip the network probe entirely.
  //
  // Otherwise probe through the real bridge client so doctor honors port
  // discovery (Library/UnityVibeOS/bridge.json — Unity may bind a fallback
  // port when 38578 is taken) and the project-identity guard, exactly like
  // the MCP server does at runtime.
  const disco = opts.mock ? null : readBridgeDiscovery(projectPath);
  const bridgeHost = disco?.host ?? DEFAULT_BRIDGE_HOST;
  const bridgePort = disco?.port ?? DEFAULT_BRIDGE_PORT;
  const bridge = opts.mock
    ? { reachable: false, error: "mock mode (real bridge probe skipped)" }
    : await probeBridge(projectPath);
  const git = await probeGit(projectPath);
  const ageMs = await brainAgeMs(projectPath);

  const suggestions: string[] = [];
  if (!cfgExists) suggestions.push("Run `uvibe init` to create `.unity-vibe/config.json`.");
  if (!unityProjectDetected)
    suggestions.push("Project does not look like a Unity project (no ProjectSettings/ProjectVersion.txt). Pass --project=<unity-dir> if running from a different directory.");
  if (!unityPackageDetected)
    suggestions.push(
      "Install the UnityVibeOS Editor package in your Unity project (`uvibe install-unity-package`) so the bridge can run."
    );
  if (!bridge.reachable)
    suggestions.push(
      `Open Unity Editor with the UnityVibeOS package installed; the bridge auto-starts at ${bridgeHost}:${bridgePort}.`
    );
  if (bridge.editorStalled)
    suggestions.push(
      "Unity's editor loop is frozen in the background — focus the Unity window, and enable Window ▸ Unity Vibe OS ▸ Keep Unity awake (background) so tool calls keep running unfocused."
    );
  if (bridge.reachable && bridge.keepAwakeEnabled === false)
    suggestions.push(
      "'Keep Unity awake (background)' is OFF — Unity will stop processing tool calls whenever its window loses focus. Enable it under Window ▸ Unity Vibe OS."
    );
  if (bridge.reachable && bridge.keepAwakeEnabled === undefined && !cfg.mockMode)
    suggestions.push(
      "The UnityVibeOS package in Unity predates the background keep-awake driver — update it (`uvibe install-unity-package`) or tool calls will hang while Unity is unfocused."
    );
  if (ageMs === null) suggestions.push("Run `uvibe brain` to generate the project brain.");
  if (!git.isRepo) suggestions.push("Initialize git in the project so write tools can snapshot before edits.");

  return {
    product: { name: PRODUCT_NAME, version: PRODUCT_VERSION },
    projectPath,
    config: { path: cfgPath, exists: cfgExists, safetyMode: cfg.safetyMode, mockMode: cfg.mockMode },
    unityProject: { detected: unityProjectDetected, unityVersion },
    unityPackage: { detectedAt: unityPackageAt, manifestRef: unityPackageManifestRef, detected: unityPackageDetected },
    bridge: { host: bridgeHost, port: bridgePort, reachable: bridge.reachable, error: bridge.error },
    git,
    brain: { exists: ageMs !== null, ageMs: ageMs ?? undefined },
    suggestions,
  };
}

export function formatDoctorReport(r: DoctorReport): string {
  const lines: string[] = [];
  const tick = (b: boolean) => (b ? "✓" : "·");
  lines.push(`${r.product.name} — Doctor (v${r.product.version})`);
  lines.push("");
  lines.push(`Project:        ${r.projectPath}`);
  lines.push(`Config:         ${r.config.exists ? r.config.path : "(missing — run `uvibe init`)"}`);
  if (r.config.exists) lines.push(`                safetyMode=${r.config.safetyMode}  mockMode=${r.config.mockMode}`);
  lines.push("");
  lines.push(`Unity project:  ${tick(r.unityProject.detected)} ${r.unityProject.detected ? `version ${r.unityProject.unityVersion ?? "(unknown)"}` : "(not detected)"}`);
  const pkgWhere = r.unityPackage.detectedAt
    ? r.unityPackage.detectedAt
    : r.unityPackage.manifestRef
      ? `Packages/manifest.json → ${r.unityPackage.manifestRef} (pending Unity import)`
      : "(not detected)";
  lines.push(`Unity package:  ${tick(r.unityPackage.detected)} ${pkgWhere}`);
  let bridgeLine: string;
  if (!r.bridge.reachable) {
    bridgeLine = `unreachable on ${r.bridge.host}:${r.bridge.port}${r.bridge.error ? ` (${r.bridge.error})` : ""}`;
  } else {
    bridgeLine = `${r.bridge.host}:${r.bridge.port}`;
    if (r.bridge.editorStalled) bridgeLine += `  ⚠ editor loop FROZEN (no tick for ${Math.round((r.bridge.editorTickAgeMs ?? 0) / 1000)}s — focus Unity)`;
    if (r.bridge.keepAwakeEnabled === false) bridgeLine += "  ⚠ keep-awake OFF";
  }
  lines.push(`Unity bridge:   ${tick(r.bridge.reachable && !r.bridge.editorStalled)} ${bridgeLine}`);
  lines.push(`Git:            ${tick(r.git.isRepo)} ${r.git.isRepo ? `${r.git.branch ?? "(detached)"} — ${r.git.clean ? "clean" : "dirty"}` : r.git.available ? "(not a repo)" : "(git unavailable)"}`);
  lines.push(`Brain:          ${tick(r.brain.exists)} ${r.brain.exists ? `${formatAge(r.brain.ageMs!)} old` : "(missing — run `uvibe brain`)"}`);
  if (r.suggestions.length) {
    lines.push("");
    lines.push("Suggestions:");
    for (const s of r.suggestions) lines.push(`  • ${s}`);
  }
  return lines.join("\n") + "\n";
}

async function probeBridge(projectPath: string): Promise<Omit<DoctorReport["bridge"], "host" | "port">> {
  // The client resolves the real port from bridge.json (falling back to the default),
  // and rejects an Editor running a different project (PROJECT_IDENTITY_MISMATCH).
  const client = createHttpBridgeClient({ projectPath, timeoutMs: 1500 });
  const res = await client.call("system.health");
  // GET /health is served off Unity's main thread, so it answers even when the editor loop is
  // frozen — it both enriches a healthy report and explains an RPC timeout.
  const health = await client.health?.();
  const liveness = health
    ? {
        editorTickAgeMs: health.editorTickAgeMs,
        keepAwakeEnabled: health.keepAwakeEnabled,
        editorStalled:
          typeof health.editorTickAgeMs === "number" &&
          health.editorTickAgeMs > 5_000 &&
          health.wasFocused === false,
      }
    : {};
  if (res.ok) return { reachable: true, ...liveness };
  if (health && res.error.code === "BRIDGE_TIMEOUT") {
    // Socket answers but the RPC timed out — the Editor main thread is wedged, not absent.
    // Other errors (e.g. PROJECT_IDENTITY_MISMATCH) are definitive verdicts; keep them.
    return { reachable: true, error: `${res.error.code}: ${res.error.message}`, ...liveness };
  }
  return { reachable: false, error: `${res.error.code}: ${res.error.message}` };
}

async function probeGit(cwd: string): Promise<DoctorReport["git"]> {
  return new Promise((resolve) => {
    // First, is this a working tree at all?
    execFile("git", ["-C", cwd, "rev-parse", "--is-inside-work-tree"], { encoding: "utf8" }, (e, out) => {
      if (e) {
        const code = (e as NodeJS.ErrnoException).code ?? "";
        if (code === "ENOENT") return resolve({ isRepo: false, available: false });
        return resolve({ isRepo: false, available: true });
      }
      if (out.trim() !== "true") return resolve({ isRepo: false, available: true });
      // Branch may fail on a fresh repo with no commits; that's still a repo.
      execFile("git", ["-C", cwd, "branch", "--show-current"], { encoding: "utf8" }, (e2, branchOut) => {
        const branch = !e2 ? branchOut.trim() || undefined : undefined;
        execFile("git", ["-C", cwd, "status", "--porcelain"], { encoding: "utf8" }, (e3, statusOut) => {
          const clean = !e3 ? statusOut.trim().length === 0 : undefined;
          resolve({ isRepo: true, branch, clean, available: true });
        });
      });
    });
  });
}

function formatAge(ms: number): string {
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`;
  if (ms < 86_400_000) return `${Math.round(ms / 3_600_000)}h`;
  return `${Math.round(ms / 86_400_000)}d`;
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}
