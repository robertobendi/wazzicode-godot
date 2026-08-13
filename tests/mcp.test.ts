import { describe, it, expect, vi } from "vitest";
import { allTools, buildContext, createMockBridgeClient, createHttpBridgeClient, ToolGroupController, defaultActiveGroups, groupOf, toolAnnotations, UNITY_PROMPTS, createServer, readSceneHierarchyResource, readConsoleResource, readActionLogResource, SERVER_INSTRUCTIONS } from "@uvibe/mcp-server";
import type { BridgeMethod, BridgeResponse } from "@uvibe/core";
import type { BridgeClient } from "@uvibe/mcp-server";
import { isEditorWindowCaptureSupported, unityCaptureEditorWindow } from "../packages/mcp-server/src/tools/unityCaptureEditorWindow.js";
import { isMenuItemAllowed } from "../packages/mcp-server/src/tools/unityMenu.js";

describe("mcp-server/registry", () => {
  it("registers all tools with unique names and real descriptions", () => {
    const names = allTools.map((t) => t.name).sort();
    expect(names).toEqual([
      "unity_add_component",
      "unity_animator_edit_transition",
      "unity_apply_prefab_instance",
      "unity_apply_text_edits",
      "unity_assign_reference",
      "unity_batch",
      "unity_capture_editor_window",
      "unity_capture_game_view",
      "unity_capture_scene_view",
      "unity_capture_selected",
      "unity_check_git_status",
      "unity_clear_console",
      "unity_configure_play_mode",
      "unity_create_gameobject",
      "unity_create_material",
      "unity_create_prefab_variant",
      "unity_create_script",
      "unity_create_scriptable_object",
      "unity_delete_asset",
      "unity_delete_gameobject",
      "unity_diagnose_connection",
      "unity_docs",
      "unity_enter_play_mode",
      "unity_execute_code",
      "unity_execute_menu_item",
      "unity_exit_play_mode",
      "unity_find_dependencies",
      "unity_find_in_file",
      "unity_find_missing_references",
      "unity_find_missing_scripts",
      "unity_find_references",
      "unity_find_runtime_objects",
      "unity_generate_project_brain",
      "unity_get_animator_state",
      "unity_get_build_settings",
      "unity_get_console_logs",
      "unity_get_open_scenes",
      "unity_get_performance_stats",
      "unity_get_play_mode_status",
      "unity_get_scene_hierarchy",
      "unity_get_script_sha",
      "unity_import_asset",
      "unity_inspect_runtime_object",
      "unity_inspect_selected",
      "unity_instantiate_prefab",
      "unity_load_scene_additive",
      "unity_manage_tools",
      "unity_open_prefab",
      "unity_open_scene",
      "unity_orient",
      "unity_paint_tilemap",
      "unity_project_summary",
      "unity_qa",
      "unity_query_project_brain",
      "unity_read_script",
      "unity_reflect",
      "unity_refresh_assets",
      "unity_remove_component",
      "unity_reparent",
      "unity_run_tests",
      "unity_save_prefab",
      "unity_save_scene",
      "unity_script_edit",
      "unity_set_animator_parameter",
      "unity_set_runtime_field",
      "unity_set_serialized_field",
      "unity_set_transform",
      "unity_simulate_input",
      "unity_slice_sprite",
      "unity_smoke_test",
      "unity_step_frame",
      "unity_verify",
      "unity_wait_for_compile",
      "unity_wire_ui_button",
    ]);
    for (const t of allTools) {
      expect(t.description.length).toBeGreaterThan(20);
    }
    expect(new Set(names).size).toBe(names.length);
  });

  it("marks exactly the mutating tools as write tools with a target", () => {
    const writes = allTools.filter((t) => t.write).map((t) => t.name).sort();
    expect(writes).toEqual([
      "unity_add_component",
      "unity_animator_edit_transition",
      "unity_apply_prefab_instance",
      "unity_apply_text_edits",
      "unity_assign_reference",
      "unity_clear_console",
      "unity_create_gameobject",
      "unity_create_material",
      "unity_create_prefab_variant",
      "unity_create_script",
      "unity_create_scriptable_object",
      "unity_delete_asset",
      "unity_delete_gameobject",
      "unity_execute_code",
      "unity_execute_menu_item",
      "unity_import_asset",
      "unity_instantiate_prefab",
      "unity_paint_tilemap",
      "unity_remove_component",
      "unity_reparent",
      "unity_save_prefab",
      "unity_save_scene",
      "unity_script_edit",
      "unity_set_serialized_field",
      "unity_set_transform",
      "unity_slice_sprite",
      "unity_wire_ui_button",
    ]);
    for (const t of allTools) {
      if (t.write) expect(t.writeTarget).toBeDefined();
    }
  });
});

describe("mcp-server/menu access", () => {
  it("accepts Studio's wildcard while preserving exact custom allowlists", () => {
    expect(isMenuItemAllowed(["*"], "Assets/Refresh")).toBe(true);
    expect(isMenuItemAllowed(["Assets/Refresh"], "Assets/Refresh")).toBe(true);
    expect(isMenuItemAllowed(["Assets/Refresh"], "File/Exit")).toBe(false);
  });
});

describe("mcp-server/tool annotations", () => {
  it("marks every non-write tool readOnly and every write tool not-readOnly", () => {
    for (const tool of allTools) {
      const a = toolAnnotations(tool);
      if (tool.write) {
        expect(a.readOnlyHint, tool.name).toBe(false);
      }
    }
    // A pure read tool is read-only; a Unity write is not.
    expect(toolAnnotations(allTools.find((t) => t.name === "unity_get_scene_hierarchy")!).readOnlyHint).toBe(true);
    expect(toolAnnotations(allTools.find((t) => t.name === "unity_set_serialized_field")!).readOnlyHint).toBe(false);
  });

  it("flags hard-to-undo writes destructive and additive scene edits non-destructive", () => {
    const destructive = toolAnnotations(allTools.find((t) => t.name === "unity_script_edit")!);
    expect(destructive.destructiveHint).toBe(true);
    const additive = toolAnnotations(allTools.find((t) => t.name === "unity_create_gameobject")!);
    expect(additive.destructiveHint).toBe(false);
    // execute_code is destructive; docs touches the network.
    expect(toolAnnotations(allTools.find((t) => t.name === "unity_execute_code")!).destructiveHint).toBe(true);
    expect(toolAnnotations(allTools.find((t) => t.name === "unity_docs")!).openWorldHint).toBe(true);
  });

  it("treats batch and play-mode tools as mutating (not read-only)", () => {
    expect(toolAnnotations(allTools.find((t) => t.name === "unity_batch")!).readOnlyHint).toBe(false);
    expect(toolAnnotations(allTools.find((t) => t.name === "unity_enter_play_mode")!).readOnlyHint).toBe(false);
    expect(toolAnnotations(allTools.find((t) => t.name === "unity_configure_play_mode")!).readOnlyHint).toBe(false);
    expect(toolAnnotations(allTools.find((t) => t.name === "unity_set_runtime_field")!).readOnlyHint).toBe(false);
    expect(toolAnnotations(allTools.find((t) => t.name === "unity_smoke_test")!).readOnlyHint).toBe(false);
    expect(toolAnnotations(allTools.find((t) => t.name === "unity_qa")!).readOnlyHint).toBe(false);
  });
});

describe("mcp-server/instructions", () => {
  it("ships a server-instructions primer that names the core workflow tools", () => {
    expect(SERVER_INSTRUCTIONS.length).toBeGreaterThan(400);
    for (const t of ["unity_orient", "unity_reflect", "unity_verify", "unity_manage_tools"]) {
      expect(SERVER_INSTRUCTIONS, t).toContain(t);
    }
  });

  it("every tool named in the instructions actually exists", () => {
    const names = new Set(allTools.map((t) => t.name));
    const referenced = SERVER_INSTRUCTIONS.match(/unity_[a-z_]+/g) ?? [];
    for (const name of referenced) {
      // Strip trailing underscores from prose, then check membership.
      const clean = name.replace(/_+$/, "");
      expect(names.has(clean), `instructions reference unknown tool ${clean}`).toBe(true);
    }
  });

  it("blocks unsafe whole-editor capture on macOS without calling Unity", async () => {
    expect(isEditorWindowCaptureSupported("darwin")).toBe(false);
    expect(isEditorWindowCaptureSupported("linux")).toBe(true);
    expect(isEditorWindowCaptureSupported("win32")).toBe(true);
    expect(SERVER_INSTRUCTIONS).toContain("never call unity_capture_editor_window");

    const platform = vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
    const bridge = createMockBridgeClient();
    const call = vi.spyOn(bridge, "call");
    try {
      const result = await unityCaptureEditorWindow.run(
        { save: false },
        { bridge, projectPath: process.cwd(), configMockMode: false }
      );
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe("FEATURE_UNAVAILABLE");
        expect(result.error.recoverable).toBe(false);
      }
      expect(call).not.toHaveBeenCalled();
    } finally {
      platform.mockRestore();
    }
  });
});

describe("mcp-server/prompts", () => {
  it("every prompt builds non-empty guidance text", () => {
    for (const p of UNITY_PROMPTS) {
      const text = p.build({});
      expect(typeof text, p.name).toBe("string");
      expect(text.length, p.name).toBeGreaterThan(40);
      expect(p.config.title.length).toBeGreaterThan(0);
    }
  });

  it("new_script interpolates its arguments", () => {
    const p = UNITY_PROMPTS.find((x) => x.name === "new_script")!;
    const text = p.build({ name: "EnemyAI", description: "chase the player" });
    expect(text).toContain("EnemyAI");
    expect(text).toContain("chase the player");
  });

  it("createServer registers prompts without throwing", () => {
    const ctx = buildContext({ mock: true, projectPath: process.cwd() });
    expect(() => createServer(ctx)).not.toThrow();
  });
});

describe("mcp-server/resources", () => {
  it("scene-hierarchy and console resources return live JSON via the bridge", async () => {
    const ctx = buildContext({ mock: true, projectPath: process.cwd() });
    const hier = await readSceneHierarchyResource(ctx);
    expect(hier.contents[0].uri).toBe("unity://scene-hierarchy");
    expect(hier.contents[0].mimeType).toBe("application/json");
    expect(hier.contents[0].text).toContain("roots");

    const console = await readConsoleResource(ctx);
    expect(console.contents[0].text).toContain("logs");
  });

  it("action-log resource is safe when nothing has been logged", async () => {
    const ctx = buildContext({ mock: true, projectPath: process.cwd() });
    const log = await readActionLogResource(ctx);
    expect(log.contents[0].uri).toBe("unity://action-log");
    expect(typeof log.contents[0].text).toBe("string");
  });

  it("createServer registers resources without throwing", () => {
    const ctx = buildContext({ mock: true, projectPath: process.cwd() });
    expect(() => createServer(ctx)).not.toThrow();
  });
});

describe("mcp-server/tool groups", () => {
  function fakeHandle() {
    const state = { enabled: true };
    return { state, enable: () => (state.enabled = true), disable: () => (state.enabled = false) };
  }

  it("starts every capability group active and keeps core always on", () => {
    const controller = new ToolGroupController(defaultActiveGroups());
    const handles = new Map<string, ReturnType<typeof fakeHandle>>();
    for (const tool of allTools) {
      const h = fakeHandle();
      handles.set(tool.name, h);
      controller.register(tool.name, h);
    }
    // App-managed sessions expose codegen immediately; no permission setup step.
    expect(groupOf("unity_execute_code")).toBe("codegen");
    expect(handles.get("unity_execute_code")!.state.enabled).toBe(true);
    // A core tool stays enabled.
    expect(handles.get("unity_orient")!.state.enabled).toBe(true);
    // A default-on group (scripting) stays enabled.
    expect(handles.get("unity_create_script")!.state.enabled).toBe(true);
  });

  it("activate/deactivate flips the group's tool handles and never touches core", () => {
    const controller = new ToolGroupController(defaultActiveGroups());
    const handles = new Map<string, ReturnType<typeof fakeHandle>>();
    for (const tool of allTools) {
      const h = fakeHandle();
      handles.set(tool.name, h);
      controller.register(tool.name, h);
    }
    const deactivatedCodegen = controller.setActive("codegen", false);
    expect(deactivatedCodegen.changed).toBe(true);
    expect(handles.get("unity_execute_code")!.state.enabled).toBe(false);
    const activated = controller.setActive("codegen", true);
    expect(activated.changed).toBe(true);
    expect(handles.get("unity_execute_code")!.state.enabled).toBe(true);

    const deactivated = controller.setActive("runtime", false);
    expect(deactivated.changed).toBe(true);
    expect(handles.get("unity_enter_play_mode")!.state.enabled).toBe(false);

    // core can't be toggled.
    expect(controller.setActive("core", false).changed).toBe(false);
    expect(handles.get("unity_orient")!.state.enabled).toBe(true);
  });
});

describe("mcp-server/mockBridge", () => {
  it("returns ok for every MVP method", async () => {
    const bridge = createMockBridgeClient();
    const methods: BridgeMethod[] = [
      "system.health",
      "system.summary",
      "scene.getOpenScenes",
      "scene.getHierarchy",
      "selection.inspect",
      "console.getLogs",
      "compile.status",
      "asset.refresh",
      "screenshot.gameView",
      "screenshot.sceneView",
      "screenshot.selected",
      "screenshot.editorWindow",
      "perf.sample",
      "test.run",
      "test.status",
      "test.cancel",
      "playmode.enter",
      "playmode.exit",
      "playmode.step",
      "playmode.status",
      "runtime.findObjects",
      "runtime.inspect",
      "asset.findMissingScripts",
      "asset.findMissingReferences",
      "asset.findReferences",
      "asset.findDependencies",
      "edit.setSerializedField",
      "edit.addComponent",
      "edit.createGameObject",
      "edit.saveScene",
      "edit.assignReference",
      "edit.wireUiButton",
      "edit.instantiatePrefab",
      "edit.createScriptableObject",
      "edit.createMaterial",
      "edit.createPrefabVariant",
      "edit.deleteGameObject",
      "edit.removeComponent",
      "edit.deleteAsset",
      "console.clear",
      "scene.open",
      "scene.loadAdditive",
      "prefab.open",
      "prefab.save",
      "prefab.applyInstance",
      "input.simulate",
      "animator.getState",
      "animator.setParameter",
      "animator.editTransition",
      "editor.executeMenuItem",
      "asset.import",
      "asset.sliceSprite",
      "edit.setTransform",
      "edit.reparent",
      "edit.paintTilemap",
      "script.read",
      "script.getSha",
      "script.findInFile",
      "script.create",
      "script.applyEdits",
      "script.applyStructuredEdits",
      "code.execute",
      "reflect.query",
    ];
    for (const m of methods) {
      const r = await bridge.call(m);
      expect(r.ok, `mock missing responder for ${m}`).toBe(true);
    }
  });

  it("mock screenshots return a parseable PNG", async () => {
    const bridge = createMockBridgeClient();
    const r = await bridge.call<{ pngBase64: string; width: number; height: number }>("screenshot.gameView");
    expect(r.ok).toBe(true);
    if (r.ok) {
      // Base64 of valid PNG starts with iVBORw0KGgo
      expect(r.result.pngBase64.startsWith("iVBORw0KGgo")).toBe(true);
      expect(r.result.width).toBeGreaterThan(0);
      expect(r.result.height).toBeGreaterThan(0);
    }
  });
});

describe("mcp-server/tools (mock context)", () => {
  it("each tool returns a well-formed envelope against the mock bridge", async () => {
    const ctx = buildContext({ mock: true, projectPath: process.cwd() });
    for (const tool of allTools) {
      // wait_for_compile loops; mock returns isCompiling=false on first call so this is fast.
      const env = await tool.run({} as never, ctx);
      // Envelope shape
      expect(typeof env.ok).toBe("boolean");
      expect(env.meta).toBeDefined();
      if (env.ok) {
        expect(env.warnings).toBeInstanceOf(Array);
        expect(env.meta.source === "mock" || env.meta.source === "git" || env.meta.source === "project_brain").toBe(true);
      }
    }
  });
});

describe("mcp-server/composition tools", () => {
  it("unity_orient aggregates summary/scenes/selection/compile/git in one call", async () => {
    const ctx = buildContext({ mock: true, projectPath: process.cwd() });
    const tool = allTools.find((t) => t.name === "unity_orient")!;
    const env = await tool.run({}, ctx);
    expect(env.ok).toBe(true);
    if (env.ok) {
      const d = env.data as Record<string, any>;
      expect(d.bridgeReachable).toBe(true);
      expect(d.summary?.unityVersion).toBeDefined();
      expect(Array.isArray(d.openScenes?.scenes)).toBe(true);
      expect("compile" in d).toBe(true);
      expect("git" in d).toBe(true);
    }
  });

  it("unity_diagnose_connection returns a useful verdict without requiring RPC success", async () => {
    const bridge: BridgeClient = {
      source: "unity_bridge",
      async call<T>(): Promise<BridgeResponse<T>> {
        return {
          id: "diagnose",
          ok: false,
          result: null,
          error: { code: "UNITY_RELOADING", message: "domain reload" },
          meta: {},
        };
      },
      async isConnected() {
        return false;
      },
      async health() {
        return null;
      },
    };
    const tool = allTools.find((t) => t.name === "unity_diagnose_connection")!;
    const env = await tool.run(
      {},
      { bridge, projectPath: process.cwd(), configMockMode: false }
    );
    expect(env.ok).toBe(true);
    if (env.ok) {
      const data = env.data as { state: string; nextAction: string };
      expect(data.state).toBe("reloading");
      expect(data.nextAction).toContain("Wait");
    }
  });

  it("unity_get_console_logs filters message and stack text without a bridge change", async () => {
    const bridge: BridgeClient = {
      source: "unity_bridge",
      async call<T>(): Promise<BridgeResponse<T>> {
        return {
          id: "logs",
          ok: true,
          result: {
            logs: [
              { type: "Warning", message: "Unrelated warning", timestamp: 1 },
              {
                type: "Exception",
                message: "Operation failed",
                stackTrace: "PlayerController.Update",
                timestamp: 2,
              },
            ],
            truncated: false,
            bufferSize: 2,
          } as T,
          error: null,
          meta: {
            unityVersion: "6000.0.0f1",
            projectPath: process.cwd(),
            durationMs: 1,
          },
        };
      },
      async isConnected() {
        return true;
      },
    };
    const tool = allTools.find((t) => t.name === "unity_get_console_logs")!;
    const env = await tool.run(
      { query: "playercontroller" },
      { bridge, projectPath: process.cwd(), configMockMode: false }
    );
    expect(env.ok).toBe(true);
    if (env.ok) {
      const data = env.data as { logs: Array<{ message: string }> };
      expect(data.logs.map((entry) => entry.message)).toEqual(["Operation failed"]);
    }
  });

  it("unity_verify returns a single pass/compiled verdict", async () => {
    const ctx = buildContext({ mock: true, projectPath: process.cwd() });
    const tool = allTools.find((t) => t.name === "unity_verify")!;
    const env = await tool.run({}, ctx);
    expect(env.ok).toBe(true);
    if (env.ok) {
      const d = env.data as Record<string, any>;
      expect(typeof d.compiled).toBe("boolean");
      expect("pass" in d).toBe(true);
      expect(Array.isArray(d.problems)).toBe(true);
    }
  });

  it("unity_batch runs ordered ops, reports per-op results, and refuses nesting", async () => {
    const ctx = buildContext({ mock: true, projectPath: process.cwd() });
    const tool = allTools.find((t) => t.name === "unity_batch")!;
    const env = await tool.run(
      {
        operations: [
          { tool: "unity_get_open_scenes", args: {} },
          { tool: "unity_set_transform", args: { path: "/Gameplay/Player", position: { x: 1, y: 2, z: 3 } } },
          { tool: "unity_batch", args: {} }, // nesting → rejected, but stopOnError=false to see it
        ],
        stopOnError: false,
      },
      ctx
    );
    expect(env.ok).toBe(true);
    if (env.ok) {
      const d = env.data as { allOk: boolean; results: Array<{ ok: boolean; tool: string; error?: { code: string } }> };
      expect(d.results).toHaveLength(3);
      expect(d.results[0].ok).toBe(true);
      expect(d.results[1].ok).toBe(true);
      expect(d.results[2].ok).toBe(false);
      expect(d.results[2].error?.code).toBe("INVALID_ARGUMENT");
      expect(d.allOk).toBe(false);
    }
  });

  it("unity_batch tolerates being called with no operations (well-formed envelope)", async () => {
    const ctx = buildContext({ mock: true, projectPath: process.cwd() });
    const tool = allTools.find((t) => t.name === "unity_batch")!;
    const env = await tool.run({}, ctx);
    expect(env.ok).toBe(true);
  });
});

describe("unity_verify truthful verdicts", () => {
  type ConsoleEntry = {
    type: "Log" | "Warning" | "Error" | "Assert" | "Exception";
    message: string;
    stackTrace?: string;
    timestamp: number;
  };

  interface VerifyFixture {
    compile?: {
      isCompiling: boolean;
      hasErrors: boolean;
      errorCount: number;
      warningCount: number;
      errors: unknown[];
      settled?: boolean;
    };
    beforeTests?: ConsoleEntry[];
    afterTests?: ConsoleEntry[];
    tests?: Record<string, unknown>;
    testError?: { code: string; message: string };
    refreshError?: { code: string; message: string };
    consoleErrorPhase?: "before" | "after";
  }

  function verifyContext(fixture: VerifyFixture = {}) {
    const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
    const compile = fixture.compile ?? {
      isCompiling: false,
      hasErrors: false,
      errorCount: 0,
      warningCount: 0,
      errors: [],
      settled: true,
    };
    const tests = fixture.tests ?? {
      runId: "verify-run",
      state: "completed",
      mode: "EditMode",
      total: 1,
      passed: 1,
      failed: 0,
      skipped: 0,
      results: [{ name: "Passes", fullName: "Example.Passes", status: "Passed" }],
      settled: true,
    };

    const bridge: BridgeClient = {
      source: "unity_bridge",
      async call<T>(method: BridgeMethod, params: Record<string, unknown> = {}): Promise<BridgeResponse<T>> {
        calls.push({ method, params });
        if (method === "asset.refresh" && fixture.refreshError) {
          return {
            id: "verify",
            ok: false,
            result: null,
            error: fixture.refreshError,
            meta: {},
          };
        }
        if (method === "test.run" && fixture.testError) {
          return {
            id: "verify",
            ok: false,
            result: null,
            error: fixture.testError,
            meta: {},
          };
        }

        let result: unknown;
        if (method === "asset.refresh" || method === "compile.await") result = compile;
        else if (method === "console.getLogs") {
          const phase = typeof params.sinceTimestamp === "number" ? "after" : "before";
          if (fixture.consoleErrorPhase === phase) {
            return {
              id: "verify",
              ok: false,
              result: null,
              error: { code: "UNITY_NOT_CONNECTED", message: `Console unavailable ${phase} tests.` },
              meta: {},
            };
          }
          const phaseLogs = phase === "before" ? (fixture.beforeTests ?? []) : (fixture.afterTests ?? []);
          const level = params.level;
          const matching = phaseLogs.filter((log) => {
            if (level === "error") {
              return log.type === "Error" || log.type === "Assert" || log.type === "Exception";
            }
            if (level === "warning_or_error") return log.type !== "Log";
            return true;
          });
          const limit = typeof params.limit === "number" ? params.limit : 200;
          const logs = matching.slice(-limit);
          result = { logs, truncated: matching.length > limit, bufferSize: phaseLogs.length };
        } else if (method === "test.run") result = { runId: "verify-run", state: "running", mode: "EditMode" };
        else if (method === "test.await") result = tests;
        else {
          return {
            id: "verify",
            ok: false,
            result: null,
            error: { code: "INVALID_ARGUMENT", message: `Unexpected method: ${method}` },
            meta: {},
          };
        }
        return {
          id: "verify",
          ok: true,
          result: result as T,
          error: null,
          meta: { unityVersion: "6000.3.8f1", projectPath: "/project", durationMs: 1 },
        };
      },
      async isConnected() {
        return true;
      },
    };

    return {
      calls,
      ctx: { bridge, projectPath: process.cwd(), configMockMode: false },
      tool: allTools.find((t) => t.name === "unity_verify")!,
    };
  }

  it("fails hard when compilation remains active through the verification deadline", async () => {
    const { ctx, tool, calls } = verifyContext({
      compile: {
        isCompiling: true,
        hasErrors: false,
        errorCount: 0,
        warningCount: 0,
        errors: [],
        settled: true,
      },
    });
    const env = await tool.run({ compileTimeoutMs: 500 }, ctx);
    expect(env.ok).toBe(false);
    if (!env.ok) expect(env.error.code).toBe("BRIDGE_TIMEOUT");
    expect(calls.some((call) => call.method === "test.run")).toBe(false);
  });

  it("refreshes externally changed assets before waiting for compilation", async () => {
    const { ctx, tool, calls } = verifyContext();
    const env = await tool.run({ runTests: false }, ctx);
    expect(env.ok).toBe(true);
    expect(calls.slice(0, 2).map((call) => call.method)).toEqual([
      "asset.refresh",
      "compile.await",
    ]);
  });

  it("does not pass when an older package cannot refresh externally changed assets", async () => {
    const { ctx, tool } = verifyContext({
      refreshError: { code: "INVALID_ARGUMENT", message: "Unknown method: asset.refresh" },
    });
    const env = await tool.run({ runTests: false }, ctx);
    expect(env.ok).toBe(true);
    if (env.ok) {
      const data = env.data as { pass: boolean; refreshVerified: boolean };
      expect(data.pass).toBe(false);
      expect(data.refreshVerified).toBe(false);
      expect(env.warnings.join(" ")).toContain("Update or reinstall");
    }
  });

  it.each(["Error", "Assert", "Exception"] as const)("fails on an existing %s console entry", async (type) => {
    const { ctx, tool } = verifyContext({
      beforeTests: [{ type, message: `${type} happened`, timestamp: 10 }],
    });
    const env = await tool.run({}, ctx);
    expect(env.ok).toBe(true);
    if (env.ok) {
      const data = env.data as { pass: boolean; consoleErrorCount: number };
      expect(data.pass).toBe(false);
      expect(data.consoleErrorCount).toBe(1);
    }
  });

  it("fails when the initial console cannot be read", async () => {
    const { ctx, tool } = verifyContext({ consoleErrorPhase: "before" });
    const env = await tool.run({ runTests: false }, ctx);
    expect(env.ok).toBe(true);
    if (env.ok) {
      const data = env.data as { pass: boolean; consoleReadable: boolean };
      expect(data.pass).toBe(false);
      expect(data.consoleReadable).toBe(false);
      expect(env.warnings).toContain("Console checks were incomplete; verification cannot pass.");
    }
  });

  it("fails when the post-test console cannot be read", async () => {
    const { ctx, tool } = verifyContext({ consoleErrorPhase: "after" });
    const env = await tool.run({}, ctx);
    expect(env.ok).toBe(true);
    if (env.ok) {
      const data = env.data as { pass: boolean; consoleReadable: boolean };
      expect(data.pass).toBe(false);
      expect(data.consoleReadable).toBe(false);
      expect(env.warnings).toContain("Console checks were incomplete; verification cannot pass.");
    }
  });

  it("detects an older error hidden behind fifty newer warnings", async () => {
    const beforeTests: ConsoleEntry[] = [
      { type: "Error", message: "hidden failure", timestamp: 1 },
      ...Array.from({ length: 50 }, (_, index) => ({
        type: "Warning" as const,
        message: `warning ${index}`,
        timestamp: index + 2,
      })),
    ];
    const { ctx, tool, calls } = verifyContext({ beforeTests });
    const env = await tool.run({ runTests: false }, ctx);
    expect(env.ok).toBe(true);
    if (env.ok) {
      const data = env.data as { pass: boolean; problems: ConsoleEntry[] };
      expect(data.pass).toBe(false);
      expect(data.problems.some((log) => log.message === "hidden failure")).toBe(true);
    }
    expect(
      calls.filter((call) => call.method === "console.getLogs").map((call) => call.params.level)
    ).toEqual(["warning_or_error", "error"]);
  });

  it("marks a truncated error probe incomplete", async () => {
    const beforeTests: ConsoleEntry[] = Array.from({ length: 51 }, (_, index) => ({
      type: "Error" as const,
      message: `error ${index}`,
      timestamp: index + 1,
    }));
    const { ctx, tool } = verifyContext({ beforeTests });
    const env = await tool.run({ runTests: false }, ctx);
    expect(env.ok).toBe(true);
    if (env.ok) {
      const data = env.data as { pass: boolean; consoleReadable: boolean };
      expect(data.pass).toBe(false);
      expect(data.consoleReadable).toBe(false);
      expect(env.warnings).toContain("console error scan was truncated.");
    }
  });

  it("checks the console again after tests and fails on a new exception", async () => {
    const { ctx, tool, calls } = verifyContext({
      afterTests: [{ type: "Exception", message: "runtime failure", stackTrace: "at Game.Update()", timestamp: Date.now() + 1 }],
    });
    const env = await tool.run({}, ctx);
    expect(env.ok).toBe(true);
    if (env.ok) {
      const data = env.data as { pass: boolean; problems: ConsoleEntry[] };
      expect(data.pass).toBe(false);
      expect(data.problems.some((log) => log.message === "runtime failure")).toBe(true);
    }
    const consoleCalls = calls.filter((call) => call.method === "console.getLogs");
    expect(consoleCalls).toHaveLength(2);
    expect(typeof consoleCalls[1].params.sinceTimestamp).toBe("number");
  });

  it("fails when a requested test filter matches no tests", async () => {
    const { ctx, tool } = verifyContext({
      tests: {
        runId: "verify-run",
        state: "completed",
        mode: "EditMode",
        total: 0,
        passed: 0,
        failed: 0,
        skipped: 0,
        results: [],
        settled: true,
      },
    });
    const env = await tool.run({ testFilter: "Missing.Tests" }, ctx);
    expect(env.ok).toBe(true);
    if (env.ok) {
      expect((env.data as { pass: boolean }).pass).toBe(false);
      expect(env.warnings).toContain("No tests matched filter 'Missing.Tests'.");
    }
  });

  it("fails when a completed run contains an inconclusive test", async () => {
    const { ctx, tool } = verifyContext({
      tests: {
        runId: "verify-run",
        state: "completed",
        mode: "EditMode",
        total: 1,
        passed: 0,
        failed: 0,
        skipped: 0,
        results: [{ name: "Maybe", fullName: "Example.Maybe", status: "Inconclusive" }],
        settled: true,
      },
    });
    const env = await tool.run({}, ctx);
    expect(env.ok).toBe(true);
    if (env.ok) {
      expect((env.data as { pass: boolean }).pass).toBe(false);
      expect(env.warnings).toContain("1 test(s) were inconclusive.");
    }
  });

  it("warns but does not fail when an unfiltered project has no tests", async () => {
    const { ctx, tool } = verifyContext({
      tests: {
        runId: "verify-run",
        state: "completed",
        mode: "EditMode",
        total: 0,
        passed: 0,
        failed: 0,
        skipped: 0,
        results: [],
        settled: true,
      },
    });
    const env = await tool.run({}, ctx);
    expect(env.ok).toBe(true);
    if (env.ok) {
      expect((env.data as { pass: boolean }).pass).toBe(true);
      expect(env.warnings.some((warning) => warning.includes("discovered no tests"))).toBe(true);
    }
  });

  it("preserves TEST_FRAMEWORK_MISSING as a non-failing skip", async () => {
    const { ctx, tool, calls } = verifyContext({
      testError: { code: "TEST_FRAMEWORK_MISSING", message: "Test Framework is not installed." },
    });
    const env = await tool.run({}, ctx);
    expect(env.ok).toBe(true);
    if (env.ok) {
      expect((env.data as { pass: boolean }).pass).toBe(true);
      expect(env.warnings).toContain("Test Framework not installed; skipped tests.");
    }
    expect(calls.filter((call) => call.method === "console.getLogs")).toHaveLength(2);
  });
});

describe("mcp-server/bridgeClient (real HTTP, against unbound port)", () => {
  it("returns UNITY_NOT_CONNECTED when nothing is listening", async () => {
    // Use a port unlikely to be bound.
    const client: BridgeClient = createHttpBridgeClient({ port: 1, timeoutMs: 500 });
    const res: BridgeResponse = await client.call("system.health");
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(["UNITY_NOT_CONNECTED", "BRIDGE_TIMEOUT"]).toContain(res.error.code);
    }
  });
});

describe("mcp-server/long-poll awaits + legacy fallback", () => {
  /** Minimal scriptable bridge: records the methods called, answers from `handlers`,
   *  and reports "Unknown method" (like an older Unity package) for anything else. */
  function fakeBridge(
    handlers: Record<string, (params: Record<string, unknown>) => unknown>,
    calls: string[]
  ): BridgeClient {
    return {
      source: "unity_bridge",
      async call<T>(method: BridgeMethod, params: Record<string, unknown> = {}): Promise<BridgeResponse<T>> {
        calls.push(method);
        const h = handlers[method];
        if (!h) {
          return {
            id: "t",
            ok: false,
            result: null,
            error: { code: "INVALID_ARGUMENT", message: `Unknown method: ${method}` },
            meta: {},
          };
        }
        return {
          id: "t",
          ok: true,
          result: h(params) as T,
          error: null,
          meta: { unityVersion: "6000.0.0f1", projectPath: "/p", durationMs: 1 },
        };
      },
      async isConnected() {
        return true;
      },
    };
  }

  function ctxWith(bridge: BridgeClient) {
    return { bridge, projectPath: process.cwd(), configMockMode: false };
  }

  it("unity_wait_for_compile settles in ONE compile.await round trip on new bridges", async () => {
    const calls: string[] = [];
    const bridge = fakeBridge(
      {
        "compile.await": () => ({ isCompiling: false, hasErrors: false, errorCount: 0, warningCount: 0, errors: [], settled: true }),
      },
      calls
    );
    const tool = allTools.find((t) => t.name === "unity_wait_for_compile")!;
    const env = await tool.run({}, ctxWith(bridge));
    expect(env.ok).toBe(true);
    expect(calls).toEqual(["compile.await"]);
  });

  it("unity_wait_for_compile falls back to compile.status polling against older packages", async () => {
    const calls: string[] = [];
    const bridge = fakeBridge(
      {
        "compile.status": () => ({ isCompiling: false, hasErrors: false, errorCount: 0, warningCount: 0, errors: [] }),
      },
      calls
    );
    const tool = allTools.find((t) => t.name === "unity_wait_for_compile")!;
    const env = await tool.run({}, ctxWith(bridge));
    expect(env.ok).toBe(true);
    expect(calls).toEqual(["compile.await", "compile.status"]);
  });

  it("unity_wait_for_compile re-issues compile.await while unsettled (still compiling)", async () => {
    const calls: string[] = [];
    let round = 0;
    const bridge = fakeBridge(
      {
        "compile.await": () => {
          round++;
          return round < 2
            ? { isCompiling: true, hasErrors: false, errorCount: 0, warningCount: 0, errors: [], settled: false }
            : { isCompiling: false, hasErrors: false, errorCount: 0, warningCount: 0, errors: [], settled: true };
        },
      },
      calls
    );
    const tool = allTools.find((t) => t.name === "unity_wait_for_compile")!;
    const env = await tool.run({}, ctxWith(bridge));
    expect(env.ok).toBe(true);
    if (env.ok) expect((env.data as { isCompiling: boolean }).isCompiling).toBe(false);
    expect(calls).toEqual(["compile.await", "compile.await"]);
  });

  it("unity_wait_for_compile ignores settled=true while isCompiling remains authoritative", async () => {
    const calls: string[] = [];
    let round = 0;
    const bridge = fakeBridge(
      {
        "compile.await": () => {
          round++;
          return round < 2
            ? { isCompiling: true, hasErrors: false, errorCount: 0, warningCount: 0, errors: [], settled: true }
            : { isCompiling: false, hasErrors: false, errorCount: 0, warningCount: 0, errors: [], settled: true };
        },
      },
      calls
    );
    const tool = allTools.find((t) => t.name === "unity_wait_for_compile")!;
    const env = await tool.run({ pollMs: 100 }, ctxWith(bridge));
    expect(env.ok).toBe(true);
    if (env.ok) expect((env.data as { isCompiling: boolean }).isCompiling).toBe(false);
    expect(calls).toEqual(["compile.await", "compile.await"]);
  });

  it("unity_wait_for_compile gives reload recovery the remaining explicit timeout", async () => {
    vi.useFakeTimers();
    try {
      const readyAt = Date.now() + 31_000;
      const calls: string[] = [];
      const bridge: BridgeClient = {
        source: "unity_bridge",
        async call<T>(method: BridgeMethod): Promise<BridgeResponse<T>> {
          calls.push(method);
          if (Date.now() < readyAt) {
            return {
              id: "t",
              ok: false,
              result: null,
              error: { code: "UNITY_RELOADING", message: "domain reload" },
              meta: {},
            };
          }
          return {
            id: "t",
            ok: true,
            result: {
              isCompiling: false,
              hasErrors: false,
              errorCount: 0,
              warningCount: 0,
              errors: [],
              settled: true,
            } as T,
            error: null,
            meta: { unityVersion: "6000.0.0f1", projectPath: "/p", durationMs: 1 },
          };
        },
        async isConnected() {
          return true;
        },
      };

      const tool = allTools.find((candidate) => candidate.name === "unity_wait_for_compile")!;
      const pending = tool.run({ timeoutMs: 60_000 }, ctxWith(bridge));
      await vi.advanceTimersByTimeAsync(32_000);
      const env = await pending;
      expect(env.ok).toBe(true);
      expect(calls.length).toBeGreaterThan(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("unity_wait_for_compile fails hard with UNITY_EDITOR_STALLED instead of soft-timing-out against a frozen editor", async () => {
    const calls: string[] = [];
    const bridge = fakeBridge(
      {
        // Never settles: the editor loop is frozen so the compile makes no progress.
        "compile.await": () => ({ isCompiling: true, hasErrors: false, errorCount: 0, warningCount: 0, errors: [], settled: false }),
      },
      calls
    );
    bridge.health = async () => ({
      status: "ok",
      editorTickAgeMs: 30_000,
      keepAwakeEnabled: false,
      wasFocused: false,
    });
    const tool = allTools.find((t) => t.name === "unity_wait_for_compile")!;
    const env = await tool.run({ timeoutMs: 600 }, ctxWith(bridge));
    expect(env.ok).toBe(false);
    if (!env.ok) {
      expect(env.error.code).toBe("UNITY_EDITOR_STALLED");
      expect(env.error.message).toContain("focus Unity");
    }
  });

  it("unity_wait_for_compile returns a hard timeout when the editor is alive but compile stays active", async () => {
    const calls: string[] = [];
    const bridge = fakeBridge(
      {
        "compile.await": () => ({ isCompiling: true, hasErrors: false, errorCount: 0, warningCount: 0, errors: [], settled: true }),
      },
      calls
    );
    bridge.health = async () => ({
      status: "ok",
      editorTickAgeMs: 16,
      keepAwakeEnabled: true,
      wasFocused: true,
    });
    const tool = allTools.find((t) => t.name === "unity_wait_for_compile")!;
    const env = await tool.run({ timeoutMs: 600, pollMs: 100 }, ctxWith(bridge));
    expect(env.ok).toBe(false);
    if (!env.ok) {
      expect(env.error.code).toBe("BRIDGE_TIMEOUT");
      expect(env.error.details).toMatchObject({ timeoutMs: 600 });
    }
  });

  it("unity_orient warns when 'Keep Unity awake' is off", async () => {
    const bridge = fakeBridge({}, []);
    bridge.health = async () => ({ status: "ok", editorTickAgeMs: 16, keepAwakeEnabled: false, wasFocused: true });
    const tool = allTools.find((t) => t.name === "unity_orient")!;
    const env = await tool.run({}, ctxWith(bridge));
    expect(env.ok).toBe(true);
    if (env.ok) expect(env.warnings.some((w) => w.includes("Keep Unity awake"))).toBe(true);
  });

  it("unity_orient warns when the Unity package predates the keep-awake driver", async () => {
    const bridge = fakeBridge({}, []);
    bridge.health = async () => ({ status: "ok" });
    const tool = allTools.find((t) => t.name === "unity_orient")!;
    const env = await tool.run({}, ctxWith(bridge));
    expect(env.ok).toBe(true);
    if (env.ok) expect(env.warnings.some((w) => w.includes("keep-awake"))).toBe(true);
  });

  it("unity_step_frame steps N frames in ONE call on new bridges", async () => {
    const calls: string[] = [];
    const bridge = fakeBridge(
      {
        "playmode.step": (p) => ({
          isPlaying: true,
          isPaused: true,
          frameCount: 100 + Number(p.frames ?? 1),
          framesStepped: Number(p.frames ?? 1),
          stepping: false,
          settled: true,
        }),
      },
      calls
    );
    const tool = allTools.find((t) => t.name === "unity_step_frame")!;
    const env = await tool.run({ frames: 10 }, ctxWith(bridge));
    expect(env.ok).toBe(true);
    if (env.ok) expect((env.data as { framesStepped?: number }).framesStepped).toBe(10);
    expect(calls).toEqual(["playmode.step"]);
  });

  it("unity_step_frame falls back to one-call-per-frame against older packages", async () => {
    const calls: string[] = [];
    let frame = 0;
    const bridge = fakeBridge(
      {
        // Old bridge: no framesStepped key, steps exactly one frame per call.
        "playmode.step": () => ({ isPlaying: true, isPaused: true, frameCount: ++frame }),
      },
      calls
    );
    const tool = allTools.find((t) => t.name === "unity_step_frame")!;
    const env = await tool.run({ frames: 3 }, ctxWith(bridge));
    expect(env.ok).toBe(true);
    expect(calls).toEqual(["playmode.step", "playmode.step", "playmode.step"]);
  });

  it("unity_enter_play_mode waits via playmode.await on new bridges", async () => {
    const calls: string[] = [];
    const bridge = fakeBridge(
      {
        "playmode.enter": () => ({ isPlaying: false, isPaused: false, isTransitioning: true }),
        "playmode.await": (p) => {
          expect(p.until).toBe("playing");
          return { isPlaying: true, isPaused: false, isTransitioning: false, frameCount: 1, settled: true };
        },
      },
      calls
    );
    const tool = allTools.find((t) => t.name === "unity_enter_play_mode")!;
    const env = await tool.run({}, ctxWith(bridge));
    expect(env.ok).toBe(true);
    if (env.ok) expect((env.data as { isPlaying: boolean }).isPlaying).toBe(true);
    expect(calls).toEqual(["playmode.enter", "playmode.await"]);
  });

  it("unity_enter_play_mode gives reload recovery the remaining explicit timeout", async () => {
    vi.useFakeTimers();
    try {
      const readyAt = Date.now() + 31_000;
      const calls: string[] = [];
      const bridge: BridgeClient = {
        source: "unity_bridge",
        async call<T>(method: BridgeMethod): Promise<BridgeResponse<T>> {
          calls.push(method);
          if (method === "playmode.await" && Date.now() < readyAt) {
            return {
              id: "t",
              ok: false,
              result: null,
              error: { code: "UNITY_RELOADING", message: "domain reload" },
              meta: {},
            };
          }
          return {
            id: "t",
            ok: true,
            result: (method === "playmode.enter"
              ? { isPlaying: false, isPaused: false, isTransitioning: true }
              : { isPlaying: true, isPaused: false, isTransitioning: false, settled: true }) as T,
            error: null,
            meta: { unityVersion: "6000.0.0f1", projectPath: "/p", durationMs: 1 },
          };
        },
        async isConnected() {
          return true;
        },
      };

      const tool = allTools.find((candidate) => candidate.name === "unity_enter_play_mode")!;
      const pending = tool.run({ timeoutMs: 60_000 }, ctxWith(bridge));
      await vi.advanceTimersByTimeAsync(32_000);
      const env = await pending;
      expect(env.ok).toBe(true);
      expect(calls.filter((method) => method === "playmode.await").length).toBeGreaterThan(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    ["unity_enter_play_mode", "playmode.enter", false, true],
    ["unity_exit_play_mode", "playmode.exit", true, false],
  ] as const)(
    "%s lets the initial transition recover beyond the method default within its explicit timeout",
    async (toolName, startMethod, startingIsPlaying, finalIsPlaying) => {
      vi.useFakeTimers();
      try {
        const initialReadyAt = Date.now() + 70_000;
        const finalReadyAt = Date.now() + 100_000;
        const calls: string[] = [];
        const bridge: BridgeClient = {
          source: "unity_bridge",
          async call<T>(method: BridgeMethod): Promise<BridgeResponse<T>> {
            calls.push(method);
            if (
              (method === startMethod && Date.now() < initialReadyAt) ||
              (method === "playmode.await" && Date.now() < finalReadyAt)
            ) {
              return {
                id: "t",
                ok: false,
                result: null,
                error: { code: "UNITY_RELOADING", message: "domain reload" },
                meta: {},
              };
            }
            return {
              id: "t",
              ok: true,
              result: (method === startMethod
                ? {
                    isPlaying: startingIsPlaying,
                    isPaused: false,
                    isTransitioning: true,
                  }
                : {
                    isPlaying: finalIsPlaying,
                    isPaused: false,
                    isTransitioning: false,
                    settled: true,
                  }) as T,
              error: null,
              meta: { unityVersion: "6000.0.0f1", projectPath: "/p", durationMs: 1 },
            };
          },
          async isConnected() {
            return true;
          },
        };

        const tool = allTools.find((candidate) => candidate.name === toolName)!;
        const pending = tool.run({ timeoutMs: 120_000 }, ctxWith(bridge));
        await vi.advanceTimersByTimeAsync(101_000);
        const env = await pending;
        expect(env.ok).toBe(true);
        expect(calls.filter((method) => method === startMethod).length).toBeGreaterThan(2);
        expect(calls.filter((method) => method === "playmode.await").length).toBeGreaterThan(2);
      } finally {
        vi.useRealTimers();
      }
    }
  );

  it("unity_enter_play_mode counts initial reload recovery against the overall timeout", async () => {
    vi.useFakeTimers();
    try {
      const initialReadyAt = Date.now() + 70_000;
      const calls: string[] = [];
      const bridge: BridgeClient = {
        source: "unity_bridge",
        async call<T>(method: BridgeMethod): Promise<BridgeResponse<T>> {
          calls.push(method);
          if (method === "playmode.enter" && Date.now() >= initialReadyAt) {
            return {
              id: "t",
              ok: true,
              result: {
                isPlaying: false,
                isPaused: false,
                isTransitioning: true,
              } as T,
              error: null,
              meta: { unityVersion: "6000.0.0f1", projectPath: "/p", durationMs: 1 },
            };
          }
          return {
            id: "t",
            ok: false,
            result: null,
            error: { code: "UNITY_RELOADING", message: "domain reload" },
            meta: {},
          };
        },
        async isConnected() {
          return true;
        },
      };

      const tool = allTools.find((candidate) => candidate.name === "unity_enter_play_mode")!;
      const pending = tool.run({ timeoutMs: 120_000 }, ctxWith(bridge));
      await vi.advanceTimersByTimeAsync(121_000);
      const env = await pending;
      expect(env.ok).toBe(false);
      if (!env.ok) {
        expect(env.error.code).toBe("BRIDGE_TIMEOUT");
        expect(env.error.details).toMatchObject({ until: "playing", timeoutMs: 120_000 });
        expect(env.meta.durationMs).toBeGreaterThanOrEqual(120_000);
        expect(env.meta.durationMs).toBeLessThan(121_000);
      }
      expect(calls.filter((method) => method === "playmode.enter").length).toBeGreaterThan(2);
      expect(calls.filter((method) => method === "playmode.await").length).toBeGreaterThan(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    ["unity_enter_play_mode", "playmode.enter", false],
    ["unity_exit_play_mode", "playmode.exit", true],
  ] as const)("%s rejects a settled await response in the wrong state", async (toolName, startMethod, isPlaying) => {
    const calls: string[] = [];
    const bridge = fakeBridge(
      {
        [startMethod]: () => ({ isPlaying, isPaused: false, isTransitioning: true }),
        "playmode.await": () => ({
          isPlaying,
          isPaused: false,
          isTransitioning: false,
          settled: true,
        }),
      },
      calls
    );
    const tool = allTools.find((candidate) => candidate.name === toolName)!;
    const env = await tool.run({}, ctxWith(bridge));
    expect(env.ok).toBe(false);
    if (!env.ok) expect(env.error.code).toBe("MALFORMED_BRIDGE_RESPONSE");
    expect(calls).toEqual([startMethod, "playmode.await"]);
  });

  it("unity_enter_play_mode returns an error when its transition deadline expires", async () => {
    const calls: string[] = [];
    const bridge: BridgeClient = {
      source: "unity_bridge",
      async call<T>(method: BridgeMethod): Promise<BridgeResponse<T>> {
        calls.push(method);
        if (method === "playmode.enter") {
          return {
            id: "t",
            ok: true,
            result: { isPlaying: false, isPaused: false, isTransitioning: true } as T,
            error: null,
            meta: { unityVersion: "6000.0.0f1", projectPath: "/p", durationMs: 1 },
          };
        }
        await new Promise((resolve) => setTimeout(resolve, 520));
        return {
          id: "t",
          ok: true,
          result: {
            isPlaying: false,
            isPaused: false,
            isTransitioning: true,
            settled: false,
          } as T,
          error: null,
          meta: { unityVersion: "6000.0.0f1", projectPath: "/p", durationMs: 520 },
        };
      },
      async isConnected() {
        return true;
      },
    };

    const tool = allTools.find((candidate) => candidate.name === "unity_enter_play_mode")!;
    const env = await tool.run({ timeoutMs: 500 }, ctxWith(bridge));
    expect(env.ok).toBe(false);
    if (!env.ok) expect(env.error.code).toBe("BRIDGE_TIMEOUT");
    expect(calls).toEqual(["playmode.enter", "playmode.await"]);
  });

  it("unity_enter_play_mode falls back to status polling against older packages", async () => {
    const calls: string[] = [];
    const bridge = fakeBridge(
      {
        "playmode.enter": () => ({ isPlaying: false, isPaused: false, isTransitioning: true }),
        "playmode.status": () => ({ isPlaying: true, isPaused: false, isTransitioning: false, frameCount: 1 }),
      },
      calls
    );
    const tool = allTools.find((t) => t.name === "unity_enter_play_mode")!;
    const env = await tool.run({}, ctxWith(bridge));
    expect(env.ok).toBe(true);
    expect(calls).toEqual(["playmode.enter", "playmode.await", "playmode.status"]);
  });

  it("unity_enter_play_mode returns a terminal await error instead of stale enter success", async () => {
    const calls: string[] = [];
    const bridge: BridgeClient = {
      source: "unity_bridge",
      async call<T>(method: BridgeMethod): Promise<BridgeResponse<T>> {
        calls.push(method);
        if (method === "playmode.enter") {
          return {
            id: "t",
            ok: true,
            result: { isPlaying: false, isPaused: false, isTransitioning: true } as T,
            error: null,
            meta: { unityVersion: "6000.0.0f1", projectPath: "/p", durationMs: 1 },
          };
        }
        return {
          id: "t",
          ok: false,
          result: null,
          error: { code: "PROJECT_IDENTITY_MISMATCH", message: "A different Unity project answered." },
          meta: {},
        };
      },
      async isConnected() {
        return true;
      },
    };

    const tool = allTools.find((t) => t.name === "unity_enter_play_mode")!;
    const env = await tool.run({}, ctxWith(bridge));
    expect(env.ok).toBe(false);
    if (!env.ok) expect(env.error.code).toBe("PROJECT_IDENTITY_MISMATCH");
    expect(calls).toEqual(["playmode.enter", "playmode.await"]);
  });

  it("unity_enter_play_mode returns a terminal legacy status error", async () => {
    const calls: string[] = [];
    const bridge: BridgeClient = {
      source: "unity_bridge",
      async call<T>(method: BridgeMethod): Promise<BridgeResponse<T>> {
        calls.push(method);
        if (method === "playmode.enter") {
          return {
            id: "t",
            ok: true,
            result: { isPlaying: false, isPaused: false, isTransitioning: true } as T,
            error: null,
            meta: { unityVersion: "6000.0.0f1", projectPath: "/p", durationMs: 1 },
          };
        }
        if (method === "playmode.await") {
          return {
            id: "t",
            ok: false,
            result: null,
            error: { code: "INVALID_ARGUMENT", message: "Unknown method: playmode.await" },
            meta: {},
          };
        }
        return {
          id: "t",
          ok: false,
          result: null,
          error: { code: "UNITY_NOT_CONNECTED", message: "Unity closed during the transition." },
          meta: {},
        };
      },
      async isConnected() {
        return true;
      },
    };

    const tool = allTools.find((t) => t.name === "unity_enter_play_mode")!;
    const env = await tool.run({}, ctxWith(bridge));
    expect(env.ok).toBe(false);
    if (!env.ok) expect(env.error.code).toBe("UNITY_NOT_CONNECTED");
    expect(calls).toEqual(["playmode.enter", "playmode.await", "playmode.status"]);
  });

  it("unity_run_tests waits via test.await on new bridges (no test.status polling)", async () => {
    const calls: string[] = [];
    const bridge = fakeBridge(
      {
        "test.run": () => ({ runId: "r1", state: "running", mode: "EditMode" }),
        "test.await": () => ({ runId: "r1", state: "completed", total: 1, passed: 1, failed: 0, skipped: 0, results: [], settled: true }),
      },
      calls
    );
    const tool = allTools.find((t) => t.name === "unity_run_tests")!;
    const env = await tool.run({}, ctxWith(bridge));
    expect(env.ok).toBe(true);
    if (env.ok) expect((env.data as { state: string }).state).toBe("completed");
    expect(calls).toEqual(["test.run", "test.await"]);
  });

  it("unity_run_tests rejects an empty runId before requesting status", async () => {
    const calls: string[] = [];
    const bridge = fakeBridge(
      {
        "test.run": () => ({ runId: "", state: "running", mode: "EditMode" }),
      },
      calls
    );
    const tool = allTools.find((candidate) => candidate.name === "unity_run_tests")!;
    const env = await tool.run({}, ctxWith(bridge));
    expect(env.ok).toBe(false);
    if (!env.ok) {
      expect(env.error.code).toBe("MALFORMED_BRIDGE_RESPONSE");
      expect(env.error.details).toMatchObject({ method: "test.run", actualRunId: "" });
    }
    expect(calls).toEqual(["test.run"]);
  });

  it("unity_run_tests preserves a failed mock-mode status response", async () => {
    const calls: string[] = [];
    const bridge: BridgeClient = {
      source: "mock",
      async call<T>(method: BridgeMethod): Promise<BridgeResponse<T>> {
        calls.push(method);
        if (method === "test.run") {
          return {
            id: "t",
            ok: true,
            result: { runId: "r1", state: "running", mode: "EditMode" } as T,
            error: null,
            meta: { durationMs: 1 },
          };
        }
        return {
          id: "t",
          ok: false,
          result: null,
          error: { code: "UNITY_NOT_CONNECTED", message: "Mock status failed." },
          meta: {},
        };
      },
      async isConnected() {
        return true;
      },
    };
    const tool = allTools.find((candidate) => candidate.name === "unity_run_tests")!;
    const env = await tool.run({}, { ...ctxWith(bridge), configMockMode: true });
    expect(env.ok).toBe(false);
    if (!env.ok) expect(env.error.code).toBe("UNITY_NOT_CONNECTED");
    expect(calls).toEqual(["test.run", "test.status"]);
  });

  it("unity_run_tests rejects an await status for a different run instead of continuing", async () => {
    const calls: string[] = [];
    let awaitRound = 0;
    const bridge = fakeBridge(
      {
        "test.run": () => ({ runId: "r1", state: "running", mode: "EditMode" }),
        "test.await": () =>
          ++awaitRound === 1
            ? { runId: "other-run", state: "running", settled: false }
            : {
                runId: "r1",
                state: "completed",
                total: 1,
                passed: 1,
                failed: 0,
                skipped: 0,
                results: [],
                settled: true,
              },
      },
      calls
    );
    const tool = allTools.find((candidate) => candidate.name === "unity_run_tests")!;
    const env = await tool.run({}, ctxWith(bridge));
    expect(env.ok).toBe(false);
    if (!env.ok) {
      expect(env.error.code).toBe("MALFORMED_BRIDGE_RESPONSE");
      expect(env.error.details).toMatchObject({
        method: "test.await",
        expectedRunId: "r1",
        actualRunId: "other-run",
      });
    }
    expect(calls).toEqual(["test.run", "test.await"]);
  });

  it("unity_run_tests gives reload recovery the remaining explicit timeout", async () => {
    vi.useFakeTimers();
    try {
      const readyAt = Date.now() + 31_000;
      const calls: string[] = [];
      const bridge: BridgeClient = {
        source: "unity_bridge",
        async call<T>(method: BridgeMethod): Promise<BridgeResponse<T>> {
          calls.push(method);
          if (method === "test.await" && Date.now() < readyAt) {
            return {
              id: "t",
              ok: false,
              result: null,
              error: { code: "UNITY_RELOADING", message: "domain reload" },
              meta: {},
            };
          }
          return {
            id: "t",
            ok: true,
            result: (method === "test.run"
              ? { runId: "r1", state: "running", mode: "PlayMode" }
              : {
                  runId: "r1",
                  state: "completed",
                  mode: "PlayMode",
                  total: 1,
                  passed: 1,
                  failed: 0,
                  skipped: 0,
                  results: [],
                  settled: true,
                }) as T,
            error: null,
            meta: { unityVersion: "6000.0.0f1", projectPath: "/p", durationMs: 1 },
          };
        },
        async isConnected() {
          return true;
        },
      };

      const tool = allTools.find((candidate) => candidate.name === "unity_run_tests")!;
      const pending = tool.run({ mode: "PlayMode", timeoutMs: 60_000 }, ctxWith(bridge));
      await vi.advanceTimersByTimeAsync(32_000);
      const env = await pending;
      expect(env.ok).toBe(true);
      expect(calls.filter((method) => method === "test.await").length).toBeGreaterThan(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("unity_run_tests falls back to test.status polling against older packages", async () => {
    const calls: string[] = [];
    const bridge = fakeBridge(
      {
        "test.run": () => ({ runId: "r1", state: "running", mode: "EditMode" }),
        "test.status": () => ({ runId: "r1", state: "completed", total: 1, passed: 1, failed: 0, skipped: 0, results: [] }),
      },
      calls
    );
    const tool = allTools.find((t) => t.name === "unity_run_tests")!;
    const env = await tool.run({ pollMs: 200 }, ctxWith(bridge));
    expect(env.ok).toBe(true);
    expect(calls).toEqual(["test.run", "test.await", "test.status"]);
  });

  it("unity_run_tests rejects a legacy status result for a different run", async () => {
    const calls: string[] = [];
    const bridge = fakeBridge(
      {
        "test.run": () => ({ runId: "r1", state: "running", mode: "EditMode" }),
        "test.status": () => ({
          runId: "other-run",
          state: "completed",
          total: 1,
          passed: 1,
          failed: 0,
          skipped: 0,
          results: [],
        }),
      },
      calls
    );
    const tool = allTools.find((candidate) => candidate.name === "unity_run_tests")!;
    const env = await tool.run({ pollMs: 200 }, ctxWith(bridge));
    expect(env.ok).toBe(false);
    if (!env.ok) {
      expect(env.error.code).toBe("MALFORMED_BRIDGE_RESPONSE");
      expect(env.error.details).toMatchObject({
        method: "test.status",
        expectedRunId: "r1",
        actualRunId: "other-run",
      });
    }
    expect(calls).toEqual(["test.run", "test.await", "test.status"]);
  });
});
