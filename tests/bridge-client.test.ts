import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it, vi } from "vitest";
import {
  bridgeCall,
  createHttpBridgeClient,
  probeEditorStall,
  readBridgeDiscovery,
  type BridgeClient,
} from "@uvibe/bridge-client";
import { BRIDGE_DISCOVERY_REL, type BridgeHealth, type BridgeMethod, type BridgeResponse } from "@uvibe/core";

const tmpDirs: string[] = [];
function tmpProject(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "uvibe-bridge-client-"));
  tmpDirs.push(dir);
  return dir;
}

function writeDiscovery(project: string, port: number, pid: number): void {
  const discoPath = path.join(project, BRIDGE_DISCOVERY_REL);
  mkdirSync(path.dirname(discoPath), { recursive: true });
  writeFileSync(
    discoPath,
    JSON.stringify({ port, host: "127.0.0.1", projectPath: project, pid }),
    "utf8"
  );
}

afterAll(() => {
  for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });
});

describe("bridge-client", () => {
  it("returns UNITY_NOT_CONNECTED against an unbound port (no discovery file)", async () => {
    const client = createHttpBridgeClient({ port: 39999, timeoutMs: 500 });
    const res = await client.call("system.health");
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("UNITY_NOT_CONNECTED");
    expect(await client.isConnected()).toBe(false);
  });

  it("readBridgeDiscovery parses a valid discovery file and fills defaults", () => {
    const project = tmpProject();
    const discoPath = path.join(project, BRIDGE_DISCOVERY_REL);
    mkdirSync(path.dirname(discoPath), { recursive: true });
    writeFileSync(discoPath, JSON.stringify({ port: 40123, unityVersion: "6000.0.1f1" }), "utf8");

    const disco = readBridgeDiscovery(project);
    expect(disco).not.toBeNull();
    expect(disco?.port).toBe(40123);
    expect(disco?.host).toBe("127.0.0.1");
    expect(disco?.projectPath).toBe(project);
    expect(disco?.unityVersion).toBe("6000.0.1f1");
  });

  it("readBridgeDiscovery returns null for missing, invalid, or portless files", () => {
    const project = tmpProject();
    expect(readBridgeDiscovery(project)).toBeNull();

    const discoPath = path.join(project, BRIDGE_DISCOVERY_REL);
    mkdirSync(path.dirname(discoPath), { recursive: true });
    writeFileSync(discoPath, "not json", "utf8");
    expect(readBridgeDiscovery(project)).toBeNull();

    writeFileSync(discoPath, JSON.stringify({ host: "127.0.0.1" }), "utf8");
    expect(readBridgeDiscovery(project)).toBeNull();
  });

  it("does not classify a socket failure as reload when the discovered Unity PID exited", async () => {
    const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
    const pid = child.pid;
    expect(pid).toBeTypeOf("number");
    await once(child, "exit");

    const project = tmpProject();
    writeDiscovery(project, 39998, pid!);
    const client = createHttpBridgeClient({ projectPath: project, timeoutMs: 500 });
    const res = await bridgeCall(client, "system.health");

    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.code).toBe("UNITY_NOT_CONNECTED");
      expect(res.error.message).toContain(`process ${pid} exited`);
      expect(res.error.details).toMatchObject({ editorExited: true, unityPid: pid });
    }
  });

  it("keeps a socket failure retryable while the discovered Unity PID is alive", async () => {
    const project = tmpProject();
    writeDiscovery(project, 39997, process.pid);
    const client = createHttpBridgeClient({ projectPath: project, timeoutMs: 500 });
    const res = await client.call("system.health");

    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("UNITY_RELOADING");
  });

  it("preserves a structured bridge error returned with HTTP 504", async () => {
    const server = http.createServer((_req, res) => {
      res.writeHead(504, { "content-type": "application/json" });
      res.end(JSON.stringify({
        id: "timeout-request",
        ok: false,
        result: null,
        error: {
          code: "BRIDGE_TIMEOUT",
          message: "Main-thread handler did not complete within 15s.",
          details: { method: "scene.getHierarchy", budgetMs: 15_000 },
        },
        meta: {
          unityVersion: "6000.0.1f1",
          projectPath: "/project",
          durationMs: 15_001,
        },
      }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;

    try {
      const client = createHttpBridgeClient({ port });
      const res = await client.call("scene.getHierarchy");
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.error.code).toBe("BRIDGE_TIMEOUT");
        expect(res.error.message).toContain("did not complete");
        expect(res.error.details).toEqual({ method: "scene.getHierarchy", budgetMs: 15_000 });
        expect(res.meta).toMatchObject({ unityVersion: "6000.0.1f1", durationMs: 15_001 });
      }
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("retries a play-mode await when domain reload cuts off an empty response", async () => {
    const project = tmpProject();
    let calls = 0;
    const server = http.createServer((_req, res) => {
      calls += 1;
      if (calls === 1) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end();
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        id: "play-ready",
        ok: true,
        result: { isPlaying: true, isPaused: false, isTransitioning: false },
        error: null,
        meta: { unityVersion: "6000.0.1f1", projectPath: project, durationMs: 1 },
      }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;
    writeDiscovery(project, port, process.pid);

    try {
      const client = createHttpBridgeClient({ projectPath: project, timeoutMs: 1000 });
      const env = await bridgeCall(client, "playmode.await");
      expect(env.ok).toBe(true);
      expect(calls).toBe(2);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("keeps an empty response malformed for calls that are unsafe to retry", async () => {
    const project = tmpProject();
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;
    writeDiscovery(project, port, process.pid);

    try {
      const client = createHttpBridgeClient({ projectPath: project, timeoutMs: 1000 });
      const res = await client.call("scene.getHierarchy");
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.error.code).toBe("MALFORMED_BRIDGE_RESPONSE");
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("rejects a parseable but schema-invalid 2xx bridge response", async () => {
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ id: "bad", ok: true, result: {}, error: null, meta: {} }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;

    try {
      const client = createHttpBridgeClient({ port });
      const res = await client.call("scene.getHierarchy");
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.error.code).toBe("MALFORMED_BRIDGE_RESPONSE");
        expect(res.error.message).toContain("schema-invalid");
      }
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("bridgeCall retries through UNITY_RELOADING and succeeds once the bridge is back", async () => {
    let calls = 0;
    const fake: BridgeClient = {
      source: "unity_bridge",
      async call<T>(method: BridgeMethod): Promise<BridgeResponse<T>> {
        calls += 1;
        if (calls < 3) {
          return {
            id: "t",
            ok: false,
            result: null,
            error: { code: "UNITY_RELOADING", message: "socket down (domain reload)" },
            meta: {},
          };
        }
        return {
          id: "t",
          ok: true,
          result: { method } as T,
          error: null,
          meta: { unityVersion: "6000.0.1f1", projectPath: "/p", durationMs: 1 },
        };
      },
      async isConnected() {
        return true;
      },
    };

    const env = await bridgeCall<{ method: string }>(fake, "system.health");
    expect(calls).toBe(3);
    expect(env.ok).toBe(true);
    if (env.ok) expect(env.data.method).toBe("system.health");
  });

  it("bridgeCall uses the method timeout instead of a fixed 20s reload ceiling", async () => {
    vi.useFakeTimers();
    try {
      let calls = 0;
      let finished = false;
      const fake: BridgeClient = {
        source: "unity_bridge",
        async call<T>(): Promise<BridgeResponse<T>> {
          calls += 1;
          return {
            id: "t",
            ok: false,
            result: null,
            error: { code: "UNITY_RELOADING", message: "domain reload" },
            meta: {},
          };
        },
        async isConnected() {
          return false;
        },
      };

      const pending = bridgeCall(fake, "asset.refresh").then((env) => {
        finished = true;
        return env;
      });
      await vi.advanceTimersByTimeAsync(21_000);
      expect(finished).toBe(false);
      await vi.advanceTimersByTimeAsync(104_001);
      const env = await pending;
      expect(env.ok).toBe(false);
      if (!env.ok) expect(env.error.code).toBe("UNITY_RELOADING");
      expect(calls).toBeGreaterThan(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("bridgeCall surfaces a terminal error without retrying", async () => {
    let calls = 0;
    const fake: BridgeClient = {
      source: "unity_bridge",
      async call<T>(): Promise<BridgeResponse<T>> {
        calls += 1;
        return {
          id: "t",
          ok: false,
          result: null,
          error: { code: "UNITY_NOT_CONNECTED", message: "no editor" },
          meta: {},
        };
      },
      async isConnected() {
        return false;
      },
    };
    const env = await bridgeCall(fake, "system.health");
    expect(calls).toBe(1);
    expect(env.ok).toBe(false);
    if (!env.ok) expect(env.error.code).toBe("UNITY_NOT_CONNECTED");
  });

  function timingOutBridge(health: BridgeHealth | null): BridgeClient & { calls: number } {
    const bridge = {
      source: "unity_bridge" as const,
      calls: 0,
      async call<T>(): Promise<BridgeResponse<T>> {
        bridge.calls += 1;
        return {
          id: "t",
          ok: false,
          result: null,
          error: { code: "BRIDGE_TIMEOUT", message: "Bridge call timed out after 500ms." },
          meta: {},
        };
      },
      async isConnected() {
        return false;
      },
      async health() {
        return health;
      },
    };
    return bridge;
  }

  const stalledHealth: BridgeHealth = {
    status: "ok",
    editorTickAgeMs: 42_000,
    keepAwakeEnabled: false,
    wasFocused: false,
  };

  it("bridgeCall upgrades BRIDGE_TIMEOUT to UNITY_EDITOR_STALLED when the editor loop is frozen unfocused", async () => {
    const env = await bridgeCall(timingOutBridge(stalledHealth), "system.health");
    expect(env.ok).toBe(false);
    if (!env.ok) {
      expect(env.error.code).toBe("UNITY_EDITOR_STALLED");
      expect(env.error.message).toContain("Keep Unity awake");
      expect(env.error.details?.editorTickAgeMs).toBe(42_000);
    }
  });

  it("bridgeCall keeps BRIDGE_TIMEOUT when the editor is focused (busy import, not a stall)", async () => {
    const env = await bridgeCall(
      timingOutBridge({ ...stalledHealth, wasFocused: true }),
      "system.health"
    );
    expect(env.ok).toBe(false);
    if (!env.ok) expect(env.error.code).toBe("BRIDGE_TIMEOUT");
  });

  it("bridgeCall keeps BRIDGE_TIMEOUT when the Unity package predates liveness reporting", async () => {
    const env = await bridgeCall(timingOutBridge({ status: "ok" }), "system.health");
    expect(env.ok).toBe(false);
    if (!env.ok) expect(env.error.code).toBe("BRIDGE_TIMEOUT");
  });

  it("probeEditorStall reports not-stalled when health is unreachable", async () => {
    const bridge = timingOutBridge(null);
    expect((await probeEditorStall(bridge)).stalled).toBe(false);
    // And when the client has no health() at all (simple test doubles).
    const { health: _health, ...rest } = bridge;
    expect((await probeEditorStall(rest as BridgeClient)).stalled).toBe(false);
  });

  it("health() fetches GET /health and returns null when unreachable", async () => {
    const server = http.createServer((req, res) => {
      if (req.method === "GET" && req.url === "/health") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ status: "ok", editorTickAgeMs: 12, keepAwakeEnabled: true, wasFocused: true }));
      } else {
        res.writeHead(404).end();
      }
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as { port: number }).port;
    try {
      const client = createHttpBridgeClient({ port });
      const health = await client.health!();
      expect(health?.status).toBe("ok");
      expect(health?.editorTickAgeMs).toBe(12);
      expect(health?.keepAwakeEnabled).toBe(true);
    } finally {
      await new Promise((r) => server.close(r));
    }

    const dead = createHttpBridgeClient({ port: 1 });
    expect(await dead.health!()).toBeNull();
  });

  it("stays MCP-SDK-free: package depends only on @uvibe/core", () => {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const pkgPath = path.join(here, "..", "packages", "bridge-client", "package.json");
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { dependencies?: Record<string, string> };
    expect(Object.keys(pkg.dependencies ?? {})).toEqual(["@uvibe/core"]);
  });
});
