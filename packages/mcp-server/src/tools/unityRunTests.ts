import { z } from "zod";
import { ToolDef } from "../registry.js";
import { BRIDGE_METHODS, bridgeCall, isUnknownMethodError } from "./_helpers.js";
import { TestRunStatus, ToolEnvelope, err, isErrorCode } from "@uvibe/core";

/** Single long-poll round is capped server-side; re-issue until our own deadline. */
const AWAIT_WINDOW_MS = 25_000;

const InputShape = {
  mode: z.enum(["EditMode", "PlayMode"]).optional(),
  filter: z
    .string()
    .optional()
    .describe("Run only tests whose full name matches this (e.g. 'MyNamespace.MyTests')."),
  timeoutMs: z
    .number()
    .int()
    .min(1000)
    .max(1_800_000)
    .optional()
    .describe("Max time to wait for the run to finish (default 5 min)."),
  pollMs: z.number().int().min(200).max(10_000).optional(),
};

export const unityRunTests: ToolDef<typeof InputShape, TestRunStatus> = {
  name: "unity_run_tests",
  description:
    "Runs the Unity Test Framework (EditMode by default, or PlayMode) and returns structured pass/fail results with messages and stack traces — the agent's ground truth for whether code actually works, not just compiles. Starts the run, then waits server-side until it completes (PlayMode runs reload the domain; this rides through that). Requires com.unity.test-framework; without it the bridge returns TEST_FRAMEWORK_MISSING. Use `filter` to scope to a subset.",
  requires: ["unity_bridge"],
  inputShape: InputShape,
  async run(args, ctx) {
    const mode = args.mode ?? "EditMode";
    const timeoutMs = args.timeoutMs ?? 300_000;
    const pollMs = args.pollMs ?? 1000;

    const started = await bridgeCall<TestRunStatus>(ctx.bridge, BRIDGE_METHODS.testRun, {
      mode,
      filter: args.filter,
    });
    if (!started.ok) return started; // e.g. TEST_FRAMEWORK_MISSING

    const runId = started.data.runId;
    if (typeof runId !== "string" || runId.trim().length === 0) {
      return err(
        "MALFORMED_BRIDGE_RESPONSE",
        "test.run returned a missing or empty runId.",
        started.meta,
        { method: BRIDGE_METHODS.testRun, actualRunId: runId }
      );
    }
    if (ctx.configMockMode) {
      // Mock bridge resolves synchronously; one status fetch returns the completed run.
      const s = await bridgeCall<TestRunStatus>(ctx.bridge, BRIDGE_METHODS.testStatus, { runId });
      if (!s.ok) return s;
      const mismatch = mismatchedRunStatus(s, runId, BRIDGE_METHODS.testStatus);
      if (mismatch) return mismatch;
      return s;
    }
    const start = Date.now();
    let last: ToolEnvelope<TestRunStatus> = started;
    // Fast path: test.await holds the request open inside Unity and settles within ~50ms of
    // the run finishing. Falls back to client-side test.status polling on older packages.
    let useAwait = true;
    while (Date.now() - start < timeoutMs) {
      const remaining = timeoutMs - (Date.now() - start);
      let status: ToolEnvelope<TestRunStatus>;
      if (useAwait) {
        status = await bridgeCall<TestRunStatus>(
          ctx.bridge,
          BRIDGE_METHODS.testAwait,
          {
            runId,
            timeoutMs: Math.min(remaining, AWAIT_WINDOW_MS),
          },
          "normal",
          { reloadTimeoutMs: remaining }
        );
      } else {
        const delayMs = Math.min(pollMs, Math.max(0, remaining));
        if (delayMs > 0) await sleep(delayMs);
        const afterSleepRemaining = timeoutMs - (Date.now() - start);
        if (afterSleepRemaining <= 0) break;
        status = await bridgeCall<TestRunStatus>(
          ctx.bridge,
          BRIDGE_METHODS.testStatus,
          { runId },
          "normal",
          { reloadTimeoutMs: afterSleepRemaining }
        );
      }
      if (!status.ok) {
        if (useAwait && isUnknownMethodError(status)) {
          useAwait = false; // older Unity package
          continue;
        }
        // UNITY_RELOADING is already retried inside bridgeCall; anything else is terminal.
        const code = isErrorCode(status.error.code) ? status.error.code : "INTERNAL_ERROR";
        if (code === "UNITY_RELOADING") {
          if (Date.now() - start >= timeoutMs) break;
          continue;
        }
        return status;
      }
      const mismatch = mismatchedRunStatus(
        status,
        runId,
        useAwait ? BRIDGE_METHODS.testAwait : BRIDGE_METHODS.testStatus
      );
      if (mismatch) return mismatch;
      last = status;
      if (status.data.state !== "running") {
        if (status.data.failed && status.data.failed > 0) {
          status.warnings.push(`${status.data.failed} test(s) failed.`);
        }
        return status;
      }
      // Awaits that settle while the persisted state still says "running" (write race right at
      // run end) shouldn't busy-loop — give the collector a beat to flush.
      if (useAwait && status.data.settled !== false) {
        const remainingAfterCall = timeoutMs - (Date.now() - start);
        const delayMs = Math.min(200, Math.max(0, remainingAfterCall));
        if (delayMs > 0) await sleep(delayMs);
      }
    }
    return err(
      "BRIDGE_TIMEOUT",
      `Timed out after ${timeoutMs}ms waiting for Unity tests to finish.`,
      { source: ctx.bridge.source, durationMs: Date.now() - start },
      {
        timeoutMs,
        runId,
        ...(last.ok ? { lastStatus: last.data } : {}),
      }
    );
  },
};

function mismatchedRunStatus(
  status: ToolEnvelope<TestRunStatus>,
  expectedRunId: string,
  method: string
): ToolEnvelope<TestRunStatus> | undefined {
  if (!status.ok || status.data.runId === expectedRunId) return undefined;
  return err(
    "MALFORMED_BRIDGE_RESPONSE",
    `${method} returned status for run '${status.data.runId}' while waiting for run '${expectedRunId}'.`,
    status.meta,
    { method, expectedRunId, actualRunId: status.data.runId }
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
