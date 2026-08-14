import { promises as fs } from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { z, type ZodRawShape } from "zod";
import { BRIDGE_DISCOVERY_REL, PRODUCT_VERSION, PROTOCOL_VERSION, type BridgeResponse, type ToolEnvelope } from "@gvibe/core";
import { readBridgeDiscovery, redactBridgeDiscovery } from "@gvibe/bridge-client";
import { resolveProjectPath } from "@gvibe/safety";
import {
  brainQueryDefaultLimit,
  ensureBrainCurrent,
  generateBrain,
  queryBrain,
  readKnowledgeBase,
  type BrainGenerationResult,
  type KnowledgeEntityKind,
} from "@gvibe/project-brain";
import type { AnyToolDef, ToolDef } from "../registry.js";
import { executeTool } from "../execute.js";
import { projectBrainQuery, projectKnowledgeManifest } from "../knowledgeProjection.js";
import { BRIDGE_METHODS, bridgeCall, err, ok, timed } from "./_helpers.js";

const EmptyShape = {};
const ADDON_PLUGIN_PATH = "res://addons/godot_vibe_os/plugin.cfg";
const RUNTIME_PROBE_AUTOLOAD_NAME = "FoundryRuntimeProbe";
const RUNTIME_PROBE_PATH = "res://addons/godot_vibe_os/runtime_probe.gd";

export const godotDiagnoseConnection: ToolDef<typeof EmptyShape, unknown> = {
  name: "godot_diagnose_connection",
  description: "Diagnoses the complete MCP-to-Godot path: project/addon presence, plugin and runtime-probe config, authenticated discovery, protocol, health, RPC, and project identity.",
  requires: ["godot_bridge", "filesystem"],
  inputShape: EmptyShape,
  async run(_args, ctx) {
    const addonPath = path.join(ctx.projectPath, "addons", "godot_vibe_os", "plugin.cfg");
    let projectFile: string | null = null;
    try { projectFile = (await resolveProjectPath(ctx.projectPath, "project.godot")).absolute; } catch { /* Unsafe project files are not valid projects. */ }
    const runtimeProbePath = path.join(ctx.projectPath, "addons", "godot_vibe_os", "runtime_probe.gd");
    const [projectExists, addonExists, runtimeProbeExists, enabledText, health, rpc] = await Promise.all([
      projectFile ? exists(projectFile) : false, exists(addonPath), exists(runtimeProbePath), projectFile ? fs.readFile(projectFile, "utf8").catch(() => "") : "",
      (ctx.bridge.health?.() ?? Promise.resolve(null)).catch(() => null),
      ctx.bridge.call(BRIDGE_METHODS.systemHealth).catch((error): BridgeResponse => ({
        id: "diagnose",
        ok: false,
        result: null,
        error: { code: "GODOT_NOT_CONNECTED", message: error instanceof Error ? error.message : String(error) },
        meta: {},
      })),
    ]);
    const rawDiscovery = readBridgeDiscovery(ctx.projectPath);
    const discovery = redactBridgeDiscovery(rawDiscovery);
    const enabled = isEditorPluginEnabled(enabledText, ADDON_PLUGIN_PATH);
    const runtimeProbeConfigured = runtimeProbeExists && isRuntimeProbeEnabled(enabledText);
    const findings: string[] = [];
    if (!projectExists) findings.push("project.godot is missing.");
    if (!addonExists) findings.push("addons/godot_vibe_os/plugin.cfg is missing.");
    if (addonExists && !enabled) findings.push("The addon is installed but is not listed in [editor_plugins].");
    if (addonExists && !runtimeProbeConfigured) findings.push("FoundryRuntimeProbe is missing or is not configured in [autoload].");
    if (!discovery) findings.push(`No ${BRIDGE_DISCOVERY_REL} discovery file exists.`);
    else if (discovery.protocolVersion !== PROTOCOL_VERSION) findings.push(`Bridge protocol ${discovery.protocolVersion} does not match ${PROTOCOL_VERSION}.`);
    if (!health) findings.push("Bridge health check failed.");
    if (health?.projectPath && path.resolve(health.projectPath) !== path.resolve(ctx.projectPath)) findings.push(`Godot serves '${health.projectPath}', not '${ctx.projectPath}'.`);
    if (!rpc.ok) findings.push(`Bridge RPC check failed: ${rpc.error.code} — ${rpc.error.message}`);
    const state = health && rpc.ok ? "connected" : health ? "reloading" : "not_connected";
    const passed = findings.length === 0;
    if (passed) findings.push("Addon installation, runtime probe, authentication, protocol, identity, health, and RPC checks passed.");
    return ok({ state, server: { version: PRODUCT_VERSION, protocolVersion: PROTOCOL_VERSION, projectPath: ctx.projectPath }, project: { valid: projectExists }, godotAddon: { detected: addonExists, enabled, runtimeProbeConfigured, path: addonExists ? addonPath : undefined }, discovery, health, rpc: rpc.ok ? { ok: true } : { ok: false, error: rpc.error }, findings, nextAction: nextConnectionAction(projectExists, addonExists, enabled, runtimeProbeConfigured, state) }, { source: ctx.bridge.source, durationMs: 0 }, passed ? [] : findings);
  },
};

const OrientShape = { task: z.string().min(1).max(1_000).optional() };
export const godotOrient: ToolDef<typeof OrientShape, unknown> = {
  name: "godot_orient",
  description: "One-call session bootstrap: live Godot identity, open scenes, selection, import state, play state, git status, project-map freshness, and task-relevant project knowledge.",
  requires: ["godot_bridge", "filesystem", "git", "project_brain"],
  inputShape: OrientShape,
  async run(args, ctx) {
    const section = (label: string, env: ToolEnvelope<unknown>, warnings: string[]) => { if (env.ok) return env.data; warnings.push(`${label}: ${env.error.code}`); return { unavailable: env.error.code }; };
    const warnings: string[] = [];
    const knowledge = (async () => { await ensureBrainCurrent(ctx.projectPath); const base = await readKnowledgeBase(ctx.projectPath); if (!base) throw new Error("project map unavailable"); const relevant = args.task ? await queryBrain(ctx.projectPath, { query: args.task, limit: 6 }) : undefined; return { exists: true, ageMs: Date.now() - base.manifest.generatedAt, stale: base.manifest.dirty.value, manifest: projectKnowledgeManifest(base.manifest), relevant: relevant ? projectBrainQuery(relevant, { knowledge: base, queryLimit: 6 }) : undefined }; })().catch((error) => ({ exists: false, unavailable: error instanceof Error ? error.message : String(error) }));
    const [summary, scenes, selection, filesystem, playing, git, brain] = await Promise.all([
      bridgeCall(ctx.bridge, BRIDGE_METHODS.systemSummary), bridgeCall(ctx.bridge, BRIDGE_METHODS.sceneGetOpenScenes),
      bridgeCall(ctx.bridge, BRIDGE_METHODS.selectionInspect, { includeProperties: false }), bridgeCall(ctx.bridge, BRIDGE_METHODS.filesystemStatus),
      bridgeCall(ctx.bridge, BRIDGE_METHODS.playStatus), runGitStatus(ctx.projectPath), knowledge,
    ]);
    if (!summary.ok) warnings.push("Godot bridge is not reachable; open this project in the editor with the addon enabled.");
    if (!brain.exists) warnings.push(`Project map unavailable: ${"unavailable" in brain ? brain.unavailable : "unknown error"}`);
    return ok({ bridgeReachable: summary.ok, summary: section("summary", summary, warnings), openScenes: section("openScenes", scenes, warnings), selection: section("selection", selection, warnings), filesystem: section("filesystem", filesystem, warnings), play: section("play", playing, warnings), git, brain }, { source: ctx.bridge.source, durationMs: 0 }, warnings);
  },
};

const BrainShape = { write: z.boolean().optional(), detailLevel: z.enum(["summary", "normal", "full"]).optional() };
export const godotGenerateProjectBrain: ToolDef<typeof BrainShape, BrainGenerationResult> = {
  name: "godot_generate_project_brain",
  description: "Rebuilds the bounded, source-backed Godot project map: project settings, addons, scenes, resources, GDScript classes/signals/exports/functions, shaders, and dependency relationships.",
  requires: ["filesystem", "project_brain"],
  inputShape: BrainShape,
  async run(args, ctx) { try { const { result, durationMs } = await timed(() => generateBrain({ projectPath: ctx.projectPath, write: args.write ?? true })); return ok(result, { source: "project_brain", durationMs, detailLevel: args.detailLevel, projectPath: ctx.projectPath }); } catch (error) { return err("INTERNAL_ERROR", `Project-map generation failed: ${error instanceof Error ? error.message : String(error)}`, { source: "project_brain" }); } },
};

const ENTITY_KINDS = ["project", "addon", "scene", "resource", "script", "class", "module", "shader"] as const;
const QueryShape = { query: z.string().min(1).max(2_000), kinds: z.array(z.enum(ENTITY_KINDS)).optional(), limit: z.number().int().min(1).max(20).optional() };
export const godotQueryProjectBrain: ToolDef<typeof QueryShape, unknown> = {
  name: "godot_query_project_brain",
  description: "Answers one focused Godot architecture, ownership, class, signal, scene, resource, addon, or dependency question from a maintained provenance-bearing project map.",
  requires: ["filesystem", "project_brain"],
  inputShape: QueryShape,
  async run(args, ctx) { try { const { result, durationMs } = await timed(async () => { const limit = args.limit ?? brainQueryDefaultLimit(args.query); await ensureBrainCurrent(ctx.projectPath); const [query, knowledge] = await Promise.all([queryBrain(ctx.projectPath, { query: args.query, kinds: args.kinds as KnowledgeEntityKind[] | undefined, limit }), readKnowledgeBase(ctx.projectPath)]); if (!knowledge) throw new Error("project map unavailable after refresh"); return { result: projectBrainQuery(query, { knowledge, queryLimit: limit }), manifest: projectKnowledgeManifest(knowledge.manifest) }; }); return ok(result, { source: "project_brain", durationMs, projectPath: ctx.projectPath }); } catch (error) { return err("INTERNAL_ERROR", `Project-map query failed: ${error instanceof Error ? error.message : String(error)}`, { source: "project_brain" }); } },
};

const BatchShape = { operations: z.array(z.object({ tool: z.string(), args: z.record(z.string(), z.unknown()).optional() })).min(1).max(50), stopOnError: z.boolean().optional() };
export const godotBatch: ToolDef<typeof BatchShape, unknown> = {
  name: "godot_batch",
  description: "Runs an ordered Godot tool plan in one round trip. Every nested write still passes through the same safety gate, snapshot, and action log.",
  requires: ["godot_bridge"],
  inputShape: BatchShape,
  async run(args, ctx) {
    const results: Array<Record<string, unknown>> = []; let allOk = true;
    for (let index = 0; index < args.operations.length; index++) { const op = args.operations[index]; if (op.tool === "godot_batch") { allOk = false; results.push({ index, tool: op.tool, ok: false, error: { code: "INVALID_ARGUMENT", message: "godot_batch cannot be nested." } }); if (args.stopOnError ?? true) break; continue; } const tool = (ctx.tools ?? []).find((candidate) => candidate.name === op.tool); if (!tool) { allOk = false; results.push({ index, tool: op.tool, ok: false, error: { code: "INVALID_ARGUMENT", message: `Unknown tool '${op.tool}'.` } }); if (args.stopOnError ?? true) break; continue; } let parsed: Record<string, unknown>; try { parsed = z.object(tool.inputShape as ZodRawShape).parse(op.args ?? {}); } catch (error) { allOk = false; results.push({ index, tool: op.tool, ok: false, error: { code: "INVALID_ARGUMENT", message: error instanceof Error ? error.message : String(error) } }); if (args.stopOnError ?? true) break; continue; } const env = await executeTool(tool as AnyToolDef, parsed, ctx); results.push(env.ok ? { index, tool: op.tool, ok: true, data: env.data } : { index, tool: op.tool, ok: false, error: env.error }); if (!env.ok) { allOk = false; if (args.stopOnError ?? true) break; } }
    return ok({ allOk, ranCount: results.length, total: args.operations.length, results }, { source: ctx.bridge.source, durationMs: 0 }, allOk ? [] : ["One or more batch operations failed."]);
  },
};

function exists(file: string): Promise<boolean> { return fs.access(file).then(() => true, () => false); }
function isEditorPluginEnabled(contents: string, pluginPath: string): boolean {
  const section = /^[ \t]*\[editor_plugins\][ \t]*(?:[;#].*)?\r?$/m.exec(contents);
  if (!section) return false;
  let start = section.index + section[0].length;
  if (contents[start] === "\n") start += 1;
  const next = /^[ \t]*\[[^\]\r\n]+\][ \t]*(?:[;#].*)?\r?$/gm;
  next.lastIndex = start;
  const body = contents.slice(start, next.exec(contents)?.index ?? contents.length);
  const enabled = /^[ \t]*enabled[ \t]*=[ \t]*PackedStringArray[ \t]*\(([^)\r\n]*)\)[ \t]*(?:[;#].*)?\r?$/m.exec(body);
  if (!enabled) return false;
  for (const match of enabled[1].matchAll(/"(?:\\.|[^"\\])*"/g)) {
    try { if (JSON.parse(match[0]) === pluginPath) return true; } catch { /* malformed entries are not enabled plugins */ }
  }
  return false;
}
function isRuntimeProbeEnabled(contents: string): boolean {
  const section = /^[ \t]*\[autoload\][ \t]*(?:[;#].*)?\r?$/m.exec(contents);
  if (!section) return false;
  let start = section.index + section[0].length;
  if (contents[start] === "\n") start += 1;
  const next = /^[ \t]*\[[^\]\r\n]+\][ \t]*(?:[;#].*)?\r?$/gm;
  next.lastIndex = start;
  const body = contents.slice(start, next.exec(contents)?.index ?? contents.length);
  const assignment = new RegExp(`^[ \\t]*${RUNTIME_PROBE_AUTOLOAD_NAME}[ \\t]*=[ \\t]*(.+?)[ \\t]*(?:[;#].*)?\\r?$`, "m").exec(body);
  if (!assignment) return false;
  try { return JSON.parse(assignment[1]) === `*${RUNTIME_PROBE_PATH}`; } catch { return false; }
}
function nextConnectionAction(project: boolean, addon: boolean, enabled: boolean, runtimeProbeConfigured: boolean, state: string): string { if (!project) return "Point GVIBE_PROJECT at a directory containing project.godot."; if (!addon) return "Run gvibe install-addon, then open the project in Godot."; if (!enabled) return "Enable Godot Vibe OS under Project > Project Settings > Plugins."; if (!runtimeProbeConfigured) return "Re-run gvibe install-addon to configure FoundryRuntimeProbe, then restart Godot."; if (state !== "connected") return "Open this project in Godot and wait for addon discovery."; return "No connection repair is needed."; }
function runGitStatus(cwd: string): Promise<unknown> { return new Promise((resolve) => execFile("git", ["-C", cwd, "status", "--porcelain=v1", "--branch"], { encoding: "utf8" }, (error, stdout) => { if (error) { resolve({ isGitRepo: false }); return; } const lines = stdout.split(/\r?\n/).filter(Boolean); resolve({ isGitRepo: true, branch: lines[0]?.replace(/^## /, "") ?? "", clean: lines.length === 1, changes: lines.slice(1, 101) }); })); }
