import { readFileSync } from "node:fs";
import http from "node:http";
import path from "node:path";
import {
  BridgeDiscovery,
  BridgeHealth,
  BridgeMethod,
  BridgeResponse,
  BRIDGE_DISCOVERY_REL,
  DEFAULT_BRIDGE_HOST,
  DEFAULT_BRIDGE_PORT,
  makeBridgeRequest,
} from "@uvibe/core";

export type BridgeSource = "unity_bridge" | "mock";

export interface BridgeClient {
  readonly source: BridgeSource;
  call<T = unknown>(method: BridgeMethod, params?: Record<string, unknown>): Promise<BridgeResponse<T>>;
  isConnected(): Promise<boolean>;
  /**
   * GET /health — answered by the bridge off Unity's main thread, so it works even while the
   * editor loop is frozen. Returns null when the bridge is unreachable. Optional so simple
   * test doubles don't have to implement it.
   */
  health?(): Promise<BridgeHealth | null>;
}

export interface HttpBridgeOptions {
  host?: string;
  /** Explicit port. When set, discovery is skipped (used by tests and manual overrides). */
  port?: number;
  /**
   * Force a single timeout for every call, overriding the per-method budget. Mainly for tests
   * (e.g. timeoutMs:500 against an unbound port). In normal operation leave this unset so each
   * method gets a budget that matches what the Unity side actually allows it (see timeoutForMethod).
   */
  timeoutMs?: number;
  /**
   * Project root. When set (and no explicit port given), the client reads
   * Library/UnityVibeOS/bridge.json to learn the actual bound port and to verify it is
   * talking to the right Unity Editor instance.
   */
  projectPath?: string;
}

/**
 * Per-method client-side timeout, in milliseconds. The Unity bridge gives each method its own
 * main-thread budget (BridgeServer.TimeoutFor) — up to 120s for asset-graph scans and 60s for
 * play-mode transitions — and returns its own BRIDGE_TIMEOUT at that budget. A flat 5s client
 * timeout would abort those calls long before Unity finished, so we mirror the server budgets
 * here with a few seconds of network slack on top. Anything not listed gets a safe default.
 */
const METHOD_TIMEOUT_MS: Record<string, number> = {
  // Asset / reference-graph scans walk the whole AssetDatabase.
  "asset.findReferences": 125_000,
  "asset.findDependencies": 125_000,
  "asset.findMissingScripts": 125_000,
  "asset.findMissingReferences": 125_000,
  "asset.refresh": 125_000,
  // Play-mode transitions trigger a domain reload / scene (un)load.
  "playmode.enter": 65_000,
  "playmode.exit": 65_000,
  // Long-poll awaits hold the HTTP request open server-side for up to 25s per round.
  "compile.await": 30_000,
  "playmode.await": 30_000,
  "test.await": 30_000,
  // Multi-frame stepping long-polls in the same way.
  "playmode.step": 30_000,
  // Test runner kicks off an async job; the polling tool calls these repeatedly.
  "test.run": 35_000,
  "test.status": 35_000,
  // Script edits and in-Editor code execution can trigger an import / compile.
  "script.create": 40_000,
  "script.applyEdits": 40_000,
  "script.applyStructuredEdits": 40_000,
  "code.execute": 60_000,
};

const DEFAULT_TIMEOUT_MS = 20_000;

const RELOAD_SAFE_EMPTY_RESPONSE_METHODS = new Set<string>([
  "playmode.enter",
  "playmode.exit",
  "playmode.await",
  "compile.await",
  "test.await",
  "asset.refresh",
]);

export function timeoutForMethod(method: string): number {
  return METHOD_TIMEOUT_MS[method] ?? DEFAULT_TIMEOUT_MS;
}

/**
 * Read the bridge discovery file Unity writes at Library/UnityVibeOS/bridge.json.
 * Returns null when the file is missing or unparseable (Unity bridge never started here,
 * or the path is not a project root).
 */
export function readBridgeDiscovery(projectPath: string): BridgeDiscovery | null {
  try {
    const raw = readFileSync(path.join(projectPath, BRIDGE_DISCOVERY_REL), "utf8");
    const d = JSON.parse(raw) as Partial<BridgeDiscovery>;
    if (typeof d.port === "number" && d.port > 0) {
      return {
        port: d.port,
        host: d.host ?? DEFAULT_BRIDGE_HOST,
        projectPath: d.projectPath ?? projectPath,
        unityVersion: d.unityVersion ?? "",
        pid: d.pid ?? 0,
        protocolVersion: d.protocolVersion ?? "",
        startedAt: d.startedAt ?? 0,
      };
    }
  } catch {
    // No discovery file — Unity bridge has never started here, or this isn't a project root.
  }
  return null;
}

export function createHttpBridgeClient(opts: HttpBridgeOptions = {}): BridgeClient {
  const explicitPort = opts.port;
  const projectPath = opts.projectPath;
  // An explicit timeoutMs forces one budget for every call (tests). Otherwise each method gets
  // its own budget via timeoutForMethod, resolved per call below.
  const forcedTimeoutMs = opts.timeoutMs;

  // One keep-alive agent per client: the MCP server makes a steady stream of small RPC calls to
  // the same localhost bridge, so reusing TCP connections removes a connect/handshake per call.
  const agent = new http.Agent({ keepAlive: true, maxSockets: 8, keepAliveMsecs: 1000 });

  // Deliberately synchronous read: the discovery file is <300 bytes on a local disk, read at
  // most once per second thanks to this cache, and the call path immediately performs local
  // HTTP anyway. Making it async would restructure target()/call() for no measurable gain.
  let cached: { at: number; disco: BridgeDiscovery | null } | null = null;
  function discovery(): BridgeDiscovery | null {
    if (explicitPort !== undefined || !projectPath) return null;
    const now = Date.now();
    if (cached && now - cached.at < 1000) return cached.disco;
    const disco = readBridgeDiscovery(projectPath);
    cached = { at: now, disco };
    return disco;
  }

  function target(): {
    host: string;
    port: number;
    expectProject?: string;
    unityPid?: number;
    bridgeKnown: boolean;
  } {
    const disco = discovery();
    if (explicitPort !== undefined) {
      return { host: opts.host ?? DEFAULT_BRIDGE_HOST, port: explicitPort, bridgeKnown: false };
    }
    if (disco) {
      return {
        host: disco.host,
        port: disco.port,
        expectProject: disco.projectPath,
        unityPid: disco.pid > 0 ? disco.pid : undefined,
        bridgeKnown: true,
      };
    }
    return { host: opts.host ?? DEFAULT_BRIDGE_HOST, port: opts.port ?? DEFAULT_BRIDGE_PORT, bridgeKnown: false };
  }

  function call<T>(
    method: BridgeMethod,
    params: Record<string, unknown> = {}
  ): Promise<BridgeResponse<T>> {
    const body = makeBridgeRequest(method, params);
    const payload = JSON.stringify(body);
    const t = target();
    const timeoutMs = forcedTimeoutMs ?? timeoutForMethod(method);

    return new Promise<BridgeResponse<T>>((resolve) => {
      let settled = false;
      let timedOut = false;
      const finish = (r: BridgeResponse<T>) => {
        if (settled) return;
        settled = true;
        resolve(r);
      };
      const finishTransportFailure = (message: string) => {
        const classify = () => {
          const editorExited = t.unityPid !== undefined && processHasExited(t.unityPid);
          const code = t.bridgeKnown && !editorExited ? "UNITY_RELOADING" : "UNITY_NOT_CONNECTED";
          finish({
            id: body.id,
            ok: false,
            result: null,
            error: {
              code,
              message: editorExited
                ? `Unity Editor process ${t.unityPid} exited while handling '${method}'.`
                : message,
              ...(editorExited
                ? { details: { editorExited: true, unityPid: t.unityPid, method } }
                : {}),
            },
            meta: {},
          });
        };
        if (t.unityPid !== undefined) setTimeout(classify, 100);
        else classify();
      };

      const req = http.request(
        {
          host: t.host,
          port: t.port,
          path: "/rpc",
          method: "POST",
          agent,
          timeout: timeoutMs,
          headers: {
            "content-type": "application/json",
            "content-length": Buffer.byteLength(payload),
            connection: "keep-alive",
          },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (c: Buffer) => chunks.push(c));
          res.on("end", () => {
            const text = Buffer.concat(chunks).toString("utf8");
            const status = res.statusCode ?? 0;
            let parsed: unknown;
            try {
              parsed = JSON.parse(text) as unknown;
            } catch {
              if (status < 200 || status >= 300) {
                finish(httpStatusError(body.id, status, text));
                return;
              }
              if (
                text.length === 0 &&
                t.bridgeKnown &&
                RELOAD_SAFE_EMPTY_RESPONSE_METHODS.has(method)
              ) {
                finishTransportFailure(
                  `Bridge response ended while Unity reloaded during '${method}'.`
                );
                return;
              }
              finish({
                id: body.id,
                ok: false,
                result: null,
                error: {
                  code: "MALFORMED_BRIDGE_RESPONSE",
                  message: `Bridge returned non-JSON payload (length=${text.length}).`,
                  details: { sample: text.slice(0, 200) },
                },
                meta: {},
              });
              return;
            }
            if (status < 200 || status >= 300) {
              if (isBridgeErrorResponse(parsed)) {
                finish(parsed);
              } else {
                finish(httpStatusError(body.id, status, text));
              }
              return;
            }
            if (!isBridgeResponse<T>(parsed)) {
              finish(malformedBridgeResponse(body.id, text));
              return;
            }
            // Identity guard: the Editor that answered must be the project Claude works in.
            if (parsed.ok && t.expectProject && parsed.meta?.projectPath) {
              if (!samePath(parsed.meta.projectPath, t.expectProject)) {
                finish({
                  id: body.id,
                  ok: false,
                  result: null,
                  error: {
                    code: "PROJECT_IDENTITY_MISMATCH",
                    message: `Connected Unity is '${parsed.meta.projectPath}' but expected '${t.expectProject}'.`,
                  },
                  meta: parsed.meta,
                });
                return;
              }
            }
            finish(parsed);
          });
        }
      );

      req.on("timeout", () => {
        timedOut = true;
        req.destroy();
      });

      req.on("error", (e: NodeJS.ErrnoException) => {
        if (timedOut) {
          finish({
            id: body.id,
            ok: false,
            result: null,
            error: { code: "BRIDGE_TIMEOUT", message: `Bridge call timed out after ${timeoutMs}ms.` },
            meta: {},
          });
          return;
        }
        // On a native abort the socket closes just before the OS reaps Unity. Give that transition
        // a short grace window; a domain reload keeps the same PID alive and remains retryable.
        finishTransportFailure(e?.message ?? "Bridge call failed.");
      });

      req.write(payload);
      req.end();
    });
  }

  async function isConnected(): Promise<boolean> {
    const res = await call("system.health");
    return res.ok;
  }

  function health(): Promise<BridgeHealth | null> {
    const t = target();
    return new Promise((resolve) => {
      const req = http.request(
        { host: t.host, port: t.port, path: "/health", method: "GET", agent, timeout: 2_000 },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (c: Buffer) => chunks.push(c));
          res.on("end", () => {
            try {
              resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")) as BridgeHealth);
            } catch {
              resolve(null);
            }
          });
        }
      );
      req.on("timeout", () => req.destroy());
      req.on("error", () => resolve(null));
      req.end();
    });
  }

  return { source: "unity_bridge", call, isConnected, health };
}

/** True only when the OS confirms that a previously discovered Unity PID no longer exists. */
function processHasExited(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "ESRCH";
  }
}

function samePath(a: string, b: string): boolean {
  const norm = (s: string) => path.resolve(s).replace(/[\\/]+$/, "").toLowerCase();
  return norm(a) === norm(b);
}

function isBridgeResponse<T>(value: unknown): value is BridgeResponse<T> {
  if (!isRecord(value) || typeof value.id !== "string" || !isRecord(value.meta)) return false;
  if (value.ok === true) {
    return (
      Object.prototype.hasOwnProperty.call(value, "result") &&
      value.error === null &&
      typeof value.meta.unityVersion === "string" &&
      typeof value.meta.projectPath === "string" &&
      typeof value.meta.durationMs === "number"
    );
  }
  return isBridgeErrorResponse(value);
}

function isBridgeErrorResponse(
  value: unknown
): value is Extract<BridgeResponse<unknown>, { ok: false }> {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    value.ok === false &&
    value.result === null &&
    isRecord(value.error) &&
    typeof value.error.code === "string" &&
    typeof value.error.message === "string" &&
    isRecord(value.meta)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function malformedBridgeResponse(id: string, text: string): BridgeResponse<never> {
  return {
    id,
    ok: false,
    result: null,
    error: {
      code: "MALFORMED_BRIDGE_RESPONSE",
      message: "Bridge returned a schema-invalid JSON payload.",
      details: { sample: text.slice(0, 200) },
    },
    meta: {},
  };
}

function httpStatusError(id: string, status: number, text: string): BridgeResponse<never> {
  return {
    id,
    ok: false,
    result: null,
    error: {
      code: "UNITY_NOT_CONNECTED",
      message: `Unity bridge HTTP ${status}: ${text.slice(0, 200)}`,
    },
    meta: {},
  };
}
