import { existsSync, promises as fs } from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { DEFAULT_BRIDGE_HOST, DEFAULT_BRIDGE_PORT, PRODUCT_NAME, PRODUCT_VERSION } from "@gvibe/core";
import { createHttpBridgeClient, readBridgeDiscovery, redactBridgeDiscovery, type PublicBridgeDiscovery } from "@gvibe/bridge-client";
import { inspectBrainFreshness, type BrainFreshnessReason } from "@gvibe/project-brain";
import { resolveProjectPath } from "@gvibe/safety";
import type { CommandResult, GlobalOptions } from "../options.js";
import { ADDON_PLUGIN_PATH, isAddonEnabledInProjectFile, isRuntimeProbeAutoloadConfigured } from "./installAddon.js";

export interface DoctorReport {
  product: { name: string; version: string };
  project: { path: string; valid: boolean; name?: string };
  config: { exists: boolean; path: string };
  godotAddon: { detected: boolean; enabled: boolean; runtimeProbeConfigured: boolean; path?: string };
  bridge: { reachable: boolean; state: "connected" | "not_connected" | "mock"; host: string; port: number; discovery?: PublicBridgeDiscovery; error?: string };
  brain: { exists: boolean; stale: boolean; reason: BrainFreshnessReason; ageMs?: number };
  git: { isRepo: boolean; clean?: boolean };
  ok: boolean;
  suggestions: string[];
}

export async function runDoctor(options: GlobalOptions): Promise<CommandResult> { const report = await collectDoctorReport(options.project, { mock: options.mock }); return options.json ? { exitCode: report.ok ? 0 : 1, stdout: JSON.stringify(report, null, 2) + "\n" } : { exitCode: report.ok ? 0 : 1, stdout: formatDoctorReport(report) }; }
export async function collectDoctorReport(projectPath: string, options: { mock?: boolean } = {}): Promise<DoctorReport> {
  let projectText = ""; let valid = false; try { const projectFile = (await resolveProjectPath(projectPath, "project.godot")).absolute; projectText = await fs.readFile(projectFile, "utf8"); valid = true; } catch { /* Unsafe or missing project files are not valid projects. */ } const name = /config\/name\s*=\s*"([^"]+)"/.exec(projectText)?.[1];
  const configPath = path.join(projectPath, ".godot-vibe", "config.json"); const addonPath = path.join(projectPath, "addons", "godot_vibe_os", "plugin.cfg"); const probePath = path.join(projectPath, "addons", "godot_vibe_os", "runtime_probe.gd"); const addonDetected = existsSync(addonPath); const addonEnabled = isAddonEnabledInProjectFile(projectText, ADDON_PLUGIN_PATH); const runtimeProbeConfigured = existsSync(probePath) && isRuntimeProbeAutoloadConfigured(projectText);
  const rawDiscovery = options.mock ? null : readBridgeDiscovery(projectPath); const discovery = redactBridgeDiscovery(rawDiscovery); const host = discovery?.host ?? DEFAULT_BRIDGE_HOST; const port = discovery?.port ?? DEFAULT_BRIDGE_PORT;
  let reachable = false; let error: string | undefined; if (!options.mock) { const response = await createHttpBridgeClient({ projectPath, timeoutMs: 2_000 }).call("system.health"); reachable = response.ok; if (!response.ok) error = response.error.message; }
  const brain = await inspectBrainFreshness(projectPath); const git = await gitStatus(projectPath);
  const suggestions: string[] = []; if (!valid) suggestions.push("Point --project at a directory containing project.godot."); if (valid && !existsSync(configPath)) suggestions.push("Run `gvibe init`."); if (valid && !addonDetected) suggestions.push("Run `gvibe install-addon`."); else if (addonDetected && !addonEnabled) suggestions.push("Enable Godot Vibe OS in Project > Project Settings > Plugins."); if (addonDetected && !runtimeProbeConfigured) suggestions.push("Re-run `gvibe install-addon` to configure FoundryRuntimeProbe."); if (addonEnabled && !reachable && !options.mock) suggestions.push("Open this project in Godot and wait for addon discovery."); if (!brain.exists) suggestions.push("Run `gvibe brain`."); else if (brain.stale) suggestions.push("Run `gvibe brain --ensure`.");
  const ok = valid && existsSync(configPath) && addonDetected && addonEnabled && runtimeProbeConfigured && (reachable || options.mock === true) && brain.exists && !brain.stale;
  return { product: { name: PRODUCT_NAME, version: PRODUCT_VERSION }, project: { path: projectPath, valid, name }, config: { exists: existsSync(configPath), path: configPath }, godotAddon: { detected: addonDetected, enabled: addonEnabled, runtimeProbeConfigured, path: addonDetected ? addonPath : undefined }, bridge: { reachable, state: options.mock ? "mock" : reachable ? "connected" : "not_connected", host, port, discovery: discovery ?? undefined, error }, brain, git, ok, suggestions };
}
export function formatDoctorReport(report: DoctorReport): string { const mark = (value: boolean) => value ? "✓" : "·"; const addonReady = report.godotAddon.detected && report.godotAddon.enabled && report.godotAddon.runtimeProbeConfigured; const addonDetail = !report.godotAddon.detected ? "missing" : !report.godotAddon.enabled ? "installed, not enabled" : report.godotAddon.runtimeProbeConfigured ? "installed + enabled + runtime probe" : "installed + enabled, runtime probe missing"; return [`${report.product.name} — Doctor (v${report.product.version})`, "", `Godot project: ${mark(report.project.valid)} ${report.project.name ?? report.project.path}`, `Config:        ${mark(report.config.exists)} ${report.config.path}`, `Editor addon:  ${mark(addonReady)} ${addonDetail}`, `Bridge:        ${mark(report.bridge.reachable)} ${report.bridge.state} at ${report.bridge.host}:${report.bridge.port}`, `Project map:   ${mark(report.brain.exists && !report.brain.stale)} ${report.brain.exists ? report.brain.stale ? "stale" : "current" : "missing"}`, `Git:           ${mark(report.git.isRepo)} ${report.git.isRepo ? report.git.clean ? "clean" : "dirty" : "not a repository"}`, "", ...(report.suggestions.length ? ["Next:", ...report.suggestions.map((value) => `  - ${value}`)] : ["Ready."])].join("\n") + "\n"; }
function gitStatus(cwd: string): Promise<{ isRepo: boolean; clean?: boolean }> { return new Promise((resolve) => execFile("git", ["-C", cwd, "status", "--porcelain"], { encoding: "utf8" }, (error, stdout) => resolve(error ? { isRepo: false } : { isRepo: true, clean: stdout.trim().length === 0 }))); }
