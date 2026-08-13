import {
  BridgeMethod,
  BridgeResponse,
  ErrorCode,
  isErrorCode,
  ToolEnvelope,
  err,
  ok,
  timed,
} from "@gvibe/core";
import { BridgeClient, timeoutForMethod } from "./httpClient.js";

/** Lift one editor RPC response into the stable MCP envelope and ride through addon reloads. */
export async function bridgeCall<T>(
  bridge: BridgeClient,
  method: BridgeMethod,
  params: Record<string, unknown> = {},
  detailLevel: "summary" | "normal" | "full" = "normal",
  options: { reloadTimeoutMs?: number } = {},
): Promise<ToolEnvelope<T>> {
  const requested = options.reloadTimeoutMs ?? timeoutForMethod(method);
  const reloadTimeoutMs = Number.isFinite(requested) ? Math.max(0, requested) : timeoutForMethod(method);
  const deadline = Date.now() + reloadTimeoutMs;
  let result: BridgeResponse<T>;
  let durationMs = 0;
  let retryMs = 150;
  for (;;) {
    const call = await timed(() => bridge.call<T>(method, params));
    result = call.result;
    durationMs += call.durationMs;
    if (result.ok || result.error.code !== "GODOT_RELOADING" || Date.now() >= deadline) break;
    await new Promise((resolve) => setTimeout(resolve, Math.min(retryMs, deadline - Date.now())));
    retryMs = Math.min(800, Math.round(retryMs * 1.6));
  }
  if (!result.ok) {
    const code: ErrorCode = isErrorCode(result.error.code) ? result.error.code : "INTERNAL_ERROR";
    return err(code, result.error.message, { source: bridge.source, durationMs, detailLevel }, result.error.details);
  }
  return ok(result.result, {
    source: bridge.source,
    durationMs,
    detailLevel,
    godotVersion: result.meta.godotVersion,
    projectPath: result.meta.projectPath,
  });
}

export function isUnknownMethodError(env: ToolEnvelope<unknown>): boolean {
  return !env.ok && /unknown method|no responder/i.test(env.error.message ?? "");
}
