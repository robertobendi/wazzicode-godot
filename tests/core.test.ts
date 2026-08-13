import { describe, expect, it } from "vitest";
import {
  BRIDGE_DISCOVERY_REL,
  BRIDGE_METHODS,
  DEFAULT_BRIDGE_HOST,
  DEFAULT_BRIDGE_PORT,
  DEFAULT_MCP_PORT,
  FilesystemStatusSchema,
  GodotNodeSchema,
  OpenScenesResultSchema,
  PRODUCT_NAME,
  PROTOCOL_VERSION,
  ProjectSummarySchema,
  SceneTreeResultSchema,
  ScreenshotResultSchema,
  VariantSchema,
  VerifyResultSchema,
  err,
  isErrorCode,
  makeBridgeRequest,
  makeError,
  ok,
} from "@gvibe/core";

describe("core product contract", () => {
  it("uses Godot-native identity, ports, and per-project discovery", () => {
    expect(PRODUCT_NAME).toBe("Godot Vibe OS");
    expect(PROTOCOL_VERSION).toBe("1.0");
    expect(DEFAULT_BRIDGE_HOST).toBe("127.0.0.1");
    expect(DEFAULT_BRIDGE_PORT).toBe(38588);
    expect(DEFAULT_MCP_PORT).toBe(38587);
    expect(BRIDGE_DISCOVERY_REL).toBe(".godot/godot-vibe-os/bridge.json");
  });

  it("exposes the complete focused editor protocol without Unity methods", () => {
    expect(Object.values(BRIDGE_METHODS)).toEqual([
      "system.health",
      "system.summary",
      "scene.getOpenScenes",
      "scene.getTree",
      "selection.inspect",
      "filesystem.status",
      "filesystem.scan",
      "resource.getDependencies",
      "reflect.query",
      "viewport.capture2D",
      "viewport.capture3D",
      "scene.open",
      "scene.save",
      "edit.setProperty",
      "edit.createNode",
      "edit.deleteNode",
      "edit.reparentNode",
      "edit.instantiateScene",
      "play.run",
      "play.stop",
      "play.status",
    ]);
    expect(Object.values(BRIDGE_METHODS).some((method) => /unity|prefab|gameobject/i.test(method))).toBe(false);
  });

  it("creates versioned requests with unique ids and explicit params", () => {
    const first = makeBridgeRequest(BRIDGE_METHODS.sceneGetTree, { nodePath: "." });
    const second = makeBridgeRequest(BRIDGE_METHODS.sceneGetTree);
    expect(first).toMatchObject({ version: PROTOCOL_VERSION, method: "scene.getTree", params: { nodePath: "." } });
    expect(first.id).not.toBe(second.id);
    expect(second.params).toEqual({});
  });
});

describe("core envelopes and errors", () => {
  it("builds stable success metadata for the Godot bridge", () => {
    const envelope = ok(
      { playing: false },
      {
        source: "godot_bridge",
        durationMs: 7,
        godotVersion: "4.7.1.stable.official",
        projectPath: "/game",
      },
      ["import still scanning"],
    );
    expect(envelope).toEqual({
      ok: true,
      data: { playing: false },
      warnings: ["import still scanning"],
      meta: {
        source: "godot_bridge",
        durationMs: 7,
        detailLevel: "normal",
        godotVersion: "4.7.1.stable.official",
        projectPath: "/game",
      },
    });
  });

  it("maps known error codes and preserves structured details", () => {
    const envelope = err(
      "PROJECT_IDENTITY_MISMATCH",
      "Wrong project",
      { source: "godot_bridge" },
      { expected: "/game-a", actual: "/game-b" },
    );
    expect(envelope.ok).toBe(false);
    if (!envelope.ok) {
      expect(envelope.error).toMatchObject({
        code: "PROJECT_IDENTITY_MISMATCH",
        message: "Wrong project",
        recoverable: true,
        details: { expected: "/game-a", actual: "/game-b" },
      });
      expect(envelope.error.suggestedAction).toContain("expected project");
    }
    expect(isErrorCode("GODOT_NOT_CONNECTED")).toBe(true);
    expect(isErrorCode("UNITY_NOT_CONNECTED")).toBe(false);
  });

  it("defines actionable metadata for every public error code", () => {
    const codes = [
      "GODOT_NOT_CONNECTED",
      "GODOT_RELOADING",
      "PLAY_MODE_REQUIRED",
      "TEST_RUNNER_NOT_CONFIGURED",
      "UNSAVED_CHANGES",
      "PROJECT_IDENTITY_MISMATCH",
      "FEATURE_UNAVAILABLE",
      "OBJECT_NOT_FOUND",
      "NODE_NOT_FOUND",
      "SCENE_NOT_OPEN",
      "METHOD_NOT_FOUND",
      "CLASS_NOT_FOUND",
      "PROPERTY_NOT_FOUND",
      "INVALID_NODE_TYPE",
      "UNSUPPORTED_VALUE",
      "CAPTURE_UNAVAILABLE",
      "FILE_WRITE_FAILED",
      "SCENE_SAVE_FAILED",
      "INVALID_REQUEST",
      "PROTOCOL_VERSION_MISMATCH",
      "RESOURCE_NOT_FOUND",
      "INVALID_ARGUMENT",
      "SAFETY_MODE_BLOCKED",
      "WRITE_REQUIRES_SNAPSHOT",
      "UNSUPPORTED_GODOT_VERSION",
      "INTERNAL_ERROR",
      "MOCK_MODE_ACTIVE",
      "BRIDGE_TIMEOUT",
      "MALFORMED_BRIDGE_RESPONSE",
      "TOOL_NOT_IMPLEMENTED",
      "PROJECT_NOT_FOUND",
      "GIT_NOT_AVAILABLE",
    ] as const;
    for (const code of codes) {
      const detail = makeError(code);
      expect(detail.code).toBe(code);
      expect(detail.message.length).toBeGreaterThan(5);
      expect(detail.suggestedAction.length).toBeGreaterThan(5);
    }
  });
});

describe("core Godot schemas", () => {
  it("validates project, import, scene, and node data returned by the addon", () => {
    const filesystem = { scanning: false, importing: false, progress: 1, indexedFiles: 42 };
    expect(FilesystemStatusSchema.safeParse(filesystem).success).toBe(true);
    expect(ProjectSummarySchema.safeParse({
      engine: "godot",
      godotVersion: "4.7.1.stable.official",
      projectName: "Signal & Steel",
      projectPath: "/games/signal-steel",
      platform: "macOS",
      openSceneCount: 1,
      editedScene: "res://scenes/main.tscn",
      isPlaying: false,
      filesystem,
    }).success).toBe(true);
    expect(OpenScenesResultSchema.safeParse({
      scenes: [{ path: "res://scenes/main.tscn", name: "Main", rootType: "Node2D", active: true, unsaved: false }],
      count: 1,
      activeScene: "res://scenes/main.tscn",
    }).success).toBe(true);

    const child = {
      name: "Player",
      type: "CharacterBody2D",
      path: "Player",
      sceneFilePath: "",
      ownerPath: ".",
      childCount: 0,
      instanceId: 2,
      children: [],
    };
    expect(GodotNodeSchema.safeParse(child).success).toBe(true);
    expect(SceneTreeResultSchema.safeParse({
      scenePath: "res://scenes/main.tscn",
      root: { ...child, name: "Main", type: "Node2D", path: ".", childCount: 1, children: [child] },
      nodeCount: 2,
      truncated: false,
    }).success).toBe(true);
  });

  it("supports JSON-safe nested Variants and rejects unsupported values", () => {
    expect(VariantSchema.safeParse({ speed: 220, tags: ["player", null], active: true }).success).toBe(true);
    expect(VariantSchema.safeParse(Symbol("not-json")).success).toBe(false);
  });

  it("requires real PNG dimensions and truthfully labels test-runner status", () => {
    expect(ScreenshotResultSchema.safeParse({
      kind: "2d",
      mimeType: "image/png",
      pngBase64: "iVBORw0KGgo=",
      path: "res://.godot/godot-vibe-os/captures/2d.png",
      absolutePath: "/game/.godot/godot-vibe-os/captures/2d.png",
      width: 1280,
      height: 720,
      bytes: 8,
    }).success).toBe(true);
    expect(ScreenshotResultSchema.safeParse({ kind: "game", mimeType: "image/png" }).success).toBe(false);

    const verify = VerifyResultSchema.parse({
      verdict: "pass",
      import: { ok: true, command: "godot --headless --import --quit", exitCode: 0, output: "" },
      scripts: { checked: 3, failed: 0, failures: [] },
      csharp: { status: "not_present", scripts: 0, projects: 0, message: "No C# scripts or project files were found." },
      tests: { status: "not_configured", message: "No project test runner was invoked." },
      warnings: [],
    });
    expect(verify.tests.status).toBe("not_configured");
    expect(VerifyResultSchema.safeParse({ ...verify, verdict: "unverified", csharp: { status: "unverified", scripts: 1, projects: 1, message: "C#/.NET verification was not performed." } }).success).toBe(true);
  });
});
