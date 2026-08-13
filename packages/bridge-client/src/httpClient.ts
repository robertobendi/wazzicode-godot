import { readFileSync, realpathSync } from "node:fs";
import http from "node:http";
import path from "node:path";
import {
  BridgeDiscovery,
  BridgeHealth,
  BridgeMethod,
  BridgeResponse,
  BridgeResultSchemas,
  BRIDGE_DISCOVERY_REL,
  DEFAULT_BRIDGE_HOST,
  DEFAULT_BRIDGE_PORT,
  PROTOCOL_VERSION,
  SystemHealthResultSchema,
  makeBridgeRequest,
} from "@gvibe/core";

export type BridgeSource = "godot_bridge" | "mock";

export interface BridgeClient {
  readonly source: BridgeSource;
  call<T = unknown>(method: BridgeMethod, params?: Record<string, unknown>): Promise<BridgeResponse<T>>;
  isConnected(): Promise<boolean>;
  /**
   * GET /health. Returns null when the addon is unreachable.
   */
  health?(): Promise<BridgeHealth | null>;
}

export interface HttpBridgeOptions {
  host?: string;
  /** Explicit port. When set, discovery is skipped (used by tests and manual overrides). */
  port?: number;
  /** Per-launch addon token. Required with an explicit real bridge port. */
  token?: string;
  /**
   * Force a single timeout for every call, overriding the per-method budget. Mainly for tests
   * (e.g. timeoutMs:500 against an unbound port). In normal operation leave this unset so each
   * method gets a budget that matches the editor operation (see timeoutForMethod).
   */
  timeoutMs?: number;
  /**
   * Project root. When set, discovery selects the editor instance serving that project.
   */
  projectPath?: string;
}

export type PublicBridgeDiscovery = Omit<BridgeDiscovery, "token">;

export function redactBridgeDiscovery(discovery: BridgeDiscovery | null): PublicBridgeDiscovery | null {
  if (!discovery) return null;
  return {
    port: discovery.port,
    host: discovery.host,
    projectPath: discovery.projectPath,
    godotVersion: discovery.godotVersion,
    pid: discovery.pid,
    protocolVersion: discovery.protocolVersion,
    startedAt: discovery.startedAt,
  };
}

/**
 * Godot editor operations run on the editor thread. File scans and play transitions receive
 * wider budgets than small inspection calls.
 */
const METHOD_TIMEOUT_MS: Record<string, number> = {
  "filesystem.scan": 125_000,
  "resource.getDependencies": 60_000,
  "play.run": 45_000,
  "play.stop": 45_000,
  "viewport.capture2D": 30_000,
  "viewport.capture3D": 30_000,
};

const DEFAULT_TIMEOUT_MS = 20_000;
const MIN_DISCOVERY_TOKEN_LENGTH = 32;
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1"]);

const RELOAD_SAFE_EMPTY_RESPONSE_METHODS = new Set<string>([
  "play.run",
  "play.stop",
  "filesystem.scan",
]);

export function timeoutForMethod(method: string): number {
  return METHOD_TIMEOUT_MS[method] ?? DEFAULT_TIMEOUT_MS;
}

/**
 * Read the discovery file written by the enabled Godot editor addon.
 */
export function readBridgeDiscovery(projectPath: string): BridgeDiscovery | null {
  try {
    const projectRoot = canonicalPath(projectPath);
    const discoveryPath = realpathSync.native(path.join(projectRoot, BRIDGE_DISCOVERY_REL));
    if (!isWithinPath(projectRoot, discoveryPath)) return null;
    const raw = readFileSync(discoveryPath, "utf8");
    const d = JSON.parse(raw) as unknown;
    if (!isRecord(d)) return null;
    if (!isValidPort(d.port)) return null;
    if (typeof d.host !== "string" || !LOOPBACK_HOSTS.has(d.host)) return null;
    if (typeof d.projectPath !== "string" || d.projectPath.length === 0) return null;
    if (!samePath(d.projectPath, projectPath)) return null;
    if (typeof d.godotVersion !== "string" || d.godotVersion.length === 0) return null;
    if (!Number.isInteger(d.pid) || (d.pid as number) <= 0) return null;
    if (!Number.isInteger(d.startedAt) || (d.startedAt as number) <= 0) return null;
    if (d.protocolVersion !== PROTOCOL_VERSION) return null;
    if (!isStrongDiscoveryToken(d.token)) return null;
    return {
      port: d.port,
      host: d.host,
      projectPath: canonicalPath(d.projectPath),
      godotVersion: d.godotVersion,
      pid: d.pid as number,
      protocolVersion: d.protocolVersion,
      startedAt: d.startedAt as number,
      token: d.token,
    };
  } catch {
    // No discovery file — the addon has not started here, or this is not a project root.
  }
  return null;
}

export function createHttpBridgeClient(opts: HttpBridgeOptions = {}): BridgeClient {
  const explicitPort = opts.port;
  const projectPath = opts.projectPath;
  const expectedProject = projectPath ? canonicalPath(projectPath) : undefined;
  if (explicitPort !== undefined && !isValidPort(explicitPort)) {
    throw new Error("Explicit Godot bridge port must be an integer from 1 to 65535.");
  }
  if (opts.host !== undefined && !LOOPBACK_HOSTS.has(opts.host)) {
    throw new Error("Godot bridge host must be a loopback address.");
  }
  if (explicitPort !== undefined && opts.token !== undefined && !isStrongDiscoveryToken(opts.token)) {
    throw new Error(`Explicit Godot bridge token must be ${MIN_DISCOVERY_TOKEN_LENGTH}-512 safe characters.`);
  }
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
    godotPid?: number;
    token?: string;
    bridgeKnown: boolean;
  } {
    const disco = discovery();
    if (explicitPort !== undefined) {
      return {
        host: opts.host ?? DEFAULT_BRIDGE_HOST,
        port: explicitPort,
        expectProject: expectedProject,
        token: opts.token,
        bridgeKnown: false,
      };
    }
    if (disco) {
      return {
        host: disco.host,
        port: disco.port,
        expectProject: expectedProject,
        godotPid: disco.pid > 0 ? disco.pid : undefined,
        token: disco.token,
        bridgeKnown: true,
      };
    }
    return {
      host: opts.host ?? DEFAULT_BRIDGE_HOST,
      port: opts.port ?? DEFAULT_BRIDGE_PORT,
      expectProject: expectedProject,
      bridgeKnown: false,
    };
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
          const editorExited = t.godotPid !== undefined && processHasExited(t.godotPid);
          const code = t.bridgeKnown && !editorExited ? "GODOT_RELOADING" : "GODOT_NOT_CONNECTED";
          finish({
            id: body.id,
            ok: false,
            result: null,
            error: {
              code,
              message: editorExited
                ? `Godot Editor process ${t.godotPid} exited while handling '${method}'.`
                : message,
              ...(editorExited
                ? { details: { editorExited: true, godotPid: t.godotPid, method } }
                : {}),
            },
            meta: {},
          });
        };
        if (t.godotPid !== undefined) setTimeout(classify, 100);
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
            ...(t.token ? { "X-Godot-Vibe-Token": t.token } : {}),
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
                  `Bridge response ended while the Godot addon reloaded during '${method}'.`
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
                finish(validateBridgeResponse<T>(body.id, method, parsed, t.expectProject, text));
              } else {
                finish(httpStatusError(body.id, status, text));
              }
              return;
            }
            if (!isBridgeResponse<T>(parsed)) {
              finish(malformedBridgeResponse(body.id, text));
              return;
            }
            finish(validateBridgeResponse<T>(body.id, method, parsed, t.expectProject, text));
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
        // On a native abort the socket can close just before the OS reaps the editor.
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
        {
          host: t.host,
          port: t.port,
          path: "/health",
          method: "GET",
          agent,
          timeout: 2_000,
          headers: t.token ? { "X-Godot-Vibe-Token": t.token } : {},
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (c: Buffer) => chunks.push(c));
          res.on("end", () => {
            if ((res.statusCode ?? 0) < 200 || (res.statusCode ?? 0) >= 300) {
              resolve(null);
              return;
            }
            try {
              const parsed = SystemHealthResultSchema.safeParse(
                JSON.parse(Buffer.concat(chunks).toString("utf8")),
              );
              if (!parsed.success) {
                resolve(null);
                return;
              }
              if (t.expectProject && !samePath(parsed.data.projectPath, t.expectProject)) {
                resolve(null);
                return;
              }
              resolve(parsed.data);
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

  return { source: "godot_bridge", call, isConnected, health };
}

/** True only when the OS confirms that a previously discovered Godot PID no longer exists. */
function processHasExited(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "ESRCH";
  }
}

function canonicalPath(value: string): string {
  const resolved = path.resolve(value);
  try {
    return realpathSync.native(resolved);
  } catch {
    return resolved;
  }
}

function samePath(a: string, b: string): boolean {
  const normalize = (value: string) => {
    const canonical = canonicalPath(value).replace(/[\\/]+$/, "");
    return process.platform === "win32" ? canonical.toLowerCase() : canonical;
  };
  return normalize(a) === normalize(b);
}

function isWithinPath(root: string, candidate: string): boolean {
  const normalize = (value: string) => {
    const normalized = path.resolve(value).replace(/[\\/]+$/, "");
    return process.platform === "win32" ? normalized.toLowerCase() : normalized;
  };
  const normalizedRoot = normalize(root);
  const normalizedCandidate = normalize(candidate);
  return normalizedCandidate.startsWith(`${normalizedRoot}${path.sep}`);
}

function isValidPort(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 65_535;
}

function isStrongDiscoveryToken(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length >= MIN_DISCOVERY_TOKEN_LENGTH &&
    value.length <= 512 &&
    /^[A-Za-z0-9+/_=-]+$/.test(value)
  );
}

function isBridgeResponse<T>(value: unknown): value is BridgeResponse<T> {
  if (!isRecord(value) || typeof value.id !== "string" || !isRecord(value.meta)) return false;
  if (value.ok === true) {
    return (
      Object.prototype.hasOwnProperty.call(value, "result") &&
      value.error === null &&
      typeof value.meta.godotVersion === "string" &&
      typeof value.meta.projectPath === "string" &&
      typeof value.meta.durationMs === "number" &&
      Number.isFinite(value.meta.durationMs) &&
      value.meta.durationMs >= 0
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
    (!Object.prototype.hasOwnProperty.call(value.error, "details") || isRecord(value.error.details)) &&
    isRecord(value.meta)
  );
}

function validateBridgeResponse<T>(
  requestId: string,
  method: BridgeMethod,
  response: BridgeResponse<unknown>,
  expectedProject: string | undefined,
  text: string,
): BridgeResponse<T> {
  if (response.id !== requestId) {
    return malformedBridgeResponse(
      requestId,
      text,
      "Bridge response id did not match the request id.",
      { expectedId: requestId, actualId: response.id },
    );
  }

  if (expectedProject) {
    const actualProject = response.meta.projectPath;
    if (typeof actualProject !== "string" || actualProject.length === 0) {
      return malformedBridgeResponse(
        requestId,
        text,
        "Bridge response omitted the project identity.",
        { expectedProject },
      );
    }
    if (!samePath(actualProject, expectedProject)) {
      return {
        id: requestId,
        ok: false,
        result: null,
        error: {
          code: "PROJECT_IDENTITY_MISMATCH",
          message: `Connected Godot is '${actualProject}' but expected '${expectedProject}'.`,
          details: { expected: expectedProject, actual: canonicalPath(actualProject) },
        },
        meta: response.meta,
      };
    }
  }

  if (!response.ok) return response as BridgeResponse<T>;
  const parsedResult = BridgeResultSchemas[method].safeParse(response.result);
  if (!parsedResult.success) {
    return malformedBridgeResponse(
      requestId,
      text,
      `Bridge result for '${method}' did not match its schema.`,
      { method, issues: parsedResult.error.issues },
    );
  }
  return { ...response, result: parsedResult.data } as BridgeResponse<T>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function malformedBridgeResponse(
  id: string,
  text: string,
  message = "Bridge returned a schema-invalid JSON payload.",
  details: Record<string, unknown> = {},
): BridgeResponse<never> {
  return {
    id,
    ok: false,
    result: null,
    error: {
      code: "MALFORMED_BRIDGE_RESPONSE",
      message,
      details: { sample: text.slice(0, 200), ...details },
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
      code: "GODOT_NOT_CONNECTED",
      message: `Godot bridge HTTP ${status}: ${text.slice(0, 200)}`,
    },
    meta: {},
  };
}
