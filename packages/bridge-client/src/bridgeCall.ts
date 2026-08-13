import {
  BridgeHealth,
  BridgeMethod,
  BridgeResponse,
  EDITOR_STALL_THRESHOLD_MS,
  ErrorCode,
  isErrorCode,
  ToolEnvelope,
  ToolEnvelopeErr,
  ToolMeta,
  err,
  ok,
  timed,
} from "@uvibe/core";
import { BridgeClient, timeoutForMethod } from "./httpClient.js";

/**
 * Probe GET /health (always answered, even with a frozen editor loop) and report whether Unity
 * is stalled in the background: loop not ticking AND window unfocused. A focused-but-silent loop
 * is a blocking import/compile — busy, not stalled — and old Unity packages (no liveness fields)
 * can't be distinguished, so both report not-stalled.
 */
export async function probeEditorStall(
  bridge: BridgeClient
): Promise<{ stalled: boolean; health: BridgeHealth | null }> {
  const health = (await bridge.health?.()) ?? null;
  const stalled =
    health !== null &&
    typeof health.editorTickAgeMs === "number" &&
    health.editorTickAgeMs > EDITOR_STALL_THRESHOLD_MS &&
    health.wasFocused === false;
  return { stalled, health };
}

function stallError(health: BridgeHealth, meta: Partial<ToolMeta>): ToolEnvelopeErr {
  const ageS = Math.round((health.editorTickAgeMs ?? 0) / 1000);
  const keepAwake = health.keepAwakeEnabled === false ? "OFF" : "on (but not working — try updating the UnityVibeOS package)";
  return err(
    "UNITY_EDITOR_STALLED",
    `Unity's editor loop has not ticked for ${ageS}s and the window is unfocused; 'Keep Unity awake (background)' is ${keepAwake}. Nothing will progress until Unity wakes: ask the user to focus the Unity window or enable Window ▸ Unity Vibe OS ▸ Keep Unity awake (background). Do not retry until then.`,
    meta,
    { editorTickAgeMs: health.editorTickAgeMs, keepAwakeEnabled: health.keepAwakeEnabled }
  );
}

/**
 * Run a single bridge call and lift the bridge envelope into the MCP tool envelope.
 * Source is taken from the bridge ("unity_bridge" | "mock").
 *
 * Rides through script-domain reloads: a recompile (or entering play mode) briefly drops
 * the bridge socket, surfaced as UNITY_RELOADING. Rather than fail the tool, we wait and
 * retry within the method's verified timeout budget so the call resumes once Unity is back.
 * Long-running orchestration can pass its remaining overall budget via reloadTimeoutMs.
 */
export async function bridgeCall<T>(
  bridge: BridgeClient,
  method: BridgeMethod,
  params: Record<string, unknown> = {},
  detailLevel: "summary" | "normal" | "full" = "normal",
  options: { reloadTimeoutMs?: number } = {}
): Promise<ToolEnvelope<T>> {
  const requestedReloadTimeout = options.reloadTimeoutMs ?? timeoutForMethod(method);
  const reloadTimeoutMs = Number.isFinite(requestedReloadTimeout)
    ? Math.max(0, requestedReloadTimeout)
    : timeoutForMethod(method);
  const reloadDeadline = Date.now() + reloadTimeoutMs;
  let result: BridgeResponse<T>;
  let durationMs = 0;
  // Short reloads are common (small script change), so start retrying quickly and back off.
  let retryMs = 150;
  for (;;) {
    const timedCall = await timed(() => bridge.call<T>(method, params));
    result = timedCall.result;
    durationMs += timedCall.durationMs;
    if (result.ok || result.error.code !== "UNITY_RELOADING" || Date.now() >= reloadDeadline) break;
    const remainingReloadMs = reloadDeadline - Date.now();
    await new Promise((r) => setTimeout(r, Math.min(retryMs, remainingReloadMs)));
    if (Date.now() >= reloadDeadline) break;
    retryMs = Math.min(800, Math.round(retryMs * 1.6));
  }
  if (!result.ok) {
    const code: ErrorCode = isErrorCode(result.error.code)
      ? result.error.code
      : "INTERNAL_ERROR";
    const meta = { source: bridge.source, durationMs, detailLevel };
    // A timeout against a frozen (unfocused, keep-awake off) editor never resolves by retrying —
    // upgrade it to the hard, actionable stall error so the agent stops looping and tells the user.
    if (code === "BRIDGE_TIMEOUT" || code === "UNITY_RELOADING") {
      const { stalled, health } = await probeEditorStall(bridge);
      if (stalled && health) return stallError(health, meta);
    }
    return err(code, result.error.message, meta, result.error.details);
  }
  return ok(result.result, {
    source: bridge.source,
    durationMs,
    detailLevel,
    unityVersion: result.meta?.unityVersion,
    projectPath: result.meta?.projectPath,
  });
}

/**
 * True when the bridge answered but does not know the method — i.e. the Unity package predates
 * a newer protocol method (e.g. the long-poll awaits). Callers use this to fall back to the
 * legacy polling path instead of failing.
 */
export function isUnknownMethodError(env: ToolEnvelope<unknown>): boolean {
  if (env.ok) return false;
  return /unknown method|no responder/i.test(env.error.message ?? "");
}
