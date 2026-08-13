import http from "node:http";
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  bridgeCall,
  createHttpBridgeClient,
  readBridgeDiscovery,
  timeoutForMethod,
  type BridgeClient,
} from "@gvibe/bridge-client";
import {
  BRIDGE_DISCOVERY_REL,
  BRIDGE_METHODS,
  BridgeResultSchemas,
  PROTOCOL_VERSION,
  type BridgeDiscovery,
  type BridgeMethod,
  type BridgeResponse,
} from "@gvibe/core";
import { createMockBridgeClient } from "../packages/mcp-server/src/mockBridge.js";

const temporaryProjects: string[] = [];
const servers: http.Server[] = [];
const STRONG_TOKEN = "0123456789abcdef0123456789abcdef";

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => closeServer(server)));
  await Promise.all(temporaryProjects.splice(0).map((project) => rm(project, { recursive: true, force: true })));
});

async function temporaryProject(): Promise<string> {
  const project = await mkdtemp(path.join(os.tmpdir(), "gvibe-bridge-test-"));
  temporaryProjects.push(project);
  return project;
}

async function listen(handler: http.RequestListener): Promise<{ server: http.Server; port: number }> {
  const server = http.createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, port: (server.address() as { port: number }).port };
}

async function writeDiscovery(
  project: string,
  port: number,
  override: Partial<BridgeDiscovery> = {},
): Promise<void> {
  const file = path.join(project, BRIDGE_DISCOVERY_REL);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify({
    port,
    host: "127.0.0.1",
    projectPath: project,
    godotVersion: "4.7.1.stable.official",
    pid: process.pid,
    protocolVersion: PROTOCOL_VERSION,
    startedAt: Date.now(),
    token: STRONG_TOKEN,
    ...override,
  }), "utf8");
}

function closeServer(server: http.Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

function healthResult(projectPath: string) {
  return {
    status: "ok",
    godotVersion: "4.7.1.stable.official",
    projectPath,
    uptimeMs: 123,
    isPlaying: false,
    filesystemScanning: false,
  } as const;
}

const nodeResult = {
  name: "Player",
  type: "CharacterBody2D",
  path: "Player",
  sceneFilePath: "",
  ownerPath: ".",
  childCount: 0,
  instanceId: 42,
};

const validBridgeResults = {
  "system.health": healthResult("/game"),
  "system.summary": {
    engine: "godot",
    godotVersion: "4.7.1.stable.official",
    projectName: "Game",
    projectPath: "/game",
    platform: "macOS",
    openSceneCount: 1,
    editedScene: "res://scenes/main.tscn",
    isPlaying: false,
    filesystem: { scanning: false, importing: false, progress: 1, indexedFiles: 37 },
  },
  "scene.getOpenScenes": {
    scenes: [{ path: "res://scenes/main.tscn", name: "Main", rootType: "Node2D", active: true, unsaved: false }],
    count: 1,
    activeScene: "res://scenes/main.tscn",
  },
  "scene.getTree": {
    scenePath: "res://scenes/main.tscn",
    root: { ...nodeResult, name: "Main", type: "Node2D", path: ".", childCount: 1, children: [{ ...nodeResult, children: [] }] },
    nodeCount: 2,
    truncated: false,
  },
  "selection.inspect": { nodes: [nodeResult], count: 1 },
  "filesystem.status": { scanning: false, importing: false, progress: 1, indexedFiles: 37 },
  "filesystem.scan": { scanning: true, importing: false, progress: 0, indexedFiles: 37, requested: true },
  "resource.getDependencies": {
    path: "res://scenes/main.tscn",
    dependencies: [{ path: "res://scripts/player.gd", type: "Script", uid: "uid://player", raw: "uid://player::Script::res://scripts/player.gd" }],
    count: 1,
  },
  "reflect.query": {
    query: "CharacterBody2D",
    classes: [{ name: "CharacterBody2D", parent: "PhysicsBody2D", instantiable: true, properties: [], methods: [], signals: [] }],
    count: 1,
  },
  "viewport.capture2D": {
    kind: "2d", mimeType: "image/png", pngBase64: "iVBORw0KGgo=", path: "res://.godot/capture.png",
    absolutePath: "/game/.godot/capture.png", width: 1280, height: 720, bytes: 8,
  },
  "viewport.capture3D": {
    kind: "3d", mimeType: "image/png", pngBase64: "iVBORw0KGgo=", path: "res://.godot/capture.png",
    absolutePath: "/game/.godot/capture.png", width: 1280, height: 720, bytes: 8,
  },
  "scene.open": { path: "res://scenes/main.tscn", opened: true },
  "scene.save": { path: "res://scenes/main.tscn", saved: true },
  "edit.setProperty": { nodePath: "Player", property: "speed", previous: 200, value: 240 },
  "edit.createNode": { ...nodeResult, name: "NewNode", path: "NewNode" },
  "edit.deleteNode": { nodePath: "Player", deleted: true },
  "edit.reparentNode": { nodePath: "World/Player", parentPath: "World" },
  "edit.instantiateScene": { ...nodeResult, sourceScene: "res://actors/player.tscn" },
  "play.run": { playing: true, scenePath: "res://scenes/main.tscn", started: true, requestedMode: "main" },
  "play.stop": { playing: false, scenePath: "", stopped: true },
  "play.status": { playing: false, scenePath: "" },
} satisfies Record<BridgeMethod, unknown>;

describe("bridge discovery", () => {
  it("reads a complete authenticated addon discovery", async () => {
    const project = await temporaryProject();
    await writeDiscovery(project, 40123);

    expect(readBridgeDiscovery(project)).toEqual({
      port: 40123,
      host: "127.0.0.1",
      projectPath: await realpath(project),
      godotVersion: "4.7.1.stable.official",
      pid: process.pid,
      protocolVersion: PROTOCOL_VERSION,
      startedAt: expect.any(Number),
      token: STRONG_TOKEN,
    });
  });

  it("rejects missing, malformed, unauthenticated, remote, and incompatible discovery", async () => {
    const project = await temporaryProject();
    expect(readBridgeDiscovery(project)).toBeNull();
    const file = path.join(project, BRIDGE_DISCOVERY_REL);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, "not json", "utf8");
    expect(readBridgeDiscovery(project)).toBeNull();
    await writeFile(file, JSON.stringify({ host: "127.0.0.1" }), "utf8");
    expect(readBridgeDiscovery(project)).toBeNull();

    for (const override of [
      { port: 0 },
      { port: 65_536 },
      { port: 4.5 },
      { host: "192.0.2.1" },
      { host: "0.0.0.0" },
      { protocolVersion: "999" },
      { token: "" },
      { token: "short-token" },
      { projectPath: path.join(project, "different-project") },
    ] satisfies Partial<BridgeDiscovery>[]) {
      await writeDiscovery(project, 40123, override);
      expect(readBridgeDiscovery(project)).toBeNull();
    }
  });

  it("does not read discovery through a symlink outside the project", async () => {
    const project = await temporaryProject();
    const outside = await temporaryProject();
    const outsideFile = path.join(outside, "bridge.json");
    await writeDiscovery(project, 40123);
    await writeFile(outsideFile, await readFile(path.join(project, BRIDGE_DISCOVERY_REL)), "utf8");
    await rm(path.join(project, BRIDGE_DISCOVERY_REL));
    await symlink(outsideFile, path.join(project, BRIDGE_DISCOVERY_REL));

    expect(readBridgeDiscovery(project)).toBeNull();
  });
});

describe("authenticated HTTP bridge", () => {
  it("rejects remote or invalid explicit targets before opening a socket", () => {
    expect(() => createHttpBridgeClient({ host: "192.0.2.1", port: 40123 })).toThrow(/loopback/);
    expect(() => createHttpBridgeClient({ port: 65_536 })).toThrow(/1 to 65535/);
    expect(() => createHttpBridgeClient({ port: 40123, token: "short" })).toThrow(/32-512/);
  });

  it("sends the per-launch token and a versioned RPC request", async () => {
    const project = await temporaryProject();
    let observed: { token?: string; method?: string; version?: string; params?: unknown } = {};
    const { port } = await listen((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { id: string; method: string; version: string; params: unknown };
        observed = {
          token: request.headers["x-godot-vibe-token"] as string,
          method: body.method,
          version: body.version,
          params: body.params,
        };
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({
          id: body.id,
          ok: true,
          result: healthResult(project),
          error: null,
          meta: { godotVersion: "4.7.1.stable.official", projectPath: project, durationMs: 2 },
        }));
      });
    });
    const token = "secret-per-launch-0123456789abcdef";
    await writeDiscovery(project, port, { token });

    const response = await createHttpBridgeClient({ projectPath: project }).call("system.health", { verbose: true });
    expect(response.ok).toBe(true);
    expect(observed).toEqual({
      token,
      method: "system.health",
      version: PROTOCOL_VERSION,
      params: { verbose: true },
    });
  });

  it("authenticates the health endpoint too", async () => {
    const project = await temporaryProject();
    const otherProject = await temporaryProject();
    let token: string | undefined;
    const { port } = await listen((request, response) => {
      token = request.headers["x-godot-vibe-token"] as string | undefined;
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(healthResult(project)));
    });
    const healthToken = "health-token-0123456789abcdefghij";
    await writeDiscovery(project, port, { token: healthToken });
    const health = await createHttpBridgeClient({ projectPath: project }).health?.();
    expect(health).toMatchObject({ status: "ok", projectPath: project });
    expect(token).toBe(healthToken);
    expect(await createHttpBridgeClient({ port, token: healthToken, projectPath: otherProject }).health?.()).toBeNull();
  });

  it("rejects a healthy response from a different Godot project", async () => {
    const project = await temporaryProject();
    const { port } = await listen((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { id: string };
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({
          id: body.id,
          ok: true,
          result: healthResult("/another/game"),
          error: null,
          meta: { godotVersion: "4.7.1", projectPath: "/another/game", durationMs: 1 },
        }));
      });
    });
    await writeDiscovery(project, port);

    const response = await createHttpBridgeClient({ projectPath: project }).call("system.health");
    expect(response.ok).toBe(false);
    if (!response.ok) {
      expect(response.error.code).toBe("PROJECT_IDENTITY_MISMATCH");
      expect(response.error.message).toContain("/another/game");
    }
  });

  it("preserves a structured bridge error even when HTTP status is non-2xx", async () => {
    const { port } = await listen((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { id: string };
        response.writeHead(504, { "content-type": "application/json" });
        response.end(JSON.stringify({
          id: body.id,
          ok: false,
          result: null,
          error: {
            code: "BRIDGE_TIMEOUT",
            message: "Editor operation exceeded its main-thread budget.",
            details: { method: "filesystem.scan", budgetMs: 120_000 },
          },
          meta: { godotVersion: "4.7.1", projectPath: "/game", durationMs: 120_001 },
        }));
      });
    });
    const response = await createHttpBridgeClient({ port, token: STRONG_TOKEN }).call("filesystem.scan");
    expect(response.ok).toBe(false);
    if (!response.ok) {
      expect(response.error).toMatchObject({ code: "BRIDGE_TIMEOUT", details: { method: "filesystem.scan" } });
      expect(response.meta).toMatchObject({ godotVersion: "4.7.1", durationMs: 120_001 });
    }
  });

  it("maps generic HTTP failures and invalid success payloads to stable errors", async () => {
    const unauthorized = await listen((_request, response) => {
      response.writeHead(401, { "content-type": "text/plain" });
      response.end("bad token");
    });
    const first = await createHttpBridgeClient({ port: unauthorized.port }).call("system.health");
    expect(first.ok).toBe(false);
    if (!first.ok) {
      expect(first.error.code).toBe("GODOT_NOT_CONNECTED");
      expect(first.error.message).toContain("HTTP 401");
    }

    const malformed = await listen((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ id: "bad", ok: true, result: {}, error: null, meta: {} }));
    });
    const second = await createHttpBridgeClient({ port: malformed.port }).call("scene.getTree");
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.error.code).toBe("MALFORMED_BRIDGE_RESPONSE");
  });

  it("validates the live result contract for every bridge method", async () => {
    const { port } = await listen((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
          id: string;
          method: BridgeMethod;
        };
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({
          id: body.id,
          ok: true,
          result: validBridgeResults[body.method],
          error: null,
          meta: { godotVersion: "4.7.1", projectPath: "/game", durationMs: 1 },
        }));
      });
    });
    const client = createHttpBridgeClient({ port, token: STRONG_TOKEN });
    for (const method of Object.values(BRIDGE_METHODS)) {
      const response = await client.call(method);
      expect(response.ok, method).toBe(true);
    }
  });

  it("keeps every mock result aligned with the live result schemas", async () => {
    const mock = createMockBridgeClient();
    for (const method of Object.values(BRIDGE_METHODS)) {
      const response = await mock.call(method);
      expect(response.ok, method).toBe(true);
      if (response.ok) {
        expect(BridgeResultSchemas[method].safeParse(response.result).success, method).toBe(true);
      }
    }
  });

  it("maps method-specific result drift and response-id drift to MALFORMED_BRIDGE_RESPONSE", async () => {
    let wrongId = false;
    const { port } = await listen((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { id: string };
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({
          id: wrongId ? "another-request" : body.id,
          ok: true,
          result: {},
          error: null,
          meta: { godotVersion: "4.7.1", projectPath: "/game", durationMs: 1 },
        }));
      });
    });
    const client = createHttpBridgeClient({ port, token: STRONG_TOKEN });
    for (const method of Object.values(BRIDGE_METHODS)) {
      const response = await client.call(method);
      expect(response.ok, method).toBe(false);
      if (!response.ok) {
        expect(response.error.code, method).toBe("MALFORMED_BRIDGE_RESPONSE");
        expect(response.error.message, method).toContain(method);
      }
    }

    wrongId = true;
    const response = await client.call("system.health");
    expect(response.ok).toBe(false);
    if (!response.ok) {
      expect(response.error.code).toBe("MALFORMED_BRIDGE_RESPONSE");
      expect(response.error.message).toContain("request id");
    }
  });

  it("uses the caller project path for discovery and success/error response identity", async () => {
    const project = await temporaryProject();
    const claimedProject = await temporaryProject();
    await writeDiscovery(project, 40123, { projectPath: claimedProject });
    expect(readBridgeDiscovery(project)).toBeNull();

    let returnError = false;
    const { port } = await listen((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { id: string };
        response.writeHead(returnError ? 400 : 200, { "content-type": "application/json" });
        response.end(JSON.stringify(returnError ? {
          id: body.id,
          ok: false,
          result: null,
          error: { code: "INVALID_ARGUMENT", message: "Bad input." },
          meta: { godotVersion: "4.7.1", projectPath: claimedProject, durationMs: 1 },
        } : {
          id: body.id,
          ok: true,
          result: healthResult(claimedProject),
          error: null,
          meta: { godotVersion: "4.7.1", projectPath: claimedProject, durationMs: 1 },
        }));
      });
    });
    const relativeProject = path.relative(process.cwd(), project);
    const client = createHttpBridgeClient({
      port,
      token: STRONG_TOKEN,
      projectPath: relativeProject,
    });
    for (returnError of [false, true]) {
      const response = await client.call("system.health");
      expect(response.ok).toBe(false);
      if (!response.ok) {
        expect(response.error.code).toBe("PROJECT_IDENTITY_MISMATCH");
        expect(response.error.details).toMatchObject({
          expected: await realpath(project),
          actual: await realpath(claimedProject),
        });
      }
    }
  });
});

describe("transport recovery", () => {
  it("distinguishes an undiscovered editor from a known addon reload", async () => {
    const temporary = await listen((_request, response) => response.end());
    const deadPort = temporary.port;
    await closeServer(temporary.server);
    servers.splice(servers.indexOf(temporary.server), 1);

    const unknown = await createHttpBridgeClient({ port: deadPort, timeoutMs: 500 }).call("system.health");
    expect(unknown.ok).toBe(false);
    if (!unknown.ok) expect(unknown.error.code).toBe("GODOT_NOT_CONNECTED");

    const project = await temporaryProject();
    await writeDiscovery(project, deadPort, { pid: process.pid });
    const known = await createHttpBridgeClient({ projectPath: project, timeoutMs: 500 }).call("system.health");
    expect(known.ok).toBe(false);
    if (!known.ok) expect(known.error.code).toBe("GODOT_RELOADING");
  });

  it("reports when the discovered Godot process has exited", async () => {
    const temporary = await listen((_request, response) => response.end());
    const deadPort = temporary.port;
    await closeServer(temporary.server);
    servers.splice(servers.indexOf(temporary.server), 1);
    const project = await temporaryProject();
    const exitedPid = 2_147_483_647;
    await writeDiscovery(project, deadPort, { pid: exitedPid });

    const response = await createHttpBridgeClient({ projectPath: project, timeoutMs: 500 }).call("system.health");
    expect(response.ok).toBe(false);
    if (!response.ok) {
      expect(response.error.code).toBe("GODOT_NOT_CONNECTED");
      expect(response.error.details).toMatchObject({ editorExited: true, godotPid: exitedPid });
    }
  });

  it("bridgeCall retries addon reloads, then returns a normal Godot envelope", async () => {
    let calls = 0;
    const bridge: BridgeClient = {
      source: "godot_bridge",
      async call<T>(method: BridgeMethod): Promise<BridgeResponse<T>> {
        calls += 1;
        if (calls < 3) {
          return {
            id: "retry",
            ok: false,
            result: null,
            error: { code: "GODOT_RELOADING", message: "addon is reloading" },
            meta: {},
          };
        }
        return {
          id: "ready",
          ok: true,
          result: { method } as T,
          error: null,
          meta: { godotVersion: "4.7.1", projectPath: "/game", durationMs: 1 },
        };
      },
      async isConnected() { return true; },
    };

    const envelope = await bridgeCall<{ method: string }>(bridge, "system.health", {}, "summary", { reloadTimeoutMs: 2_000 });
    expect(calls).toBe(3);
    expect(envelope.ok).toBe(true);
    if (envelope.ok) {
      expect(envelope.data.method).toBe("system.health");
      expect(envelope.meta).toMatchObject({ source: "godot_bridge", detailLevel: "summary", godotVersion: "4.7.1" });
    }
  });

  it("assigns wider budgets only to known slow editor operations", () => {
    expect(timeoutForMethod("filesystem.scan")).toBe(125_000);
    expect(timeoutForMethod("resource.getDependencies")).toBe(60_000);
    expect(timeoutForMethod("play.run")).toBe(45_000);
    expect(timeoutForMethod("viewport.capture3D")).toBe(30_000);
    expect(timeoutForMethod("scene.getTree")).toBe(20_000);
  });
});
