import { describe, expect, it } from "vitest";
import {
  buildSnapshotFixPrompt,
  unityDiagnosticCounts,
  unityDiagnosticIssues,
  unityDiagnosticSummary,
} from "./unityDiagnosticSnapshot";
import type { UnityDiagnosticsSnapshot } from "@/types/unityDiagnostics";

const snapshot: UnityDiagnosticsSnapshot = {
  capturedAt: 1,
  playMode: { isPlaying: false, isPaused: false },
  compile: {
    isCompiling: false,
    hasErrors: true,
    errorCount: 1,
    warningCount: 1,
    errors: [
      { file: "Assets/Player.cs", line: 8, column: 4, message: "CS1002", type: "error" },
      { file: "Assets/Camera.cs", line: 3, message: "unused", type: "warning" },
    ],
  },
  console: {
    bufferSize: 3,
    truncated: false,
    logs: [
      { type: "Log", message: "ready", timestamp: 1 },
      { type: "Exception", message: "NullReferenceException", stackTrace: "at Player.Start()", timestamp: 2 },
    ],
  },
};

describe("Unity diagnostic snapshot helpers", () => {
  it("combines compiler and console issues", () => {
    expect(unityDiagnosticCounts(snapshot)).toEqual({
      total: 3,
      errors: 2,
      warnings: 1,
    });
  });

  it("filters by severity and searchable detail", () => {
    expect(unityDiagnosticIssues(snapshot, "warnings")).toHaveLength(1);
    expect(unityDiagnosticIssues(snapshot, "all", "Player.Start")).toHaveLength(1);
    expect(unityDiagnosticIssues(snapshot, "errors", "Camera")).toHaveLength(0);
  });

  it("keeps source-specific summary counts separate", () => {
    expect(unityDiagnosticSummary(snapshot)).toEqual({
      compileErrors: 1,
      consoleErrors: 1,
      consoleWarnings: 0,
    });
  });

  it("builds a focused prompt with truthful counts", () => {
    const issue = unityDiagnosticIssues(snapshot)[0];
    const prompt = buildSnapshotFixPrompt(snapshot, issue);
    expect(prompt).toContain("Assets/Player.cs:8:4");
    expect(prompt).toContain("1 compiler error");
    expect(prompt).toContain("1 console error");
  });
});
