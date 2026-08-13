import { z } from "zod";
import { ToolDef } from "../registry.js";
import { BRIDGE_METHODS, bridgeCall, isUnknownMethodError, probeEditorStall } from "./_helpers.js";
import { CompileStatus, ToolEnvelope, err, isErrorCode } from "@uvibe/core";

const InputShape = {
  timeoutMs: z.number().int().min(500).max(300_000).optional(),
  pollMs: z.number().int().min(100).max(5_000).optional(),
};

/** Single long-poll round is capped server-side; re-issue until our own deadline. */
const AWAIT_WINDOW_MS = 25_000;

export const unityWaitForCompile: ToolDef<typeof InputShape, CompileStatus> = {
  name: "unity_wait_for_compile",
  description:
    "Waits until Unity's authoritative compile status is idle and returns the final status with error/warning counts. A deadline reached while isCompiling remains true is a hard BRIDGE_TIMEOUT, never a stale success. Uses a server-side long-poll and falls back to client-side polling against older Unity packages.",
  requires: ["unity_bridge"],
  inputShape: InputShape,
  async run(args, ctx) {
    const timeoutMs = args.timeoutMs ?? 60_000;
    const pollMs = args.pollMs ?? 500;
    const start = Date.now();
    let last: ToolEnvelope<CompileStatus> | undefined;
    // Fast path: compile.await holds the request open inside Unity and settles within ~50ms of
    // the compile finishing — no client-side poll interval to wait out.
    let useAwait = true;
    while (Date.now() - start < timeoutMs) {
      if (useAwait) {
        const remaining = timeoutMs - (Date.now() - start);
        last = await bridgeCall<CompileStatus>(
          ctx.bridge,
          BRIDGE_METHODS.compileAwait,
          { timeoutMs: Math.min(remaining, AWAIT_WINDOW_MS) },
          "normal",
          { reloadTimeoutMs: remaining }
        );
        if (last.ok) {
          if (!last.data.isCompiling) return last;
          // `isCompiling` is authoritative. A contradictory settled=true response must not escape
          // as success; add a short backoff because a broken/old await can return it immediately.
          if (last.data.settled !== false) {
            const remainingAfterCall = timeoutMs - (Date.now() - start);
            const backoffMs = Math.min(pollMs, 500, Math.max(0, remainingAfterCall));
            if (backoffMs > 0) await sleep(backoffMs);
          }
          continue; // long-poll window closed while still compiling — re-issue
        }
        if (isUnknownMethodError(last)) {
          useAwait = false; // older Unity package: fall back to client-side polling
          continue;
        }
        if (last.error.code === "UNITY_RELOADING" && Date.now() - start >= timeoutMs) break;
        const errCode = isErrorCode(last.error.code) ? last.error.code : "INTERNAL_ERROR";
        return err(errCode, last.error.message, last.meta);
      }
      const remaining = timeoutMs - (Date.now() - start);
      last = await bridgeCall<CompileStatus>(
        ctx.bridge,
        BRIDGE_METHODS.compileStatus,
        {},
        "normal",
        { reloadTimeoutMs: Math.max(0, remaining) }
      );
      if (!last.ok) {
        if (last.error.code === "UNITY_RELOADING" && Date.now() - start >= timeoutMs) break;
        const errCode = isErrorCode(last.error.code) ? last.error.code : "INTERNAL_ERROR";
        return err(errCode, last.error.message, last.meta);
      }
      if (!last.data.isCompiling) return last;
      const remainingAfterCall = timeoutMs - (Date.now() - start);
      const delayMs = Math.min(pollMs, Math.max(0, remainingAfterCall));
      if (delayMs > 0) await sleep(delayMs);
    }
    if (last?.ok) {
      // Distinguish "compile is slow" from "the editor loop is frozen and this will never
      // finish" — the latter must be a hard error or the agent retries forever.
      const { stalled, health } = await probeEditorStall(ctx.bridge);
      if (stalled && health) {
        return err(
          "UNITY_EDITOR_STALLED",
          `Compilation cannot progress: Unity's editor loop has not ticked for ${Math.round((health.editorTickAgeMs ?? 0) / 1000)}s (window unfocused, keep-awake ${health.keepAwakeEnabled === false ? "OFF" : "not working"}). Ask the user to focus Unity or enable Window ▸ Unity Vibe OS ▸ Keep Unity awake (background); do not retry until then.`,
          { source: ctx.bridge.source },
          { editorTickAgeMs: health.editorTickAgeMs, keepAwakeEnabled: health.keepAwakeEnabled }
        );
      }
    }
    return err(
      "BRIDGE_TIMEOUT",
      last?.ok
        ? `Timed out after ${timeoutMs}ms while Unity was still compiling.`
        : `Timed out after ${timeoutMs}ms waiting for Unity to recover and report compile status.`,
      { source: ctx.bridge.source, durationMs: Date.now() - start },
      {
        timeoutMs,
        ...(last?.ok ? { lastStatus: last.data } : {}),
        ...(last && !last.ok ? { lastError: last.error.code } : {}),
      }
    );
  },
};

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
