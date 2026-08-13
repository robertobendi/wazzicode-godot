import { describe, expect, it } from "vitest";
import type { ChatMessage, ToolActivity } from "@/types/chat";
import {
  collectUnityDiagnostics,
  type UnityDiagnosticTool,
} from "./unityDiagnostics";

function envelope(data: unknown, warnings: string[] = []): string {
  return JSON.stringify({
    ok: true,
    data,
    warnings,
    meta: { source: "unity_bridge", durationMs: 3, detailLevel: "normal" },
  });
}

function activity(
  tool: UnityDiagnosticTool,
  resultRaw: string | undefined,
  startedAt: number,
  overrides: Partial<ToolActivity> = {},
): ToolActivity {
  return {
    id: `${tool}-${startedAt}`,
    toolUseId: `${tool}-${startedAt}`,
    name: `mcp__unity-vibe-os__${tool}`,
    friendlyLabel: tool,
    status: "ok",
    ...(resultRaw === undefined
      ? {}
      : { resultRaw, resultText: resultRaw.replace(/\s+/g, " ").slice(0, 200) }),
    startedAt,
    endedAt: startedAt + 1,
    ...overrides,
  };
}

function message(createdAt: number, activities: ToolActivity[]): ChatMessage {
  return {
    id: `message-${createdAt}`,
    role: "assistant",
    text: "",
    streaming: false,
    attachments: [],
    activities,
    createdAt,
  };
}

describe("collectUnityDiagnostics", () => {
  it("returns null when chat history has no supported diagnostic activity", () => {
    const other = activity("unity_verify", undefined, 1, {
      name: "mcp__unity-vibe-os__unity_orient",
    });
    expect(collectUnityDiagnostics([message(1, [other])])).toBeNull();
  });

  it("uses the latest result for a diagnostic tool across messages", () => {
    const oldFailure = activity("unity_verify", envelope({ pass: false }), 10);
    const newSuccess = activity(
      "unity_verify",
      envelope({
        pass: true,
        compiled: true,
        consoleReadable: true,
        consoleErrorCount: 0,
        tests: {
          runId: "latest",
          state: "completed",
          total: 1,
          passed: 1,
          failed: 0,
          skipped: 0,
          results: [{ name: "Works", status: "Passed" }],
        },
      }),
      30,
    );
    const result = collectUnityDiagnostics([
      message(10, [oldFailure]),
      message(30, [newSuccess]),
    ]);
    expect(result?.verdict).toBe("pass");
    expect(result?.sourceTools).toEqual(["unity_verify"]);
    expect(result?.updatedAt).toBe(31);
  });

  it("keeps an older full verify failure after tests are disabled on a later verify", () => {
    const fullFailure = activity(
      "unity_verify",
      envelope({
        pass: false,
        compiled: true,
        tests: {
          state: "completed",
          total: 1,
          passed: 0,
          failed: 1,
          skipped: 0,
          results: [
            {
              name: "Broad failure",
              status: "Failed",
              message: "The full suite still fails",
            },
          ],
        },
      }),
      10,
      { input: {} },
    );
    const compileOnlyPass = activity(
      "unity_verify",
      envelope({
        pass: true,
        compiled: true,
        tests: "skipped (runTests=false)",
      }),
      20,
      { input: { runTests: false } },
    );

    const result = collectUnityDiagnostics([
      message(10, [fullFailure]),
      message(20, [compileOnlyPass]),
    ]);

    expect(result?.verdict).toBe("fail");
    expect(result?.sourceTools).toEqual(["unity_verify"]);
    expect(result?.problems.map((problem) => problem.message)).toContain(
      "Broad failure: The full suite still fails",
    );
    expect(result?.tests).toMatchObject({
      state: "completed",
      failed: 1,
      failures: [{ name: "Broad failure", status: "Failed" }],
    });
  });

  it("keeps older QA domains disabled by a later narrower QA run", () => {
    const fullQaFailure = activity(
      "unity_qa",
      envelope({
        pass: false,
        checks: [
          {
            name: "missing_scripts",
            pass: false,
            summary: "A prefab has a missing script.",
          },
        ],
        reasons: ["A prefab has a missing script."],
      }),
      10,
      { input: {} },
    );
    const narrowQaPass = activity(
      "unity_qa",
      envelope({
        pass: true,
        checks: [
          { name: "verify", pass: true, summary: "Compilation passed." },
          { name: "tests", pass: true, skipped: true, summary: "Disabled." },
          {
            name: "missing_scripts",
            pass: true,
            skipped: true,
            summary: "Disabled.",
          },
          {
            name: "missing_references",
            pass: true,
            skipped: true,
            summary: "Disabled.",
          },
          {
            name: "smoke_test",
            pass: true,
            skipped: true,
            summary: "Disabled.",
          },
        ],
        reasons: [],
      }),
      20,
      {
        input: { runTests: false, checkAssets: false, runSmokeTest: false },
      },
    );

    const result = collectUnityDiagnostics([
      message(10, [fullQaFailure]),
      message(20, [narrowQaPass]),
    ]);

    expect(result?.verdict).toBe("fail");
    expect(result?.sourceTools).toEqual(["unity_qa"]);
    expect(result?.problems.map((problem) => problem.message)).toContain(
      "A prefab has a missing script.",
    );
  });

  it("keeps a broad standalone test failure after a later filtered pass", () => {
    const broadFailure = activity(
      "unity_run_tests",
      envelope({
        state: "completed",
        total: 1,
        passed: 0,
        failed: 1,
        skipped: 0,
        results: [{ name: "Unrelated failure", status: "Failed" }],
      }),
      10,
      { input: { mode: "EditMode" } },
    );
    const focusedPass = activity(
      "unity_run_tests",
      envelope({
        state: "completed",
        total: 1,
        passed: 1,
        failed: 0,
        skipped: 0,
        results: [{ name: "FocusedTests.Works", status: "Passed" }],
      }),
      20,
      { input: { mode: "EditMode", filter: "FocusedTests" } },
    );

    const result = collectUnityDiagnostics([
      message(10, [broadFailure]),
      message(20, [focusedPass]),
    ]);

    expect(result?.verdict).toBe("fail");
    expect(result?.sourceTools).toEqual(["unity_run_tests"]);
    expect(result?.problems[0].message).toBe("Unrelated failure was failed.");
  });

  it("lets a later broad QA replace an older narrowed QA failure", () => {
    const focusedFailure = activity(
      "unity_qa",
      envelope({
        pass: false,
        checks: [{ name: "verify", pass: false, summary: "Focused test failed." }],
        reasons: ["Focused test failed."],
      }),
      10,
      {
        input: {
          testFilter: "FocusedTests",
          checkAssets: false,
          runSmokeTest: false,
        },
      },
    );
    const broadPass = activity(
      "unity_qa",
      envelope({
        pass: true,
        checks: [{ name: "verify", pass: true, summary: "All tests passed." }],
        reasons: [],
      }),
      20,
      { input: {} },
    );

    const result = collectUnityDiagnostics([
      message(10, [focusedFailure]),
      message(20, [broadPass]),
    ]);

    expect(result?.verdict).toBe("pass");
    expect(result?.sourceTools).toEqual(["unity_qa"]);
    expect(result?.problems).toEqual([]);
  });

  it("does not let a later narrow verify erase older QA or broader tests", () => {
    const olderQa = activity(
      "unity_qa",
      envelope({
        pass: false,
        checks: [
          {
            name: "missing_scripts",
            pass: false,
            summary: "A prefab has a missing script.",
          },
        ],
        reasons: ["Found a missing script."],
      }),
      10,
    );
    const olderTests = activity(
      "unity_run_tests",
      envelope({
        runId: "old",
        state: "completed",
        total: 1,
        passed: 0,
        failed: 1,
        results: [{ name: "Old failure", status: "Failed" }],
      }),
      20,
    );
    const passingGate = activity(
      "unity_verify",
      envelope({
        pass: true,
        compiled: true,
      }),
      30,
      { input: { testFilter: "FocusedTests" } },
    );
    const result = collectUnityDiagnostics([
      message(10, [olderQa]),
      message(20, [olderTests]),
      message(30, [passingGate]),
    ]);

    expect(result?.verdict).toBe("fail");
    expect(result?.sourceTools).toEqual([
      "unity_qa",
      "unity_run_tests",
      "unity_verify",
    ]);
    expect(result?.problems.map((problem) => problem.message)).toEqual(
      expect.arrayContaining([
        "Found a missing script.",
        "Old failure was failed.",
      ]),
    );
    expect(result?.tests).toMatchObject({ state: "completed", failed: 1 });
  });

  it("lets a later full verify replace the older checks it reran", () => {
    const olderQa = activity(
      "unity_qa",
      envelope({
        pass: false,
        checks: [{ name: "missing_scripts", pass: false }],
        reasons: ["A prefab still has a missing script."],
      }),
      10,
    );
    const olderTests = activity(
      "unity_run_tests",
      envelope({
        state: "completed",
        total: 1,
        passed: 0,
        failed: 1,
        skipped: 0,
        results: [{ name: "Old failure", status: "Failed" }],
      }),
      20,
      { input: { mode: "EditMode" } },
    );
    const passingGate = activity(
      "unity_verify",
      envelope({
        pass: true,
        compiled: true,
        consoleReadable: true,
        consoleErrorCount: 0,
        tests: {
          state: "completed",
          total: 1,
          passed: 1,
          failed: 0,
          skipped: 0,
          results: [{ name: "Old failure", status: "Passed" }],
        },
      }),
      30,
      { input: {} },
    );

    const result = collectUnityDiagnostics([
      message(10, [olderQa]),
      message(20, [olderTests]),
      message(30, [passingGate]),
    ]);

    expect(result?.verdict).toBe("fail");
    expect(result?.sourceTools).toEqual(["unity_qa", "unity_verify"]);
    expect(result?.problems.map((problem) => problem.message)).toEqual([
      "A prefab still has a missing script.",
    ]);
    expect(result?.tests).toMatchObject({ passed: 1, failed: 0 });
  });

  it("keeps an older PlayMode failure after a default EditMode verify", () => {
    const playModeFailure = activity(
      "unity_run_tests",
      envelope({
        state: "completed",
        total: 1,
        passed: 0,
        failed: 1,
        skipped: 0,
        results: [{ name: "Runtime flow", status: "Failed" }],
      }),
      10,
      { input: { mode: "PlayMode" } },
    );
    const editModePass = activity(
      "unity_verify",
      envelope({ pass: true, compiled: true }),
      20,
      { input: {} },
    );

    const result = collectUnityDiagnostics([
      message(10, [playModeFailure]),
      message(20, [editModePass]),
    ]);
    expect(result?.verdict).toBe("fail");
    expect(result?.sourceTools).toEqual(["unity_run_tests", "unity_verify"]);
  });

  it("keeps standalone diagnostics collected after the newest full gate", () => {
    const passingGate = activity(
      "unity_verify",
      envelope({ pass: true, compiled: true }),
      40,
    );
    const newerFailure = activity(
      "unity_get_console_logs",
      envelope({
        logs: [{ type: "Exception", message: "New regression", timestamp: 50 }],
        truncated: false,
        bufferSize: 1,
      }),
      50,
    );
    const result = collectUnityDiagnostics([
      message(40, [passingGate]),
      message(50, [newerFailure]),
    ]);

    expect(result?.verdict).toBe("fail");
    expect(result?.sourceTools).toEqual([
      "unity_verify",
      "unity_get_console_logs",
    ]);
    expect(result?.problems[0].message).toBe("New regression");
  });

  it("handles malformed, truncated, and legacy result data without false success", () => {
    const malformed = collectUnityDiagnostics([
      message(1, [activity("unity_verify", "{not-json", 1)]),
    ]);
    expect(malformed?.verdict).toBe("unknown");

    const truncated = collectUnityDiagnostics([
      message(2, [
        activity("unity_verify", '{"ok":true,"data":{"pass":true', 2, {
          resultRawTruncated: true,
          resultText: "pass: true",
        }),
      ]),
    ]);
    expect(truncated?.verdict).toBe("unknown");
    expect(truncated?.checks[0].detail).toContain("truncated");

    const legacy = collectUnityDiagnostics([
      message(3, [
        activity("unity_verify", undefined, 3, {
          resultText: "pass: true, errors: 0",
        }),
      ]),
    ]);
    expect(legacy?.verdict).toBe("pass");
    expect(legacy?.checks[0].detail).toBeUndefined();
  });

  it("does not let an explicit pass override error problems or failing checks", () => {
    const contradictoryResults: ToolActivity[] = [
      activity(
        "unity_verify",
        envelope({
          pass: true,
          compiled: true,
          problems: [{ type: "Error", message: "Compiler error survived." }],
        }),
        10,
      ),
      activity(
        "unity_qa",
        envelope({
          pass: true,
          checks: [
            {
              name: "missing_scripts",
              pass: false,
              summary: "A missing script remains.",
            },
          ],
          reasons: [],
        }),
        20,
      ),
      activity(
        "unity_smoke_test",
        envelope({
          pass: true,
          checks: [{ name: "play_mode", pass: true }],
          reasons: ["Runtime exception survived."],
        }),
        30,
      ),
    ];

    for (const contradictory of contradictoryResults) {
      const result = collectUnityDiagnostics([
        message(contradictory.startedAt, [contradictory]),
      ]);
      expect(result?.verdict).toBe("fail");
    }
  });

  it("parses verify checks, console problems, failed tests, and a fix prompt", () => {
    const result = collectUnityDiagnostics([
      message(100, [
        activity(
          "unity_verify",
          envelope(
            {
              pass: false,
              refreshVerified: true,
              compiled: true,
              consoleReadable: true,
              errorCount: 0,
              consoleErrorCount: 1,
              problems: [
                {
                  type: "Exception",
                  message: "NullReferenceException in Player.Update",
                  stackTrace: "at Player.Update() in Assets/Player.cs:42",
                  timestamp: 100,
                },
              ],
              tests: {
                runId: "verify-run",
                state: "completed",
                mode: "EditMode",
                total: 2,
                passed: 1,
                failed: 1,
                skipped: 0,
                results: [
                  { name: "Jumps", status: "Passed" },
                  {
                    name: "Lands",
                    fullName: "PlayerTests.Lands",
                    status: "Failed",
                    message: "Expected grounded state",
                    stackTrace: "at PlayerTests.Lands()",
                  },
                ],
              },
            },
            ["Tests did not pass."],
          ),
          100,
        ),
      ]),
    ]);

    expect(result?.verdict).toBe("fail");
    expect(result?.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ label: "Compilation", verdict: "pass" }),
        expect.objectContaining({ label: "Console errors", verdict: "fail" }),
        expect.objectContaining({ label: "Unity tests", verdict: "fail" }),
      ]),
    );
    expect(result?.problems).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "console",
          message: "NullReferenceException in Player.Update",
        }),
        expect.objectContaining({
          kind: "test",
          message: "PlayerTests.Lands: Expected grounded state",
        }),
      ]),
    );
    expect(result?.tests).toMatchObject({
      state: "completed",
      verdict: "fail",
      updatedAt: 101,
      total: 2,
      passed: 1,
      failed: 1,
      failures: [{ name: "PlayerTests.Lands", status: "Failed" }],
    });
    expect(result?.fixPrompt).toContain("NullReferenceException");
    expect(result?.fixPrompt).toContain("`unity_verify`");
  });

  it("parses QA checks and actionable asset/build problems", () => {
    const result = collectUnityDiagnostics([
      message(200, [
        activity(
          "unity_qa",
          envelope({
            pass: false,
            checks: [
              { name: "verify", pass: true, summary: "Compilation passed." },
              {
                name: "missing_scripts",
                pass: false,
                summary: "One prefab has a missing script.",
              },
            ],
            reasons: ["Found one or more missing scripts."],
            verify: {
              pass: true,
              compiled: true,
              problems: [],
              tests: {
                runId: "qa-run",
                state: "completed",
                total: 3,
                passed: 3,
                failed: 0,
                skipped: 0,
                resultCount: 3,
                results: [
                  { name: "Loads scene", status: "Passed" },
                  { name: "Spawns player", status: "Passed" },
                  { name: "Accepts input", status: "Passed" },
                ],
                resultsTruncated: false,
              },
            },
            buildSettings: { issues: ["No enabled startup scene."] },
            missingScripts: {
              hits: [
                {
                  assetPath: "Assets/Broken.prefab",
                  objectPath: "/Broken",
                  missingCount: 1,
                },
              ],
            },
          }),
          200,
        ),
      ]),
    ]);

    expect(result?.verdict).toBe("fail");
    expect(result?.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ label: "Missing scripts", verdict: "fail" }),
      ]),
    );
    expect(result?.problems.map((problem) => problem.message)).toEqual(
      expect.arrayContaining([
        "Found one or more missing scripts.",
        "No enabled startup scene.",
        "Assets/Broken.prefab: /Broken has 1 missing script(s).",
      ]),
    );
    expect(result?.tests).toMatchObject({ state: "completed", passed: 3 });
    expect(result?.fixPrompt).toContain("Assets/Broken.prefab");
  });

  it("derives a console verdict from errors and treats clean truncation as unknown", () => {
    const failed = collectUnityDiagnostics([
      message(300, [
        activity(
          "unity_get_console_logs",
          envelope({
            logs: [
              { type: "Warning", message: "Deprecated API", timestamp: 1 },
              { type: "Error", message: "Missing component", timestamp: 2 },
            ],
            truncated: false,
            bufferSize: 2,
          }),
          300,
        ),
      ]),
    ]);
    expect(failed?.verdict).toBe("fail");
    expect(failed?.problems).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ severity: "warning", message: "Deprecated API" }),
        expect.objectContaining({ severity: "error", message: "Missing component" }),
      ]),
    );

    const incomplete = collectUnityDiagnostics([
      message(301, [
        activity(
          "unity_get_console_logs",
          envelope({ logs: [], truncated: true, bufferSize: 2_000 }),
          301,
        ),
      ]),
    ]);
    expect(incomplete?.verdict).toBe("unknown");
    expect(incomplete?.checks[0].detail).toContain("truncated");
  });

  it("parses standalone test failures", () => {
    const result = collectUnityDiagnostics([
      message(400, [
        activity(
          "unity_run_tests",
          envelope({
            runId: "tests-1",
            state: "completed",
            mode: "PlayMode",
            total: 2,
            passed: 1,
            failed: 1,
            skipped: 0,
            durationSec: 1.25,
            results: [
              {
                name: "Enemy attacks",
                status: "Failed",
                message: "Attack never started",
              },
            ],
          }),
          400,
        ),
      ]),
    ]);
    expect(result?.verdict).toBe("fail");
    expect(result?.tests).toMatchObject({
      state: "completed",
      mode: "PlayMode",
      failed: 1,
    });
    expect(result?.problems[0]).toMatchObject({
      kind: "test",
      message: "Enemy attacks: Attack never started",
    });
  });

  it("only passes completed tests with consistent counts and results", () => {
    const credible = collectUnityDiagnostics([
      message(410, [
        activity(
          "unity_run_tests",
          envelope({
            runId: "credible",
            state: "completed",
            total: 2,
            passed: 1,
            failed: 0,
            skipped: 1,
            results: [
              { name: "Runs", status: "Passed" },
              { name: "Needs device", status: "Skipped" },
            ],
          }),
          410,
        ),
      ]),
    ]);
    expect(credible?.verdict).toBe("pass");

    const missingEvidence = collectUnityDiagnostics([
      message(420, [
        activity(
          "unity_run_tests",
          envelope({ runId: "incomplete", state: "completed" }),
          420,
        ),
      ]),
    ]);
    expect(missingEvidence?.verdict).toBe("unknown");

    const inconsistent = collectUnityDiagnostics([
      message(430, [
        activity(
          "unity_run_tests",
          envelope({
            runId: "inconsistent",
            state: "completed",
            total: 2,
            passed: 2,
            failed: 0,
            skipped: 0,
            results: [{ name: "Only one result", status: "Passed" }],
          }),
          430,
        ),
      ]),
    ]);
    expect(inconsistent?.verdict).toBe("unknown");
  });

  it("fails a completed run containing an inconclusive result", () => {
    const result = collectUnityDiagnostics([
      message(440, [
        activity(
          "unity_run_tests",
          envelope({
            runId: "inconclusive",
            state: "completed",
            total: 1,
            passed: 0,
            failed: 0,
            skipped: 0,
            results: [
              {
                name: "PlayerTests.Spawns",
                status: "Inconclusive",
                message: "Scene setup did not complete",
              },
            ],
          }),
          440,
        ),
      ]),
    ]);

    expect(result?.verdict).toBe("fail");
    expect(result?.tests?.failures).toEqual([
      expect.objectContaining({
        name: "PlayerTests.Spawns",
        status: "Inconclusive",
      }),
    ]);
    expect(result?.problems[0].message).toBe(
      "PlayerTests.Spawns: Scene setup did not complete",
    );
  });

  it("parses compile and smoke-test diagnostics", () => {
    const compile = activity(
      "unity_wait_for_compile",
      envelope({
        isCompiling: false,
        hasErrors: true,
        errorCount: 1,
        warningCount: 0,
        errors: [
          {
            file: "Assets/Player.cs",
            line: 12,
            column: 7,
            message: "CS0103: name does not exist",
            type: "error",
          },
        ],
      }),
      500,
    );
    const smoke = activity(
      "unity_smoke_test",
      envelope({
        pass: false,
        checks: [
          { name: "play_mode", pass: true, summary: "Entered play mode." },
          {
            name: "console_errors",
            pass: false,
            summary: "One runtime exception was emitted.",
          },
        ],
        reasons: ["One runtime exception was emitted."],
        console: {
          logs: [{ type: "Exception", message: "Runtime boom", timestamp: 500 }],
          truncated: false,
          bufferSize: 1,
        },
      }),
      510,
    );
    const result = collectUnityDiagnostics([message(500, [compile]), message(510, [smoke])]);
    expect(result?.verdict).toBe("fail");
    expect(result?.sourceTools).toEqual([
      "unity_wait_for_compile",
      "unity_smoke_test",
    ]);
    expect(result?.problems).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ file: "Assets/Player.cs", line: 12 }),
        expect.objectContaining({ message: "Runtime boom" }),
      ]),
    );
    expect(result?.fixPrompt).toContain("Assets/Player.cs:12:7");
  });

  it("surfaces a failed ToolEnvelope instead of trying to read data", () => {
    const raw = JSON.stringify({
      ok: false,
      error: { code: "UNITY_NOT_CONNECTED", message: "Open the Unity Editor." },
      meta: {},
    });
    const result = collectUnityDiagnostics([
      message(600, [activity("unity_verify", raw, 600)]),
    ]);
    expect(result?.verdict).toBe("fail");
    expect(result?.problems[0].message).toBe(
      "UNITY_NOT_CONNECTED: Open the Unity Editor.",
    );
  });
});
