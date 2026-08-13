import { z } from "zod";
import {
  BuildSettingsScene,
  BuildSettingsResult,
  ConsoleLog,
  ConsoleLogsResult,
  MissingReferenceHit,
  MissingReferencesResult,
  MissingScriptHit,
  MissingScriptsResult,
  TestCaseResult,
  TestRunStatus,
  ToolEnvelope,
} from "@uvibe/core";
import { ToolDef } from "../registry.js";
import { ok } from "./_helpers.js";
import { unityVerify } from "./unityVerify.js";
import { unityGetBuildSettings } from "./unityBuildSettings.js";
import {
  unityFindMissingReferences,
  unityFindMissingScripts,
} from "./unityAssetGraph.js";
import { SmokeTestResult, unitySmokeTest } from "./unitySmokeTest.js";

const InputShape = {
  runTests: z.boolean().optional().describe("Run Unity tests during verification (default true)."),
  testMode: z.enum(["EditMode", "PlayMode"]).optional(),
  testFilter: z.string().optional(),
  compileTimeoutMs: z.number().int().min(500).max(300_000).optional(),
  checkAssets: z
    .boolean()
    .optional()
    .describe("Scan prefabs and open scenes for missing scripts/references (default true)."),
  runSmokeTest: z.boolean().optional().describe("Run the guarded play-mode smoke test (default true)."),
  smokeSettleMs: z.number().int().min(0).max(30_000).optional(),
  captureGameView: z.boolean().optional().describe("Capture the Game view during the smoke test (default true)."),
  saveScreenshot: z.boolean().optional().describe("Save the smoke-test capture (default true)."),
  minFps: z.number().positive().max(1000).optional(),
  maxMainThreadMs: z.number().positive().max(10_000).optional(),
  maxGcAllocBytesPerFrame: z.number().nonnegative().optional(),
};

export interface QaCheck {
  name: string;
  pass: boolean;
  skipped?: boolean;
  summary: string;
}

export interface QaTestRunSummary extends Omit<TestRunStatus, "results"> {
  resultCount: number;
  results: TestCaseResult[];
  resultsTruncated: boolean;
}

export type QaTestsSummary =
  | string
  | QaTestRunSummary
  | { error: string; message?: string; skipped: boolean }
  | { status: "unavailable" };

export interface QaVerifySummary {
  pass: boolean;
  compiled: boolean;
  errorCount?: number;
  warningCount?: number;
  consoleErrorCount?: number;
  problemCount: number;
  problems: ConsoleLog[];
  problemsTruncated: boolean;
  tests?: QaTestsSummary;
}

export interface QaBuildSettingsSummary extends Omit<BuildSettingsResult, "scenes" | "issues"> {
  sceneCount: number;
  scenes: BuildSettingsScene[];
  scenesTruncated: boolean;
  issueCount: number;
  issues: string[];
  issuesTruncated: boolean;
}

export interface QaScanSummary<THit> {
  scanned: number;
  hitCount: number;
  hits: THit[];
  truncated: boolean;
  responseTruncated: boolean;
}

export interface QaConsoleSummary {
  logCount: number;
  logs: ConsoleLog[];
  logsTruncated: boolean;
  bufferSize: number;
  sourceTruncated: boolean;
  fallback?: string;
}

type SmokePerformance = NonNullable<SmokeTestResult["performance"]>;
export type QaPerformanceSummary = Omit<SmokePerformance, "counters"> & {
  counterCount: number;
  counters: SmokePerformance["counters"];
  countersTruncated: boolean;
};

export type QaSmokeTestSummary = Omit<SmokeTestResult, "console" | "performance"> & {
  console?: QaConsoleSummary;
  performance?: QaPerformanceSummary;
};

export interface QaResult {
  pass: boolean;
  durationMs: number;
  reasons: string[];
  checks: QaCheck[];
  verify?: QaVerifySummary;
  buildSettings?: QaBuildSettingsSummary;
  missingScripts?: QaScanSummary<MissingScriptHit>;
  missingReferences?: QaScanSummary<MissingReferenceHit>;
  smokeTest?: QaSmokeTestSummary;
}

const QA_PROBLEM_LIMIT = 20;
const QA_TEST_RESULT_LIMIT = 20;
const QA_SCAN_BRIDGE_LIMIT = 200;
const QA_SCAN_HIT_LIMIT = 25;
const QA_BUILD_SCENE_LIMIT = 50;
const QA_BUILD_ISSUE_LIMIT = 20;
const QA_SMOKE_LOG_LIMIT = 20;
const QA_PERF_COUNTER_LIMIT = 20;
const QA_REASON_LIMIT = 50;
const QA_WARNING_LIMIT = 50;

type Captured<T> =
  | { env: ToolEnvelope<T> }
  | { thrown: string };

export const unityQa: ToolDef<typeof InputShape, QaResult> = {
  name: "unity_qa",
  description:
    "Runs the full Unity quality gate in one call: truthful compile/console/test verification, build-settings readiness, missing-script and dangling-reference scans, then a guarded play-mode smoke test when prerequisites pass. Returns one structured verdict with every failed or skipped check; large logs, test runs, and scans are bounded with explicit totals/truncation markers, and TEST_FRAMEWORK_MISSING is reported as skipped.",
  requires: ["unity_bridge", "filesystem"],
  inputShape: InputShape,
  async run(args, ctx) {
    const startedAt = Date.now();
    const checks: QaCheck[] = [];
    const reasons: string[] = [];
    const warnings: string[] = [];
    let verifyResult: QaVerifySummary | undefined;
    let verifyPassed = false;
    let verifyCompiled = false;
    let buildSettings: QaBuildSettingsSummary | undefined;
    let missingScripts: QaScanSummary<MissingScriptHit> | undefined;
    let missingReferences: QaScanSummary<MissingReferenceHit> | undefined;
    let smokeTest: QaSmokeTestSummary | undefined;

    const addCheck = (check: QaCheck): void => {
      checks.push(check);
      if (!check.pass && !check.skipped) reasons.push(check.summary);
    };

    try {
      const verify = await capture(() =>
        unityVerify.run(
          {
            runTests: args.runTests,
            testMode: args.testMode,
            testFilter: args.testFilter,
            compileTimeoutMs: args.compileTimeoutMs,
          },
          ctx
        )
      );
      if ("thrown" in verify) {
        addCheck({
          name: "verify",
          pass: false,
          summary: `Unity verification could not run: ${verify.thrown}`,
        });
      } else if (!verify.env.ok) {
        addCheck({
          name: "verify",
          pass: false,
          summary: nestedFailure("Unity verification could not run", verify.env),
        });
      } else {
        appendWarnings("verify", verify.env, warnings);
        verifyResult = summarizeVerify(verify.env.data);
        if (!verifyResult) {
          addCheck({
            name: "verify",
            pass: false,
            summary: "Unity verification returned an invalid verdict.",
          });
        } else {
          verifyPassed = verifyResult.pass;
          verifyCompiled = verifyResult.compiled;
          const frameworkMissing = isTestFrameworkMissing(verifyResult.tests);
          const testsDisabled = args.runTests === false;
          addCheck({
            name: "verify",
            pass: verifyPassed,
            summary: verifyPassed
              ? frameworkMissing
                ? "Compilation and console checks passed; Unity tests were skipped."
                : testsDisabled
                  ? "Compilation and console checks passed; Unity tests were disabled."
                  : "Compilation, console checks, and requested tests passed."
              : verifyCompiled
                ? "Unity verification failed because tests or console errors did not pass."
                : "Unity verification failed because compilation did not settle cleanly.",
          });
          if (frameworkMissing) {
            addCheck({
              name: "tests",
              pass: true,
              skipped: true,
              summary: "Unity Test Framework is not installed; tests were skipped.",
            });
          } else if (testsDisabled) {
            addCheck({
              name: "tests",
              pass: true,
              skipped: true,
              summary: "Unity tests were disabled for this QA run.",
            });
          }
        }
      }

      const build = await capture(() =>
        unityGetBuildSettings.run({ detailLevel: "full" }, ctx)
      );
      const scripts = (args.checkAssets ?? true)
        ? await capture(() =>
            unityFindMissingScripts.run({ limit: QA_SCAN_BRIDGE_LIMIT, detailLevel: "full" }, ctx)
          )
        : undefined;
      const references = (args.checkAssets ?? true)
        ? await capture(() =>
            unityFindMissingReferences.run(
              { limit: QA_SCAN_BRIDGE_LIMIT, detailLevel: "full" },
              ctx
            )
          )
        : undefined;

      if ("thrown" in build) {
        addCheck({
          name: "build_settings",
          pass: false,
          summary: `Build readiness could not be checked: ${build.thrown}`,
        });
      } else if (!build.env.ok) {
        addCheck({
          name: "build_settings",
          pass: false,
          summary: nestedFailure("Build readiness could not be checked", build.env),
        });
      } else {
        appendWarnings("build settings", build.env, warnings);
        const rawBuildSettings = build.env.data;
        buildSettings = summarizeBuildSettings(rawBuildSettings);
        addCheck({
          name: "build_settings",
          pass: rawBuildSettings.valid,
          summary: rawBuildSettings.valid
            ? `${rawBuildSettings.enabledSceneCount} enabled build scene(s); ${rawBuildSettings.activeBuildTarget} is supported.`
            : rawBuildSettings.issues.length > 0
              ? `Build settings are not ready: ${summarizeStrings(rawBuildSettings.issues, 5)}`
              : "Build settings reported an invalid configuration without issue details.",
        });
        if (!rawBuildSettings.valid) {
          reasons.push(
            ...rawBuildSettings.issues
              .slice(0, QA_BUILD_ISSUE_LIMIT)
              .map((issue: string) => `Build settings: ${trimText(issue)}`)
          );
        }
      }

      if (scripts === undefined) {
        addCheck({
          name: "missing_scripts",
          pass: true,
          skipped: true,
          summary: "Missing-script scan was disabled.",
        });
      } else if ("thrown" in scripts) {
        addCheck({
          name: "missing_scripts",
          pass: false,
          summary: `Missing-script scan could not run: ${scripts.thrown}`,
        });
      } else if (!scripts.env.ok) {
        addCheck({
          name: "missing_scripts",
          pass: false,
          summary: nestedFailure("Missing-script scan could not run", scripts.env),
        });
      } else {
        appendWarnings("missing scripts", scripts.env, warnings);
        const rawMissingScripts = scripts.env.data;
        missingScripts = summarizeScan(rawMissingScripts);
        const complete = rawMissingScripts.truncated !== true;
        const clean = rawMissingScripts.hits.length === 0;
        addCheck({
          name: "missing_scripts",
          pass: clean && complete,
          summary: !clean
            ? `${rawMissingScripts.hits.length} object(s) have missing scripts${complete ? "." : " before the scan limit was reached."}`
            : !complete
              ? "Missing-script scan was truncated, so a clean result could not be verified."
              : `No missing scripts found across ${rawMissingScripts.scanned} scanned asset(s).`,
        });
      }

      if (references === undefined) {
        addCheck({
          name: "missing_references",
          pass: true,
          skipped: true,
          summary: "Missing-reference scan was disabled.",
        });
      } else if ("thrown" in references) {
        addCheck({
          name: "missing_references",
          pass: false,
          summary: `Missing-reference scan could not run: ${references.thrown}`,
        });
      } else if (!references.env.ok) {
        addCheck({
          name: "missing_references",
          pass: false,
          summary: nestedFailure("Missing-reference scan could not run", references.env),
        });
      } else {
        appendWarnings("missing references", references.env, warnings);
        const rawMissingReferences = references.env.data;
        missingReferences = summarizeScan(rawMissingReferences);
        const complete = rawMissingReferences.truncated !== true;
        const clean = rawMissingReferences.hits.length === 0;
        addCheck({
          name: "missing_references",
          pass: clean && complete,
          summary: !clean
            ? `${rawMissingReferences.hits.length} dangling serialized reference(s) were found${complete ? "." : " before the scan limit was reached."}`
            : !complete
              ? "Missing-reference scan was truncated, so a clean result could not be verified."
              : `No dangling references found across ${rawMissingReferences.scanned} scanned asset(s).`,
        });
      }

      if (!(args.runSmokeTest ?? true)) {
        addCheck({
          name: "smoke_test",
          pass: true,
          skipped: true,
          summary: "Play-mode smoke test was disabled.",
        });
      } else if (!verifyPassed || !verifyCompiled) {
        addCheck({
          name: "smoke_test",
          pass: true,
          skipped: true,
          summary: "Play-mode smoke test was skipped because Unity verification did not pass.",
        });
      } else {
        const smoke = await capture(() =>
          unitySmokeTest.run(
            {
              settleMs: args.smokeSettleMs,
              captureGameView: args.captureGameView,
              saveScreenshot: args.saveScreenshot,
              minFps: args.minFps,
              maxMainThreadMs: args.maxMainThreadMs,
              maxGcAllocBytesPerFrame: args.maxGcAllocBytesPerFrame,
            },
            ctx
          )
        );
        if ("thrown" in smoke) {
          addCheck({
            name: "smoke_test",
            pass: false,
            summary: `Play-mode smoke test could not run: ${smoke.thrown}`,
          });
        } else if (!smoke.env.ok) {
          addCheck({
            name: "smoke_test",
            pass: false,
            summary: nestedFailure("Play-mode smoke test could not run", smoke.env),
          });
        } else {
          appendWarnings("smoke test", smoke.env, warnings);
          const rawSmokeTest = smoke.env.data;
          smokeTest = summarizeSmokeTest(rawSmokeTest);
          addCheck({
            name: "smoke_test",
            pass: rawSmokeTest.pass,
            summary: rawSmokeTest.pass
              ? "Play-mode smoke test passed and restored the initial Editor state."
              : `Play-mode smoke test failed: ${summarizeStrings(rawSmokeTest.reasons, 8) || "see smoke-test checks"}`,
          });
          if (!rawSmokeTest.pass) {
            reasons.push(
              ...rawSmokeTest.reasons
                .slice(0, QA_REASON_LIMIT)
                .map((reason) => `Smoke test: ${trimText(reason)}`)
            );
          }
        }
      }
    } catch (error: unknown) {
      addCheck({
        name: "qa_execution",
        pass: false,
        summary: `QA orchestration failed: ${errorMessage(error)}`,
      });
    }

    const durationMs = Date.now() - startedAt;
    const data: QaResult = {
      pass: checks.every((check) => check.pass),
      durationMs,
      reasons: boundStrings(unique(reasons), QA_REASON_LIMIT),
      checks: checks.map((check) => ({ ...check, summary: trimText(check.summary) })),
      ...(verifyResult !== undefined ? { verify: verifyResult } : {}),
      ...(buildSettings ? { buildSettings } : {}),
      ...(missingScripts ? { missingScripts } : {}),
      ...(missingReferences ? { missingReferences } : {}),
      ...(smokeTest ? { smokeTest } : {}),
    };
    return ok(
      data,
      { source: ctx.bridge.source, durationMs },
      boundStrings(unique(warnings), QA_WARNING_LIMIT)
    );
  },
};

async function capture<T>(call: () => Promise<ToolEnvelope<T>>): Promise<Captured<T>> {
  try {
    return { env: await call() };
  } catch (error: unknown) {
    return { thrown: errorMessage(error) };
  }
}

function summarizeVerify(value: unknown): QaVerifySummary | undefined {
  if (!isRecord(value) || typeof value.pass !== "boolean" || typeof value.compiled !== "boolean") {
    return undefined;
  }
  const rawProblems = Array.isArray(value.problems)
    ? value.problems.filter(isConsoleLog)
    : [];
  const prioritizedProblems = [
    ...rawProblems.filter(isErrorLog),
    ...rawProblems.filter((log) => !isErrorLog(log)),
  ];
  return {
    pass: value.pass,
    compiled: value.compiled,
    ...(typeof value.errorCount === "number" ? { errorCount: value.errorCount } : {}),
    ...(typeof value.warningCount === "number" ? { warningCount: value.warningCount } : {}),
    ...(typeof value.consoleErrorCount === "number"
      ? { consoleErrorCount: value.consoleErrorCount }
      : {}),
    problemCount: rawProblems.length,
    problems: prioritizedProblems.slice(0, QA_PROBLEM_LIMIT).map(trimConsoleLog),
    problemsTruncated: rawProblems.length > QA_PROBLEM_LIMIT,
    ...(value.tests !== undefined ? { tests: summarizeTests(value.tests) } : {}),
  };
}

function summarizeTests(value: unknown): QaTestsSummary {
  if (typeof value === "string") return trimText(value);
  if (!isRecord(value)) return { status: "unavailable" };
  if (typeof value.error === "string") {
    return {
      error: trimText(value.error),
      ...(typeof value.message === "string" ? { message: trimText(value.message) } : {}),
      skipped: value.error === "TEST_FRAMEWORK_MISSING",
    };
  }
  if (
    typeof value.runId !== "string" ||
    !isTestState(value.state)
  ) {
    return { status: "unavailable" };
  }
  const rawResults = Array.isArray(value.results)
    ? value.results.filter(isTestCaseResult)
    : [];
  const prioritizedResults = [
    ...rawResults.filter(
      (result) => result.status === "Failed" || result.status === "Inconclusive"
    ),
    ...rawResults.filter(
      (result) => result.status !== "Failed" && result.status !== "Inconclusive"
    ),
  ];
  return {
    runId: trimText(value.runId),
    state: value.state,
    ...(value.mode === "EditMode" || value.mode === "PlayMode" ? { mode: value.mode } : {}),
    ...(typeof value.total === "number" ? { total: value.total } : {}),
    ...(typeof value.passed === "number" ? { passed: value.passed } : {}),
    ...(typeof value.failed === "number" ? { failed: value.failed } : {}),
    ...(typeof value.skipped === "number" ? { skipped: value.skipped } : {}),
    ...(typeof value.durationSec === "number" ? { durationSec: value.durationSec } : {}),
    ...(typeof value.startedAt === "number" ? { startedAt: value.startedAt } : {}),
    ...(typeof value.finishedAt === "number" ? { finishedAt: value.finishedAt } : {}),
    ...(typeof value.settled === "boolean" ? { settled: value.settled } : {}),
    resultCount: rawResults.length,
    results: prioritizedResults.slice(0, QA_TEST_RESULT_LIMIT).map(trimTestResult),
    resultsTruncated: rawResults.length > QA_TEST_RESULT_LIMIT,
  };
}

function summarizeBuildSettings(value: BuildSettingsResult): QaBuildSettingsSummary {
  const prioritizedScenes = [
    ...value.scenes.filter((scene) => scene.enabled || !scene.exists),
    ...value.scenes.filter((scene) => !scene.enabled && scene.exists),
  ];
  return {
    valid: value.valid,
    activeBuildTarget: value.activeBuildTarget,
    buildTargetGroup: value.buildTargetGroup,
    targetSupported: value.targetSupported,
    developmentBuild: value.developmentBuild,
    enabledSceneCount: value.enabledSceneCount,
    sceneCount: value.scenes.length,
    scenes: prioritizedScenes.slice(0, QA_BUILD_SCENE_LIMIT),
    scenesTruncated: value.scenes.length > QA_BUILD_SCENE_LIMIT,
    issueCount: value.issues.length,
    issues: value.issues.slice(0, QA_BUILD_ISSUE_LIMIT).map((issue) => trimText(issue)),
    issuesTruncated: value.issues.length > QA_BUILD_ISSUE_LIMIT,
  };
}

function summarizeScan<THit>(value: {
  scanned: number;
  hits: THit[];
  truncated?: boolean;
}): QaScanSummary<THit> {
  return {
    scanned: value.scanned,
    hitCount: value.hits.length,
    hits: value.hits.slice(0, QA_SCAN_HIT_LIMIT),
    truncated: value.truncated === true,
    responseTruncated: value.hits.length > QA_SCAN_HIT_LIMIT,
  };
}

function summarizeSmokeTest(value: SmokeTestResult): QaSmokeTestSummary {
  const { console, performance, ...rest } = value;
  return {
    ...rest,
    reasons: boundStrings(value.reasons, QA_REASON_LIMIT),
    checks: value.checks.map((check) => ({ ...check, summary: trimText(check.summary) })),
    ...(console ? { console: summarizeConsole(console) } : {}),
    ...(performance ? { performance: summarizePerformance(performance) } : {}),
  };
}

function summarizeConsole(value: ConsoleLogsResult): QaConsoleSummary {
  return {
    logCount: value.logs.length,
    logs: value.logs.slice(0, QA_SMOKE_LOG_LIMIT).map(trimConsoleLog),
    logsTruncated: value.logs.length > QA_SMOKE_LOG_LIMIT,
    bufferSize: value.bufferSize,
    sourceTruncated: value.truncated,
    ...(value.fallback !== undefined ? { fallback: trimText(value.fallback) } : {}),
  };
}

function summarizePerformance(
  value: NonNullable<SmokeTestResult["performance"]>
): QaPerformanceSummary {
  const { counters, ...rest } = value;
  return {
    ...rest,
    counterCount: counters.length,
    counters: counters.slice(0, QA_PERF_COUNTER_LIMIT),
    countersTruncated: counters.length > QA_PERF_COUNTER_LIMIT,
  };
}

function isTestFrameworkMissing(value: QaTestsSummary | undefined): boolean {
  return isRecord(value) && "error" in value && value.error === "TEST_FRAMEWORK_MISSING";
}

function isConsoleLog(value: unknown): value is ConsoleLog {
  return (
    isRecord(value) &&
    isConsoleLogType(value.type) &&
    typeof value.message === "string" &&
    typeof value.timestamp === "number"
  );
}

function isErrorLog(value: ConsoleLog): boolean {
  return value.type === "Error" || value.type === "Assert" || value.type === "Exception";
}

function isConsoleLogType(value: unknown): value is ConsoleLog["type"] {
  return (
    value === "Log" ||
    value === "Warning" ||
    value === "Error" ||
    value === "Assert" ||
    value === "Exception"
  );
}

function isTestCaseResult(value: unknown): value is TestCaseResult {
  return (
    isRecord(value) &&
    typeof value.name === "string" &&
    (value.status === "Passed" ||
      value.status === "Failed" ||
      value.status === "Skipped" ||
      value.status === "Inconclusive")
  );
}

function isTestState(value: unknown): value is TestRunStatus["state"] {
  return (
    value === "running" ||
    value === "completed" ||
    value === "cancelled" ||
    value === "not_found"
  );
}

function trimConsoleLog(value: ConsoleLog): ConsoleLog {
  return {
    ...value,
    message: trimText(value.message),
    ...(value.stackTrace !== undefined ? { stackTrace: trimText(value.stackTrace, 4000) } : {}),
  };
}

function trimTestResult(value: TestCaseResult): TestCaseResult {
  return {
    ...value,
    name: trimText(value.name),
    ...(value.fullName !== undefined ? { fullName: trimText(value.fullName) } : {}),
    ...(value.message !== undefined ? { message: trimText(value.message) } : {}),
    ...(value.stackTrace !== undefined ? { stackTrace: trimText(value.stackTrace, 4000) } : {}),
  };
}

function nestedFailure(label: string, env: Extract<ToolEnvelope<unknown>, { ok: false }>): string {
  return `${label}: ${env.error.code} — ${env.error.message}`;
}

function appendWarnings<T>(label: string, env: ToolEnvelope<T>, warnings: string[]): void {
  if (!env.ok) return;
  warnings.push(...env.warnings.map((warning) => `${label}: ${warning}`));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function trimText(value: string, limit = 2000): string {
  return value.length <= limit ? value : `${value.slice(0, limit)}…`;
}

function summarizeStrings(values: string[], limit: number): string {
  const sample = values.slice(0, limit).map((value) => trimText(value)).join("; ");
  return values.length > limit ? `${sample}; … ${values.length - limit} more` : sample;
}

function boundStrings(values: string[], limit: number): string[] {
  const result = values.slice(0, limit).map((value) => trimText(value));
  if (values.length > limit) result.push(`… ${values.length - limit} more omitted.`);
  return result;
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}
