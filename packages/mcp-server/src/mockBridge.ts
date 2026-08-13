import type { BridgeMethod, BridgeResponse } from "@gvibe/core";
import type { BridgeClient } from "@gvibe/bridge-client";
import { makeMockPng } from "./mockPng.js";

export function createMockBridgeClient(): BridgeClient {
  const node = { name: "Player", type: "CharacterBody2D", path: "Player", sceneFilePath: "", ownerPath: ".", childCount: 0, instanceId: 42 };
  const responders: Record<BridgeMethod, () => unknown> = {
    "system.health": () => ({ status: "ok", godotVersion: "4.7.1.mock", projectPath: "/mock/godot", uptimeMs: 12_345, isPlaying: false, filesystemScanning: false }),
    "system.summary": () => ({ engine: "godot", godotVersion: "4.7.1.mock", projectName: "MockGame", projectPath: "/mock/godot", platform: "macOS", openSceneCount: 1, editedScene: "res://scenes/main.tscn", isPlaying: false, filesystem: { scanning: false, importing: false, progress: 1, indexedFiles: 37 } }),
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
    "play.run": () => ({ playing: true, scenePath: "res://scenes/main.tscn", started: true, requestedMode: "main" }),
    "play.stop": () => ({ playing: false, scenePath: "", stopped: true }),
    "play.status": () => ({ playing: false, scenePath: "" }),
  };
  return {
    source: "mock",
    async call<T>(method: BridgeMethod): Promise<BridgeResponse<T>> {
      const responder = responders[method];
      return { id: "mock", ok: true, result: responder() as T, error: null, meta: { godotVersion: "4.7.1.mock", projectPath: "/mock/godot", durationMs: 1 } };
    },
    async isConnected() { return true; },
    async health() { return responders["system.health"]() as never; },
  };
}

function screenshot(kind: "2d" | "3d", color: [number, number, number]) {
  const image = makeMockPng(640, 360, color, `MOCK GODOT ${kind.toUpperCase()} VIEW`);
  return { kind, mimeType: "image/png", pngBase64: image.pngBase64, path: `res://.godot/godot-vibe-os/captures/${kind}.png`, absolutePath: `/mock/godot/.godot/godot-vibe-os/captures/${kind}.png`, width: image.width, height: image.height, bytes: Buffer.byteLength(image.pngBase64, "base64") };
}
