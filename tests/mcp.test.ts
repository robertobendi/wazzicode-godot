import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BRIDGE_DISCOVERY_REL, BRIDGE_METHODS, PROTOCOL_VERSION, type BridgeHealth, type BridgeMethod, type BridgeResponse } from "@gvibe/core";
import type { BridgeClient } from "@gvibe/bridge-client";
import {
  SERVER_INSTRUCTIONS,
  allTools,
  buildContext,
  createMockBridgeClient,
  readConventionsResource,
  toolAnnotations,
} from "@gvibe/mcp-server";
import { GVibeConfigSchema, listSnapshots, readActions, writeConfig } from "@gvibe/safety";
import { executeTool } from "../packages/mcp-server/src/execute.js";
import { godotBatch, godotDiagnoseConnection } from "../packages/mcp-server/src/tools/godotComposite.js";
import { godotCapture2DView, godotGetSceneTree } from "../packages/mcp-server/src/tools/godotBridge.js";

const temporaryProjects: string[] = [];
const DIAGNOSTIC_TOKEN = "diagnostic-token-that-must-never-leak-1234567890";

afterEach(async () => {
  await Promise.all(temporaryProjects.splice(0).map((project) => rm(project, { recursive: true, force: true })));
});

async function project(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "gvibe-mcp-test-"));
  temporaryProjects.push(root);
  return root;
}

async function diagnosticProject(enabled = true, runtimeProbeConfigured = true): Promise<string> {
  const root = await project();
  await writeFile(path.join(root, "project.godot"), [
    "config_version=5",
    "",
    "[editor_plugins]",
    `${enabled ? "" : "; "}enabled=PackedStringArray(\"res://addons/godot_vibe_os/plugin.cfg\")`,
    "",
    ...(runtimeProbeConfigured ? ["[autoload]", "", 'FoundryRuntimeProbe="*res://addons/godot_vibe_os/runtime_probe.gd"', ""] : []),
  ].join("\n"), "utf8");
  await mkdir(path.join(root, "addons", "godot_vibe_os"), { recursive: true });
  await writeFile(path.join(root, "addons", "godot_vibe_os", "plugin.cfg"), "[plugin]\n", "utf8");
  await writeFile(path.join(root, "addons", "godot_vibe_os", "runtime_probe.gd"), "extends Node\n", "utf8");
  const discovery = path.join(root, BRIDGE_DISCOVERY_REL);
  await mkdir(path.dirname(discovery), { recursive: true });
  await writeFile(discovery, JSON.stringify({
    host: "127.0.0.1",
    port: 38588,
    projectPath: root,
    godotVersion: "4.7.1",
    pid: process.pid,
    protocolVersion: PROTOCOL_VERSION,
    startedAt: Date.now(),
    token: DIAGNOSTIC_TOKEN,
  }), "utf8");
  return root;
}

function diagnosticBridge(projectPath: string, health: BridgeHealth | null, rpcOk: boolean): BridgeClient {
  return {
    source: "godot_bridge",
    async call<T>(): Promise<BridgeResponse<T>> {
      if (!rpcOk) return { id: "test", ok: false, result: null, error: { code: "GODOT_RELOADING", message: "RPC unavailable" }, meta: {} };
      return { id: "test", ok: true, result: health as T, error: null, meta: { godotVersion: "4.7.1", projectPath, durationMs: 1 } };
    },
    async isConnected() { return rpcOk && health !== null; },
    async health() { return health; },
  };
}

const EXPECTED_TOOLS = [
  "godot_orient",
  "godot_diagnose_connection",
  "godot_verify",
  "godot_test_run",
  "godot_batch",
  "godot_project_summary",
  "godot_generate_project_brain",
  "godot_query_project_brain",
  "godot_get_open_scenes",
  "godot_get_scene_tree",
  "godot_inspect_selected",
  "godot_get_filesystem_status",
  "godot_refresh_filesystem",
  "godot_find_dependencies",
  "godot_reflect",
  "godot_capture_2d_view",
  "godot_capture_3d_view",
  "godot_open_scene",
  "godot_save_scene",
  "godot_set_property",
  "godot_create_node",
  "godot_delete_node",
  "godot_reparent_node",
  "godot_instantiate_scene",
  "godot_read_script",
  "godot_get_script_sha",
  "godot_find_in_file",
  "godot_create_script",
  "godot_apply_text_edits",
  "godot_debug_run",
  "godot_capture_frames",
  "godot_run_project",
  "godot_stop_project",
  "godot_get_play_status",
] as const;

describe("Godot MCP registry", () => {
  it("registers exactly 34 focused, uniquely named Godot tools", () => {
    const names = allTools.map((tool) => tool.name);
    expect(names).toEqual(EXPECTED_TOOLS);
    expect(new Set(names).size).toBe(34);
    expect(names.every((name) => name.startsWith("godot_"))).toBe(true);
    expect(names.some((name) => /unity|prefab|gameobject/i.test(name))).toBe(false);
  });

  it("gives every tool a real schema, requirement, and write classification", () => {
    for (const tool of allTools) {
      expect(tool.description.length, tool.name).toBeGreaterThan(35);
      expect(tool.requires.length, tool.name).toBeGreaterThan(0);
      expect(Object.values(tool.inputShape).every((schema) => typeof schema.safeParse === "function"), tool.name).toBe(true);
      if (tool.write) expect(tool.writeTarget, tool.name).toBeDefined();
      else expect(tool.writeTarget, tool.name).toBeUndefined();
    }
    expect(allTools.find((tool) => tool.name === "godot_set_property")).toMatchObject({ write: true, writeTarget: "scene" });
    expect(allTools.find((tool) => tool.name === "godot_apply_text_edits")).toMatchObject({ write: true, writeTarget: "script" });
    expect(allTools.find((tool) => tool.name === "godot_open_scene")).toMatchObject({ write: true, writeTarget: "editor" });
    expect(allTools.find((tool) => tool.name === "godot_run_project")).toMatchObject({ write: true, writeTarget: "editor" });
    expect(allTools.find((tool) => tool.name === "godot_debug_run")).toMatchObject({ write: true, writeTarget: "editor" });
    const testRun = allTools.find((tool) => tool.name === "godot_test_run");
    expect(testRun).toBeDefined();
    expect(toolAnnotations(testRun!).readOnlyHint).toBe(false);
  });

  it("teaches Godot-specific orientation, reflection, editing, and verification", () => {
    // Claude Code truncates server instructions at 2KB, primer included.
    expect(Buffer.byteLength(SERVER_INSTRUCTIONS, "utf8")).toBeLessThanOrEqual(2_000);
    expect(SERVER_INSTRUCTIONS).toContain("godot_orient");
    expect(SERVER_INSTRUCTIONS).toContain("godot_reflect");
    expect(SERVER_INSTRUCTIONS).toContain("godot_test_run");
    expect(SERVER_INSTRUCTIONS).toContain("NodePath");
    expect(SERVER_INSTRUCTIONS).toContain("UndoRedo");
    expect(SERVER_INSTRUCTIONS).toContain("not a test suite");
    expect(SERVER_INSTRUCTIONS).not.toContain("MonoBehaviour");
  });
});

describe("deterministic mock editor", () => {
  it("implements every bridge method with Godot identity metadata", async () => {
    const bridge = createMockBridgeClient();
    for (const method of Object.values(BRIDGE_METHODS) as BridgeMethod[]) {
      const response = await bridge.call(method);
      expect(response.ok, method).toBe(true);
      if (response.ok) {
        expect(response.meta.godotVersion, method).toContain("4.7.1");
        expect(response.meta.projectPath, method).toBe("/mock/godot");
        expect(response.result, method).toBeDefined();
      }
    }
    expect(await bridge.isConnected()).toBe(true);
    expect(await bridge.health?.()).toMatchObject({ status: "ok", projectPath: "/mock/godot" });
  });

  it("returns a bounded scene tree through the real tool wrapper", async () => {
    const ctx = buildContext({ mock: true, projectPath: "/mock/godot" });
    const envelope = await godotGetSceneTree.run({ maxDepth: 4, maxNodes: 50 }, ctx);
    expect(envelope.ok).toBe(true);
    if (envelope.ok) {
      expect(envelope.data).toMatchObject({
        scenePath: "res://scenes/main.tscn",
        nodeCount: 2,
        truncated: false,
        root: { name: "Main", type: "Node2D" },
      });
      expect(envelope.meta.source).toBe("mock");
    }
  });

  it("returns a real PNG payload for visual tool testing", async () => {
    const ctx = buildContext({ mock: true, projectPath: "/mock/godot" });
    const envelope = await godotCapture2DView.run({}, ctx);
    expect(envelope.ok).toBe(true);
    if (envelope.ok) {
      const bytes = Buffer.from(envelope.data.pngBase64, "base64");
      expect([...bytes.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
      expect(envelope.data).toMatchObject({ kind: "2d", mimeType: "image/png", width: 640, height: 360 });
      expect(envelope.data.bytes).toBe(bytes.byteLength);
    }
  });

  it("refuses capture paths outside the managed Godot cache before bridge dispatch", async () => {
    const ctx = buildContext({ mock: true, projectPath: "/mock/godot" });
    for (const outputPath of [
      "res://scenes/main.tscn",
      "res://screenshots/preview.png",
      "user://preview.png",
      ".godot/godot-vibe-os/captures/nested/preview.png",
    ]) {
      const envelope = await godotCapture2DView.run({ outputPath }, ctx);
      expect(envelope.ok, outputPath).toBe(false);
      if (!envelope.ok) expect(envelope.error.code).toBe("INVALID_ARGUMENT");
    }

    const managed = await godotCapture2DView.run({
      outputPath: "res://.godot/godot-vibe-os/captures/preview.png",
    }, ctx);
    expect(managed.ok).toBe(true);
  });
});

describe("Godot connection diagnosis", () => {
  it("does not read project.godot through a symlink outside the project", async () => {
    const root = await project();
    const outside = await project();
    const secret = "External MCP Project Must Not Leak";
    const external = path.join(outside, "project.godot");
    await writeFile(external, `[editor_plugins]\nenabled=PackedStringArray("res://addons/godot_vibe_os/plugin.cfg")\n# ${secret}\n`, "utf8");
    await symlink(external, path.join(root, "project.godot"));
    const ctx = buildContext({ mock: true, projectPath: root });

    const envelope = await godotDiagnoseConnection.run({}, ctx);

    expect(JSON.stringify(envelope)).not.toContain(secret);
    expect(envelope.ok).toBe(true);
    if (envelope.ok) expect(envelope.data).toMatchObject({ project: { valid: false } });
  });

  it("redacts the authenticated discovery token from tool results", async () => {
    const root = await diagnosticProject();
    const health = { status: "ok", projectPath: root };
    const ctx = buildContext({ projectPath: root, bridgeOverride: diagnosticBridge(root, health, true) });
    const envelope = await godotDiagnoseConnection.run({}, ctx);

    expect(envelope.ok).toBe(true);
    expect(JSON.stringify(envelope)).not.toContain(DIAGNOSTIC_TOKEN);
    if (envelope.ok) {
      const data = envelope.data as { discovery: Record<string, unknown> };
      expect(data.discovery).toMatchObject({ host: "127.0.0.1", port: 38588, projectPath: await realpath(root) });
      expect(data.discovery).not.toHaveProperty("token");
    }
  });

  it.each([
    { label: "missing health", health: null, state: "not_connected" },
    { label: "failed RPC", health: { status: "ok" }, state: "reloading" },
  ])("never reports that checks passed for $label", async ({ health, state }) => {
    const root = await diagnosticProject();
    const resolvedHealth = health ? { ...health, projectPath: root } : null;
    const ctx = buildContext({ projectPath: root, bridgeOverride: diagnosticBridge(root, resolvedHealth, false) });
    const envelope = await godotDiagnoseConnection.run({}, ctx);
    expect(envelope.ok).toBe(true);
    if (envelope.ok) {
      const data = envelope.data as { state: string; findings: string[] };
      expect(data.state).toBe(state);
      expect(data.findings.join(" ")).not.toContain("checks passed");
      expect(data.findings).toContain("Bridge RPC check failed: GODOT_RELOADING — RPC unavailable");
      if (!health) expect(data.findings).toContain("Bridge health check failed.");
      expect(envelope.warnings.length).toBeGreaterThan(0);
    }
  });

  it("ignores a plugin path that appears only in a comment", async () => {
    const root = await diagnosticProject(false);
    const health = { status: "ok", projectPath: root };
    const ctx = buildContext({ projectPath: root, bridgeOverride: diagnosticBridge(root, health, true) });
    const envelope = await godotDiagnoseConnection.run({}, ctx);
    expect(envelope.ok).toBe(true);
    if (envelope.ok) {
      const data = envelope.data as { godotAddon: { enabled: boolean }; findings: string[] };
      expect(data.godotAddon.enabled).toBe(false);
      expect(data.findings).toContain("The addon is installed but is not listed in [editor_plugins].");
    }
  });

  it("reports a missing FoundryRuntimeProbe autoload even when the editor addon is enabled", async () => {
    const root = await diagnosticProject(true, false);
    const health = { status: "ok", projectPath: root };
    const envelope = await godotDiagnoseConnection.run({}, buildContext({ projectPath: root, bridgeOverride: diagnosticBridge(root, health, true) }));

    expect(envelope.ok).toBe(true);
    if (envelope.ok) {
      const data = envelope.data as { godotAddon: { detected: boolean; enabled: boolean; runtimeProbeConfigured: boolean }; findings: string[] };
      expect(data.godotAddon).toMatchObject({ detected: true, enabled: true, runtimeProbeConfigured: false });
      expect(data.findings).toContain("FoundryRuntimeProbe is missing or is not configured in [autoload].");
      expect(data.findings.join(" ")).not.toContain("checks passed");
    }
  });
});

describe("Godot MCP resources", () => {
  it("does not follow the conventions resource through a symlink outside the project", async () => {
    const root = await project();
    const outside = await project();
    const secret = "external conventions must stay private";
    const outsideFile = path.join(outside, "conventions.md");
    await writeFile(outsideFile, secret, "utf8");
    await mkdir(path.join(root, ".godot-vibe"), { recursive: true });
    await symlink(outsideFile, path.join(root, ".godot-vibe", "conventions.md"));

    const resource = await readConventionsResource(buildContext({ mock: true, projectPath: root }));

    expect(resource.contents[0].text).toBe("(.godot-vibe/conventions.md not found)");
    expect(JSON.stringify(resource)).not.toContain(secret);
  });
});

describe("godot_batch safety", () => {
  it("gates every nested write while allowing later reads when stopOnError is false", async () => {
    const root = await project();
    await writeConfig(root, GVibeConfigSchema.parse({ safetyMode: "read_only" }));
    const ctx = buildContext({ mock: true, projectPath: root });

    const envelope = await godotBatch.run({
      stopOnError: false,
      operations: [
        { tool: "godot_create_node", args: { type: "Node2D", name: "Blocked" } },
        { tool: "godot_get_play_status" },
      ],
    }, ctx);

    expect(envelope.ok).toBe(true);
    if (envelope.ok) {
      expect(envelope.data).toMatchObject({ allOk: false, ranCount: 2, total: 2 });
      expect(envelope.data.results).toEqual([
        expect.objectContaining({ index: 0, tool: "godot_create_node", ok: false, error: expect.objectContaining({ code: "SAFETY_MODE_BLOCKED" }) }),
        expect.objectContaining({ index: 1, tool: "godot_get_play_status", ok: true, data: expect.objectContaining({ playing: false }) }),
      ]);
    }
    expect(await readActions(root)).toEqual([
      expect.objectContaining({ tool: "godot_create_node", result: "blocked", errorCode: "SAFETY_MODE_BLOCKED" }),
    ]);
  });

  it("rejects nested batches and unknown tools without dispatching them", async () => {
    const ctx = buildContext({ mock: true, projectPath: await project() });
    const nested = await godotBatch.run({ operations: [{ tool: "godot_batch", args: { operations: [] } }] }, ctx);
    expect(nested.ok).toBe(true);
    if (nested.ok) {
      expect(nested.data).toMatchObject({ allOk: false, ranCount: 1 });
      expect(nested.data.results[0]).toMatchObject({ error: { code: "INVALID_ARGUMENT" } });
    }

    const unknown = await godotBatch.run({ operations: [{ tool: "godot_spawn_magic_node" }] }, ctx);
    expect(unknown.ok).toBe(true);
    if (unknown.ok) expect(unknown.data.results[0]).toMatchObject({ error: { code: "INVALID_ARGUMENT" } });
  });
});

describe("open-scene safety", () => {
  it.each(["read_only", "confirm"] as const)(
    "blocks the mock editor in %s mode before dispatch and records the denial",
    async (safetyMode) => {
      const root = await project();
      await writeConfig(root, GVibeConfigSchema.parse({ safetyMode }));
      const bridge = createMockBridgeClient();
      const originalCall = bridge.call.bind(bridge);
      let openCalls = 0;
      bridge.call = async <T>(method: BridgeMethod, params?: Record<string, unknown>) => {
        if (method === BRIDGE_METHODS.sceneOpen) openCalls++;
        return originalCall<T>(method, params);
      };
      const ctx = buildContext({ bridgeOverride: bridge, projectPath: root });
      const tool = ctx.tools?.find((candidate) => candidate.name === "godot_open_scene");

      const envelope = await executeTool(tool!, { path: "res://scenes/main.tscn" }, ctx);

      expect(envelope.ok).toBe(false);
      if (!envelope.ok) expect(envelope.error.code).toBe("SAFETY_MODE_BLOCKED");
      expect(openCalls).toBe(0);
      expect(await listSnapshots(root)).toEqual([]);
      expect(await readActions(root)).toEqual([
        expect.objectContaining({
          tool: "godot_open_scene",
          result: "blocked",
          errorCode: "SAFETY_MODE_BLOCKED",
        }),
      ]);
    }
  );

  it("logs an allowed mock open without inventing a file snapshot", async () => {
    const root = await project();
    const ctx = buildContext({ mock: true, projectPath: root });
    const tool = ctx.tools?.find((candidate) => candidate.name === "godot_open_scene");

    const envelope = await executeTool(tool!, { path: "res://scenes/main.tscn" }, ctx);

    expect(envelope.ok).toBe(true);
    expect(await listSnapshots(root)).toEqual([]);
    expect(await readActions(root)).toEqual([
      expect.objectContaining({ tool: "godot_open_scene", result: "ok" }),
    ]);
    expect((await readActions(root))[0]).not.toHaveProperty("snapshotId");
  });
});

describe("scene-save snapshots", () => {
  it("resolves and snapshots the active saved scene before a pathless save", async () => {
    const root = await project();
    await mkdir(path.join(root, "scenes"), { recursive: true });
    await writeFile(path.join(root, "scenes", "main.tscn"), "[node name=\"Before\" type=\"Node2D\"]\n", "utf8");
    const ctx = buildContext({ mock: true, projectPath: root });
    const tool = ctx.tools?.find((candidate) => candidate.name === "godot_save_scene");

    const envelope = await executeTool(tool!, {}, ctx);
    expect(envelope.ok).toBe(true);
    const snapshots = await listSnapshots(root);
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]).toMatchObject({ files: ["scenes/main.tscn"], absent: [] });
    expect(await readActions(root)).toEqual([
      expect.objectContaining({
        tool: "godot_save_scene",
        result: "ok",
        snapshotId: snapshots[0].id,
      }),
    ]);
  });

  it("blocks pathless saves when the editor has no active scene with a saved path", async () => {
    const states = [
      { scenes: [], count: 0, activeScene: "" },
      {
        scenes: [{ path: "", name: "Untitled", rootType: "Node2D", active: true, unsaved: true }],
        count: 1,
        activeScene: "",
      },
    ];

    for (const state of states) {
      const root = await project();
      const bridge = createMockBridgeClient();
      const originalCall = bridge.call.bind(bridge);
      let saveCalls = 0;
      bridge.call = async <T>(method: BridgeMethod, params?: Record<string, unknown>) => {
        if (method === BRIDGE_METHODS.sceneGetOpenScenes) {
          return {
            id: "open-scenes-test",
            ok: true,
            result: state as T,
            error: null,
            meta: { godotVersion: "4.7.1.mock", projectPath: root, durationMs: 0 },
          };
        }
        if (method === BRIDGE_METHODS.sceneSave) saveCalls++;
        return originalCall<T>(method, params);
      };
      const ctx = buildContext({ bridgeOverride: bridge, projectPath: root });
      const tool = ctx.tools?.find((candidate) => candidate.name === "godot_save_scene");

      const envelope = await executeTool(tool!, {}, ctx);
      expect(envelope.ok).toBe(false);
      if (!envelope.ok) {
        expect(envelope.error.code).toBe("WRITE_REQUIRES_SNAPSHOT");
        expect(envelope.error.message).toContain("no active scene with a saved res:// path");
      }
      expect(saveCalls).toBe(0);
      expect(await listSnapshots(root)).toEqual([]);
      expect(await readActions(root)).toEqual([
        expect.objectContaining({
          tool: "godot_save_scene",
          result: "blocked",
          errorCode: "WRITE_REQUIRES_SNAPSHOT",
        }),
      ]);
    }
  });
});
