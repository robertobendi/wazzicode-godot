import { describe, expect, it } from "vitest";
import type { ChatMessage } from "@/types/chat";
import {
  collectGodotDebugRun,
  collectGodotDiagnostics,
  formatGodotEvidenceGaps,
  isGodotDebugRunActivity,
  isGodotVerifyActivity,
  parseGodotDebugEvidence,
  shouldRetainGodotRawResult,
} from "./godotDiagnostics";

function message(
  result: unknown,
  options: {
    name?: string;
    status?: "running" | "ok" | "error";
    startedAt?: number;
  } = {},
): ChatMessage {
  const raw = result === undefined
    ? undefined
    : JSON.stringify({ ok: true, data: result });
  return {
    id: "message",
    role: "assistant",
    text: "",
    streaming: false,
    attachments: [],
    createdAt: 1,
    activities: [
      {
        id: "verify",
        toolUseId: "verify",
        name: options.name ?? "mcp__godot-vibe-os__godot_verify",
        friendlyLabel: "Verifying the Godot project",
        status: options.status ?? "ok",
        ...(raw ? { resultRaw: raw, resultText: raw } : {}),
        startedAt: options.startedAt ?? 10,
        ...(options.status === "running" ? {} : { endedAt: 11 }),
      },
    ],
  };
}

const debugEvidence = {
  verdict: "issues",
  summary: "Two runtime issues were observed.",
  scenePath: "res://levels/arena.tscn",
  observeMs: 3000,
  lifecycle: {
    startedByTool: true,
    attachedToExisting: false,
    stopRequested: true,
    stopped: true,
    playingAfter: false,
  },
  diagnostics: {
    errorCount: 1,
    warningCount: 1,
    infoCount: 2,
    droppedEvents: 0,
    droppedSamples: 1,
    missedEvents: 2,
    missedSamples: 1,
    truncatedEvents: 3,
    omittedIssueGroups: 2,
    issues: [
      {
        severity: "error",
        source: "script",
        kind: "script_error",
        message: "Invalid access to property 'health'.",
        file: "res://player.gd",
        line: 28,
        function: "_physics_process",
        count: 1,
      },
    ],
  },
  performance: {
    sampleCount: 12,
    fps: { min: 48, average: 57.5, max: 60 },
    frameMs: { p50: 16.4, p95: 22.8, max: 31.2 },
    physicsMs: { p50: 1.2, p95: 2.1, max: 2.8 },
    memoryBytesMax: 32_000_000,
    nodeCountMax: 96,
    orphanNodeDelta: 0,
    drawCallsP95: 134,
    findings: [
      {
        severity: "warning",
        code: "frame_time_spike",
        message: "Frame time exceeded the observation threshold.",
      },
    ],
  },
  runtime: {
    connected: true,
    runId: "run-42",
    rootName: "Arena",
    rootType: "Node3D",
    nodeCount: 93,
    pid: 4_242,
  },
  screenshot: {
    available: true,
    width: 1280,
    height: 720,
    bytes: 84_120,
  },
  pngBase64: "[omitted]",
};

describe("collectGodotDiagnostics", () => {
  it("parses verified import and GDScript checks without inventing tests", () => {
    const result = collectGodotDiagnostics([
      message({
        verdict: "pass",
        import: { ok: true, output: "imported" },
        scripts: { checked: 4, failed: 0, failures: [] },
        csharp: { status: "not_present", scripts: 0, projects: 0, message: "No C# files." },
        tests: { status: "not_configured", message: "No runner." },
      }),
    ]);
    expect(result?.verdict).toBe("pass");
    expect(result?.checks.map((check) => check.label)).toEqual([
      "Headless import",
      "GDScript syntax",
      "C#/.NET",
      "Project tests",
    ]);
    expect(result?.tests.status).toBe("not_configured");
  });

  it("does not present an unchecked C# project as passing", () => {
    const result = collectGodotDiagnostics([
      message({
        verdict: "unverified",
        import: { ok: true },
        scripts: { checked: 1, failed: 0, failures: [] },
        csharp: { status: "unverified", scripts: 1, projects: 1, message: "C#/.NET verification was not performed." },
      }),
    ]);
    expect(result?.verdict).toBe("unverified");
    expect(result?.checks.find((check) => check.id === "csharp")?.verdict).toBe("unverified");
  });

  it("surfaces script failures and asks only for another verification", () => {
    const result = collectGodotDiagnostics([
      message({
        verdict: "fail",
        import: { ok: true },
        scripts: {
          checked: 2,
          failed: 1,
          failures: [{ path: "res://player.gd", output: "Parse Error" }],
        },
      }),
    ]);
    expect(result?.verdict).toBe("fail");
    expect(result?.problems[0]).toMatchObject({ path: "res://player.gd" });
    expect(result?.fixPrompt).toContain("godot_verify");
  });

  it("does not turn malformed success envelopes into a passing verification", () => {
    const malformed = message({ verdict: "pass", import: {}, scripts: {} });
    expect(collectGodotDiagnostics([malformed])?.verdict).toBe("unknown");
  });

  it("surfaces a running verification before it has a result payload", () => {
    const running = message(undefined, { status: "running", startedAt: 24 });
    expect(collectGodotDiagnostics([running])).toMatchObject({
      verdict: "running",
      updatedAt: 24,
    });
  });
});

describe("Godot diagnostic activity selectors", () => {
  it("keeps exact selectors separate while retaining both structured results", () => {
    const verify = "mcp__godot-vibe-os__godot_verify";
    const debug = "mcp__godot-vibe-os__godot_debug_run";
    expect(isGodotVerifyActivity(verify)).toBe(true);
    expect(isGodotVerifyActivity(debug)).toBe(false);
    expect(isGodotDebugRunActivity(debug)).toBe(true);
    expect(isGodotDebugRunActivity(verify)).toBe(false);
    expect(shouldRetainGodotRawResult(verify)).toBe(true);
    expect(shouldRetainGodotRawResult(debug)).toBe(true);
    expect(shouldRetainGodotRawResult("godot_debug_runner")).toBe(false);
  });
});

describe("parseGodotDebugEvidence", () => {
  it("accepts the complete evidence contract and ignores the image placeholder", () => {
    const parsed = parseGodotDebugEvidence(
      JSON.stringify({ ok: true, data: debugEvidence }),
    );
    expect(parsed).toMatchObject({
      verdict: "issues",
      scenePath: "res://levels/arena.tscn",
      diagnostics: {
        errorCount: 1,
        warningCount: 1,
        droppedSamples: 1,
        missedEvents: 2,
        missedSamples: 1,
        truncatedEvents: 3,
        omittedIssueGroups: 2,
      },
      performance: { fps: { average: 57.5 } },
      runtime: { rootName: "Arena", nodeCount: 93, pid: 4_242 },
      screenshot: { available: true, width: 1280, height: 720 },
    });
    expect(parsed).not.toHaveProperty("pngBase64");
    expect(formatGodotEvidenceGaps(parsed!.diagnostics)).toBe(
      "1 dropped sample · 2 missed events · 1 missed sample · 3 truncated events",
    );
  });

  it("accepts explicitly unavailable optional evidence", () => {
    const result = {
      ...debugEvidence,
      verdict: "unverified",
      performance: { sampleCount: 0, findings: [] },
      runtime: null,
      screenshot: { available: false, captureError: "No viewport frame." },
    };
    expect(
      parseGodotDebugEvidence(JSON.stringify({ ok: true, result })),
    ).toMatchObject({
      verdict: "unverified",
      runtime: null,
      screenshot: { available: false },
    });
  });

  it("accepts launch failures before a scene path can be resolved", () => {
    const result = {
      ...debugEvidence,
      verdict: "launch_failed",
      scenePath: "",
      diagnostics: {
        errorCount: 0,
        warningCount: 0,
        infoCount: 0,
        droppedEvents: 0,
        droppedSamples: 0,
        missedEvents: 0,
        missedSamples: 0,
        truncatedEvents: 0,
        omittedIssueGroups: 0,
        issues: [],
      },
      performance: { sampleCount: 0, findings: [] },
      runtime: null,
      screenshot: { available: false },
    };
    expect(
      parseGodotDebugEvidence(JSON.stringify({ ok: true, data: result })),
    ).toMatchObject({ verdict: "launch_failed", scenePath: "" });
  });

  it.each([
    ["missing lifecycle field", {
      ...debugEvidence,
      lifecycle: { ...debugEvidence.lifecycle, stopped: undefined },
    }],
    ["unknown issue severity", {
      ...debugEvidence,
      diagnostics: {
        ...debugEvidence.diagnostics,
        issues: [{ ...debugEvidence.diagnostics.issues[0], severity: "info" }],
      },
    }],
    ["missing issue count", {
      ...debugEvidence,
      diagnostics: {
        ...debugEvidence.diagnostics,
        issues: [{
          severity: "error",
          source: "runtime",
          kind: "script_error",
          message: "Missing count must not be inferred.",
        }],
      },
    }],
    ["negative diagnostic count", {
      ...debugEvidence,
      diagnostics: { ...debugEvidence.diagnostics, errorCount: -1 },
    }],
    ["missing truncated event count", {
      ...debugEvidence,
      diagnostics: { ...debugEvidence.diagnostics, truncatedEvents: undefined },
    }],
    ["missing dropped sample count", {
      ...debugEvidence,
      diagnostics: { ...debugEvidence.diagnostics, droppedSamples: undefined },
    }],
    ["negative missed event count", {
      ...debugEvidence,
      diagnostics: { ...debugEvidence.diagnostics, missedEvents: -1 },
    }],
    ["fractional missed sample count", {
      ...debugEvidence,
      diagnostics: { ...debugEvidence.diagnostics, missedSamples: 0.5 },
    }],
    ["negative omitted group count", {
      ...debugEvidence,
      diagnostics: { ...debugEvidence.diagnostics, omittedIssueGroups: -1 },
    }],
    ["partial frame statistics", {
      ...debugEvidence,
      performance: {
        ...debugEvidence.performance,
        frameMs: { p50: 16, p95: 20 },
      },
    }],
    ["missing runtime contract", { ...debugEvidence, runtime: undefined }],
    ["negative runtime pid", {
      ...debugEvidence,
      runtime: { ...debugEvidence.runtime, pid: -1 },
    }],
  ])("rejects %s", (_label, result) => {
    expect(
      parseGodotDebugEvidence(JSON.stringify({ ok: true, data: result })),
    ).toBeNull();
  });

  it("rejects prose, failed envelopes, and direct non-envelope payloads", () => {
    expect(parseGodotDebugEvidence("looks clean")).toBeNull();
    expect(
      parseGodotDebugEvidence(JSON.stringify({ ok: false, data: debugEvidence })),
    ).toBeNull();
    expect(parseGodotDebugEvidence(JSON.stringify(debugEvidence))).toBeNull();
  });
});

describe("collectGodotDebugRun", () => {
  it("returns the latest completed debug evidence without reading verify output", () => {
    const verify = message(
      {
        verdict: "pass",
        import: { ok: true },
        scripts: { checked: 1, failed: 0, failures: [] },
      },
      { startedAt: 100 },
    );
    const debug = message(debugEvidence, {
      name: "mcp__godot-vibe-os__godot_debug_run",
      startedAt: 20,
    });
    expect(collectGodotDebugRun([verify, debug])).toMatchObject({
      status: "complete",
      evidence: { verdict: "issues", scenePath: "res://levels/arena.tscn" },
    });
  });

  it("shows a running debug observation before evidence arrives", () => {
    const running = message(undefined, {
      name: "godot_debug_run",
      status: "running",
      startedAt: 44,
    });
    expect(collectGodotDebugRun([running])).toEqual({
      status: "running",
      updatedAt: 44,
    });
  });
});
