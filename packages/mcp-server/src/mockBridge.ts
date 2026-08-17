import type { BridgeMethod, BridgeResponse } from "@gvibe/core";
import type { BridgeClient } from "@gvibe/bridge-client";
import { makeMockPng } from "./mockPng.js";

export function createMockBridgeClient(): BridgeClient {
  const node = { name: "Player", type: "CharacterBody2D", path: "Player", sceneFilePath: "", ownerPath: ".", childCount: 0, instanceId: 42 };
  let playing = false;
  let playingScenePath = "";
  let lastRunScenePath = "";
  let runNumber = 0;
  let runId = "";
  let startedAtMs = 0;
  let stoppedAtMs: number | null = null;
  let sampleCursor = 0;
  let screenshotId = "";
  let debugScreenshot: ReturnType<typeof runtimeScreenshot> | null = null;
  let frameCapture: { captureId: string; requested: MockFrameRequest; frames: ReturnType<typeof runtimeFrame>[] } | null = null;
  const responders: Record<BridgeMethod, (params: Record<string, unknown>) => unknown> = {
    "system.health": () => ({ status: "ok", godotVersion: "4.7.1.mock", projectPath: "/mock/godot", uptimeMs: 12_345, isPlaying: playing, filesystemScanning: false }),
    "system.summary": () => ({ engine: "godot", godotVersion: "4.7.1.mock", projectName: "MockGame", projectPath: "/mock/godot", platform: "macOS", openSceneCount: 1, editedScene: "res://scenes/main.tscn", isPlaying: playing, filesystem: { scanning: false, importing: false, progress: 1, indexedFiles: 37 } }),
    "scene.getOpenScenes": () => ({ scenes: [{ path: "res://scenes/main.tscn", name: "Main", rootType: "Node2D", active: true, unsaved: false }], count: 1, activeScene: "res://scenes/main.tscn" }),
    "scene.getTree": () => ({ scenePath: "res://scenes/main.tscn", root: { name: "Main", type: "Node2D", path: ".", sceneFilePath: "res://scenes/main.tscn", ownerPath: ".", childCount: 1, instanceId: 1, children: [{ ...node, children: [] }] }, nodeCount: 2, truncated: false }),
    "selection.inspect": () => ({ nodes: [node], count: 1 }),
    "filesystem.status": () => ({ scanning: false, importing: false, progress: 1, indexedFiles: 37 }),
    "filesystem.scan": () => ({ scanning: true, importing: false, progress: 0, indexedFiles: 37, requested: true }),
    "resource.getDependencies": () => ({ path: "res://scenes/main.tscn", dependencies: [{ path: "res://scripts/player.gd", type: "Script", uid: "uid://mock", raw: "uid://mock::Script::res://scripts/player.gd" }], count: 1 }),
    "reflect.query": () => ({ query: "CharacterBody2D", classes: [{ name: "CharacterBody2D", parent: "PhysicsBody2D", instantiable: true, properties: [], methods: [], signals: [] }], count: 1 }),
    "viewport.capture2D": () => screenshot("2d", [42, 126, 176]),
    "viewport.capture3D": () => screenshot("3d", [56, 95, 150]),
    "scene.open": () => ({ path: "res://scenes/main.tscn", opened: true }),
    "scene.save": () => ({ path: "res://scenes/main.tscn", saved: true }),
    "edit.setProperty": () => ({ nodePath: "Player", property: "speed", previous: 200, value: 240 }),
    "edit.createNode": () => ({ ...node, name: "NewNode", path: "NewNode" }),
    "edit.deleteNode": () => ({ nodePath: "Player", deleted: true }),
    "edit.reparentNode": () => ({ nodePath: "World/Player", parentPath: "World" }),
    "edit.instantiateScene": () => ({ ...node, sourceScene: "res://actors/player.tscn" }),
    "play.run": (params) => {
      const wasPlaying = playing;
      playing = true;
      if (!wasPlaying) {
        runNumber += 1;
        runId = `mock-run-${runNumber}`;
        startedAtMs = Date.now();
        stoppedAtMs = null;
        sampleCursor = 0;
        screenshotId = "";
        debugScreenshot = null;
      }
      const mode = params.mode === "current" || params.mode === "custom" ? params.mode : "main";
      const scenePath = mode === "custom" && typeof params.path === "string" ? params.path : "res://scenes/main.tscn";
      playingScenePath = scenePath;
      lastRunScenePath = scenePath;
      return { playing, scenePath, started: !wasPlaying, requestedMode: mode };
    },
    "play.stop": () => {
      playing = false;
      playingScenePath = "";
      stoppedAtMs = Date.now();
      return { playing: false, scenePath: "", stopped: true };
    },
    "play.status": () => ({ playing, scenePath: playingScenePath }),
    "debug.snapshot": (params) => {
      if (playing) sampleCursor += 1;
      if (params.requestScreenshot === true && screenshotId.length === 0) {
        screenshotId = `mock-capture-${runNumber || 1}`;
        debugScreenshot = runtimeScreenshot(screenshotId);
      }
      const sample = playing ? [{
        cursor: sampleCursor,
        timestampMs: Date.now(),
        fps: 60,
        processMs: 8.25,
        physicsMs: 2.5,
        memoryBytes: 67_108_864,
        objectCount: 128,
        nodeCount: 12,
        orphanNodeCount: 0,
        drawCalls: 24,
      }] : [];
      const sinceSampleCursor = typeof params.sinceSampleCursor === "number" ? params.sinceSampleCursor : 0;
      const samples = sample.filter((entry) => entry.cursor > sinceSampleCursor);
      return {
        runId,
        sessionId: runId ? runNumber : null,
        runtimeConnected: playing,
        playing,
        breaked: false,
        startedAtMs,
        stoppedAtMs,
        eventCursor: 0,
        sampleCursor,
        firstEventCursor: 0,
        firstSampleCursor: samples[0]?.cursor ?? 0,
        missedEvents: 0,
        missedSamples: 0,
        events: [],
        samples,
        droppedEvents: 0,
        droppedSamples: 0,
        runtime: runId ? { scenePath: lastRunScenePath, rootName: "Main", rootType: "Node2D", nodeCount: 12, pid: 12_345 } : null,
        screenshotId,
        screenshot: params.includeScreenshot === true ? debugScreenshot : null,
        capturePending: false,
        captureError: null,
      };
    },
    "debug.captureFrames": (params) => {
      const requestedId = typeof params.captureId === "string" ? params.captureId : "";
      if (requestedId.length === 0) {
        const requested: MockFrameRequest = {
          frames: clampInt(params.frames, 2, 16, 8),
          intervalMs: clampInt(params.intervalMs, 100, 2_000, 400),
          width: clampInt(params.width, 160, 1_280, 480),
          format: params.format === "png" ? "png" : "jpg",
          quality: clampInt(params.quality, 1, 100, 70),
        };
        if (!playing) {
          frameCapture = null;
          return framePage(null, "not_running", requested, params, "The runtime probe is not connected.");
        }
        frameCapture = {
          captureId: `mock-frames-${runNumber || 1}`,
          requested,
          frames: Array.from({ length: requested.frames }, (_, index) => runtimeFrame(index + 1, requested)),
        };
        return framePage(frameCapture, "complete", requested, params, null);
      }
      if (!frameCapture || frameCapture.captureId !== requestedId) {
        return framePage(null, "error", frameCapture?.requested ?? MOCK_FRAME_REQUEST, params, "That frame capture sequence is no longer active.");
      }
      return framePage(frameCapture, "complete", frameCapture.requested, params, null);
    },
  };
  return {
    source: "mock",
    async call<T>(method: BridgeMethod, params: Record<string, unknown> = {}): Promise<BridgeResponse<T>> {
      if (method === "play.stop" && typeof params.expectedRunId === "string" && params.expectedRunId !== runId) {
        return { id: "mock", ok: false, result: null, error: { code: "RUN_CHANGED", message: "The active game is not the run this request started; it was left running." }, meta: { godotVersion: "4.7.1.mock", projectPath: "/mock/godot", durationMs: 1 } };
      }
      const responder = responders[method];
      return { id: "mock", ok: true, result: responder(params) as T, error: null, meta: { godotVersion: "4.7.1.mock", projectPath: "/mock/godot", durationMs: 1 } };
    },
    async isConnected() { return true; },
    async health() { return responders["system.health"]({}) as never; },
  };
}

interface MockFrameRequest { frames: number; intervalMs: number; width: number; format: "jpg" | "png"; quality: number }
const MOCK_FRAME_REQUEST: MockFrameRequest = { frames: 8, intervalMs: 400, width: 480, format: "jpg", quality: 70 };

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  return typeof value === "number" && Number.isInteger(value) ? Math.min(max, Math.max(min, value)) : fallback;
}

/**
 * Mock frames alternate between two fully-opposed average hashes every two frames, so the
 * "changed" dedup policy has a deterministic sequence to reduce.
 */
function runtimeFrame(index: number, requested: MockFrameRequest) {
  const alternating = Math.floor((index - 1) / 2) % 2 === 0;
  const image = makeMockPng(requested.width, Math.round(requested.width * 0.5625), alternating ? [46, 160, 109] : [176, 96, 42], "MOCK GAME FRAME");
  return {
    index,
    tMs: (index - 1) * requested.intervalMs,
    deltaMs: index === 1 ? 0 : requested.intervalMs,
    frameTimeMs: 8.25,
    captureCostMs: 3.5,
    // The mock PNG generator produces real PNG bytes whatever format the caller asked for.
    mimeType: "image/png" as const,
    base64: image.pngBase64,
    width: image.width,
    height: image.height,
    bytes: Buffer.byteLength(image.pngBase64, "base64"),
    hash: alternating ? "0000000000000000" : "ffffffffffffffff",
  };
}

function framePage(
  capture: { captureId: string; frames: ReturnType<typeof runtimeFrame>[] } | null,
  state: "pending" | "complete" | "error" | "not_running",
  requested: MockFrameRequest,
  params: Record<string, unknown>,
  error: string | null,
) {
  const frames = capture?.frames ?? [];
  const since = typeof params.sinceIndex === "number" ? params.sinceIndex : 0;
  const maxFrames = clampInt(params.maxFrames, 1, 4, 4);
  return {
    captureId: capture?.captureId ?? "",
    state,
    runId: capture ? capture.captureId : "",
    requested,
    capturedCount: frames.length,
    frameCursor: frames.at(-1)?.index ?? 0,
    frames: frames.filter((frame) => frame.index > since).slice(0, maxFrames),
    droppedFrames: 0,
    error,
  };
}

function runtimeScreenshot(id: string) {
  const image = makeMockPng(640, 360, [46, 160, 109], "MOCK GODOT DEBUG RUN");
  return { id, mimeType: "image/png" as const, pngBase64: image.pngBase64, width: image.width, height: image.height, bytes: Buffer.byteLength(image.pngBase64, "base64"), capturedAtMs: Date.now() };
}

function screenshot(kind: "2d" | "3d", color: [number, number, number]) {
  const image = makeMockPng(640, 360, color, `MOCK GODOT ${kind.toUpperCase()} VIEW`);
  return { kind, mimeType: "image/png", pngBase64: image.pngBase64, path: `res://.godot/godot-vibe-os/captures/${kind}.png`, absolutePath: `/mock/godot/.godot/godot-vibe-os/captures/${kind}.png`, width: image.width, height: image.height, bytes: Buffer.byteLength(image.pngBase64, "base64") };
}
