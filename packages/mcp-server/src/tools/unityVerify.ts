import { z } from "zod";
import { CompileStatus, ConsoleLogsResult, TestRunStatus, ToolEnvelope } from "@uvibe/core";
import { ToolContext, ToolDef } from "../registry.js";
import { isUnknownMethodError, ok } from "./_helpers.js";
import { unityWaitForCompile } from "./unityWaitForCompile.js";
import { unityRefreshAssets } from "./unityRefreshAssets.js";
import { unityGetConsoleLogs } from "./unityGetConsoleLogs.js";
import { unityRunTests } from "./unityRunTests.js";

/**
 * The canonical post-change verification loop in one call: wait for compilation to settle, read
 * new warnings/errors, then (if it compiled cleanly) run tests — returning a single pass/fail
 * verdict. This is what Claude should call after any C# change instead of orchestrating the
 * tools by hand, so a green/red answer costs one round trip.
 */

const InputShape = {
  runTests: z.boolean().optional().describe("Run the Test Framework after a clean compile. Default true."),
  testMode: z.enum(["EditMode", "PlayMode"]).optional().describe("Test mode (default EditMode)."),
  testFilter: z.string().optional().describe("Scope tests to a full-name filter."),
  compileTimeoutMs: z.number().int().min(500).max(300_000).optional(),
};

export const unityVerify: ToolDef<typeof InputShape, unknown> = {
  name: "unity_verify",
  description:
    "Runs the canonical edit-loop check after a code change — force AssetDatabase refresh → wait_for_compile → console warnings/errors → (if clean) run_tests → console errors emitted by tests — and returns one truthful verdict {pass, compiled, errorCount, problems, tests}. It catches files changed outside Unity, never passes while compilation is unsettled or when Error/Assert/Exception logs are present, and honors TEST_FRAMEWORK_MISSING gracefully.",
  requires: ["unity_bridge"],
  inputShape: InputShape,
  async run(args, ctx) {
    const wantTests = args.runTests ?? true;
    const warnings: string[] = [];
    let refreshVerified = true;

    const refreshEnv = (await unityRefreshAssets.run({}, ctx)) as ToolEnvelope<CompileStatus>;
    if (!refreshEnv.ok) {
      if (isUnknownMethodError(refreshEnv)) {
        refreshVerified = false;
        warnings.push(
          "Installed Unity package predates asset.refresh, so external file changes cannot be verified. Update or reinstall the UnityVibeOS package; verification cannot pass until then."
        );
      } else {
        return refreshEnv;
      }
    } else {
      warnings.push(...refreshEnv.warnings);
    }

    const compileEnv = (await unityWaitForCompile.run(
      { timeoutMs: args.compileTimeoutMs },
      ctx
    )) as ToolEnvelope<CompileStatus>;
    if (!compileEnv.ok) {
      // Couldn't even reach compile status (bridge down / reloading) — surface as-is.
      return compileEnv;
    }
    warnings.push(...compileEnv.warnings);
    const compile = compileEnv.data;
    const compiled = !compile.isCompiling && !compile.hasErrors;

    const initialConsole = await inspectConsole(ctx);
    const initialProblems = initialConsole.logs;
    let consoleReadable = initialConsole.readable;
    warnings.push(...initialConsole.warnings);

    let tests: unknown = wantTests ? (compiled ? undefined : "skipped (compile failed or did not settle)") : "skipped (runTests=false)";
    let testsPassed = true;
    let postTestProblems: ConsoleLogsResult["logs"] = [];
    if (wantTests && compiled) {
      const testStartedAt = Date.now();
      const testEnv = (await unityRunTests.run(
        { mode: args.testMode ?? "EditMode", filter: args.testFilter },
        ctx
      )) as ToolEnvelope<TestRunStatus>;
      if (testEnv.ok) {
        tests = testEnv.data;
        warnings.push(...testEnv.warnings);
        const total = testEnv.data.total ?? testEnv.data.results?.length ?? 0;
        const inconclusive = (testEnv.data.results ?? []).filter((r) => r.status === "Inconclusive").length;
        testsPassed =
          testEnv.data.state === "completed" &&
          (testEnv.data.failed ?? 0) === 0 &&
          inconclusive === 0;

        if (total === 0) {
          if (args.testFilter?.trim()) {
            testsPassed = false;
            warnings.push(`No tests matched filter '${args.testFilter}'.`);
          } else {
            warnings.push("Test run completed but discovered no tests; verification did not fail for that alone.");
          }
        }
        if (inconclusive > 0) warnings.push(`${inconclusive} test(s) were inconclusive.`);
      } else {
        tests = { error: testEnv.error.code, message: testEnv.error.message };
        // Missing framework shouldn't fail the verdict on its own; note it.
        if (testEnv.error.code === "TEST_FRAMEWORK_MISSING") warnings.push("Test Framework not installed; skipped tests.");
        else testsPassed = false;
      }

      const postTestConsole = await inspectConsole(ctx, testStartedAt - 1, "post-test console");
      postTestProblems = postTestConsole.logs;
      consoleReadable = consoleReadable && postTestConsole.readable;
      warnings.push(...postTestConsole.warnings);
    }

    const problems = uniqueLogs(initialProblems, postTestProblems);
    const consoleErrorCount = problems.filter((log) =>
      log.type === "Error" || log.type === "Assert" || log.type === "Exception"
    ).length;
    const verdict = {
      pass:
        refreshVerified &&
        compiled &&
        testsPassed &&
        consoleReadable &&
        consoleErrorCount === 0,
      refreshVerified,
      compiled,
      consoleReadable,
      errorCount: compile.errorCount,
      warningCount: compile.warningCount,
      consoleErrorCount,
      problems,
      tests,
    };
    if (compile.isCompiling) warnings.push("Compilation did not settle before the timeout.");
    else if (compile.hasErrors) warnings.push(`Compile failed with ${compile.errorCount} error(s).`);
    if (!consoleReadable) warnings.push("Console checks were incomplete; verification cannot pass.");
    if (!testsPassed) warnings.push("Tests did not pass.");
    if (consoleErrorCount > 0) warnings.push(`${consoleErrorCount} console error/assert/exception log(s) prevent verification from passing.`);

    return ok(verdict, { source: ctx.bridge.source, durationMs: 0 }, warnings);
  },
};

async function inspectConsole(
  ctx: ToolContext,
  sinceTimestamp?: number,
  label = "console"
): Promise<{ logs: ConsoleLogsResult["logs"]; readable: boolean; warnings: string[] }> {
  const visibleEnv = (await unityGetConsoleLogs.run(
    {
      level: "warning_or_error",
      limit: 50,
      ...(sinceTimestamp !== undefined ? { sinceTimestamp } : {}),
    },
    ctx
  )) as ToolEnvelope<ConsoleLogsResult>;
  if (!visibleEnv.ok) {
    return {
      logs: [],
      readable: false,
      warnings: [`${label}: ${visibleEnv.error.code}`],
    };
  }

  const warnings = [...visibleEnv.warnings];
  let logs = visibleEnv.data.logs;
  const needsHiddenErrorProbe =
    visibleEnv.data.truncated || logs.length >= 50;
  if (!needsHiddenErrorProbe) return { logs, readable: true, warnings };

  const errorEnv = (await unityGetConsoleLogs.run(
    {
      level: "error",
      limit: 50,
      ...(sinceTimestamp !== undefined ? { sinceTimestamp } : {}),
    },
    ctx
  )) as ToolEnvelope<ConsoleLogsResult>;
  if (!errorEnv.ok) {
    return {
      logs,
      readable: false,
      warnings: [...warnings, `${label} hidden-error probe: ${errorEnv.error.code}`],
    };
  }
  logs = uniqueLogs(logs, errorEnv.data.logs);
  warnings.push(...errorEnv.warnings);
  if (errorEnv.data.truncated) {
    warnings.push(`${label} error scan was truncated.`);
    return { logs, readable: false, warnings };
  }
  return { logs, readable: true, warnings };
}

function uniqueLogs(
  beforeTests: ConsoleLogsResult["logs"],
  afterTests: ConsoleLogsResult["logs"]
): ConsoleLogsResult["logs"] {
  const seen = new Set<string>();
  return [...beforeTests, ...afterTests].filter((log) => {
    const key = `${log.timestamp}\u0000${log.type}\u0000${log.message}\u0000${log.stackTrace ?? ""}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
