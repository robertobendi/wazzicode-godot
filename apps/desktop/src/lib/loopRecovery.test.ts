import { describe, expect, it } from "vitest";
import { buildContinuationContext, failureMessage } from "./loopRecovery";
import type { LoopState } from "@/types/loop";

function loopState(): LoopState {
  return {
    loopId: "loop-1",
    goal: "Polish the map",
    referenceImages: [],
    status: "failed",
    iterations: [
      {
        index: 0,
        verdict: "continue",
        summary: "Fixed map navigation.",
        costUsd: 0,
        screenshotPath: null,
        commitSha: "abc123",
        qa: null,
      },
    ],
    totalCostUsd: 0,
    options: {
      maxIterations: 10,
      maxCostUsd: 0,
      qaEvery: 1,
      referenceImages: [],
      agent: { backend: "codex", model: null, effort: null },
    },
    warnings: [],
    feedback: [],
    failure: {
      message: "Codex lost its connection.",
      phase: "builder",
      iteration: 1,
    },
    currentRunId: null,
  };
}

describe("Auto loop recovery", () => {
  it("carries completed work and new guidance into a continuation", () => {
    const context = buildContinuationContext(
      loopState(),
      "Prioritize controller navigation.",
    );

    expect(context).toContain("Step 1: Fixed map navigation.");
    expect(context).toContain("Do not redo completed work.");
    expect(context).toContain("Prioritize controller navigation.");
  });

  it("uses structured failures and hides stale fenced-json details", () => {
    expect(failureMessage(loopState(), "ChatGPT Codex")).toBe(
      "Codex lost its connection.",
    );

    const legacy = loopState();
    legacy.failure = null;
    legacy.warnings = ["ChatGPT Codex task failed: ```json"];
    expect(failureMessage(legacy, "ChatGPT Codex")).toMatch(
      /stopped unexpectedly/i,
    );
  });
});
