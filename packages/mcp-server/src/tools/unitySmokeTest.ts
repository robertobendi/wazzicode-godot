import { z } from "zod";
import {
  ConsoleLog,
  ConsoleLogsResult,
  PerfSampleResult,
  PlayModeStatus,
  ScreenshotResult,
  ToolEnvelope,
} from "@uvibe/core";
import { ToolDef } from "../registry.js";
import { ok } from "./_helpers.js";
import {
  unityEnterPlayMode,
  unityExitPlayMode,
  unityGetPlayModeStatus,
} from "./unityPlayMode.js";
import { unityGetConsoleLogs } from "./unityGetConsoleLogs.js";
import { unityGetPerformanceStats } from "./unityGetPerformanceStats.js";
import { unityCaptureGameView } from "./unityCaptureGameView.js";

const InputShape = {
  settleMs: z
    .number()
    .int()
    .min(0)
    .max(30_000)
    .optional()
    .describe("Time to let play mode and profiler counters settle (default 1200ms)."),
  captureGameView: z.boolean().optional().describe("Capture the Game view (default true)."),
  saveScreenshot: z
    .boolean()
    .optional()
    .describe("Save the capture under .unity-vibe/screenshots/ (default true)."),
  width: z.number().int().min(64).max(3840).optional(),
  height: z.number().int().min(64).max(2160).optional(),
  format: z.enum(["png", "jpg"]).optional().describe("Screenshot format (default jpg)."),
  quality: z.number().int().min(1).max(100).optional().describe("JPEG quality (default 80)."),
  minFps: z.number().positive().max(1000).optional(),
  maxMainThreadMs: z.number().positive().max(10_000).optional(),
  maxGcAllocBytesPerFrame: z.number().nonnegative().optional(),
};

const CONSOLE_RESULT_LIMIT = 200;

export interface SmokeCheck {
  name: string;
  pass: boolean;
  skipped?: boolean;
  summary: string;
  actual?: number | string | boolean;
  expected?: number | string | boolean;
}

export interface ScreenshotSummary {
  source: ScreenshotResult["source"];
  width: number;
  height: number;
  mimeType: ScreenshotResult["mimeType"];
  savedTo?: string;
  subject?: string;
  cameraName?: string;
}

export interface SmokeTestResult {
  pass: boolean;
  startedAt: number;
  durationMs: number;
  enteredPlayMode: boolean;
  restoredPlayState: boolean;
  initialPlayState?: PlayModeStatus;
  checks: SmokeCheck[];
  reasons: string[];
  console?: ConsoleLogsResult;
  performance?: PerfSampleResult & { gcAllocBytesPerFrame?: number };
  screenshot?: ScreenshotSummary;
}

type Captured<T> =
  | { env: ToolEnvelope<T> }
  | { thrown: string };

export const unitySmokeTest: ToolDef<typeof InputShape, SmokeTestResult> = {
  name: "unity_smoke_test",
  description:
    "Runs a bounded play-mode smoke test in one call: preserves the Editor's initial play state, samples performance before capture work, checks runtime and post-cleanup errors, then restores edit mode only when this tool entered play mode. An existing paused or zero-time-scale session is left untouched and fails closed because safely observing it would advance irreversible game state.",
  requires: ["unity_bridge", "filesystem"],
  inputShape: InputShape,
  async run(args, ctx) {
    const startedAt = Date.now();
    const consoleSince = startedAt - 1;
    const checks: SmokeCheck[] = [];
    const reasons: string[] = [];
    const warnings: string[] = [];
    let initialPlayState: PlayModeStatus | undefined;
    let enteredPlayMode = false;
    let attemptedEntry = false;
    let playModeReady = false;
    let consoleResult: ConsoleLogsResult | undefined;
    let performanceResult: (PerfSampleResult & { gcAllocBytesPerFrame?: number }) | undefined;
    let screenshot: ScreenshotSummary | undefined;
    let restoredPlayState = false;

    const addCheck = (check: SmokeCheck): void => {
      checks.push(check);
      if (!check.pass && !check.skipped) reasons.push(check.summary);
    };

    try {
      const initial = await capture(() => unityGetPlayModeStatus.run({}, ctx));
      if ("thrown" in initial) {
        addCheck({
          name: "play_mode",
          pass: false,
          summary: `Could not read the initial play-mode state: ${initial.thrown}`,
        });
      } else if (!initial.env.ok) {
        addCheck({
          name: "play_mode",
          pass: false,
          summary: nestedFailure("Could not read the initial play-mode state", initial.env),
        });
      } else {
        initialPlayState = initial.env.data;
        appendWarnings("play mode status", initial.env, warnings);
        if (initialPlayState.isTransitioning) {
          addCheck({
            name: "play_mode",
            pass: false,
            summary: "Unity was already transitioning play mode; the smoke test did not interfere.",
          });
        } else if (initialPlayState.isPlaying) {
          addCheck({
            name: "play_mode",
            pass: true,
            summary: "Found an already-running play-mode session.",
          });
          const paused = initialPlayState.isPaused;
          const zeroTimeScale =
            initialPlayState.timeScale !== undefined && initialPlayState.timeScale <= 0;
          if (paused || zeroTimeScale) {
            addCheck({
              name: "play_mode_observable",
              pass: false,
              summary:
                "The existing play-mode session is paused or has timeScale=0. It was left untouched because resuming it would irreversibly advance game state; resume it manually or stop it and rerun the smoke test.",
            });
          } else {
            playModeReady = true;
          }
        } else {
          attemptedEntry = true;
          const entered = await capture(() =>
            unityEnterPlayMode.run({ waitForReady: true, timeoutMs: 60_000 }, ctx)
          );
          if ("thrown" in entered) {
            addCheck({
              name: "play_mode",
              pass: false,
              summary: `Could not enter play mode: ${entered.thrown}`,
            });
          } else if (!entered.env.ok) {
            addCheck({
              name: "play_mode",
              pass: false,
              summary: nestedFailure("Could not enter play mode", entered.env),
            });
          } else {
            appendWarnings("enter play mode", entered.env, warnings);
            enteredPlayMode = entered.env.data.isPlaying;
            playModeReady = entered.env.data.isPlaying && entered.env.data.isTransitioning !== true;
            addCheck({
              name: "play_mode",
              pass: playModeReady,
              summary: playModeReady
                ? "Entered play mode and reached a settled running state."
                : "The play-mode entry call returned without reaching a settled running state.",
            });
          }
        }
      }

      if (playModeReady) {
        const settleMs = args.settleMs ?? 1200;
        if (!ctx.configMockMode && settleMs > 0) await sleep(settleMs);

        // Sample performance before capture/console RPC work can perturb profiler counters. Read
        // the console last so errors from every observation attempt are included in the verdict.
        const performanceCapture = await capture(() =>
          unityGetPerformanceStats.run({ detailLevel: "full" }, ctx)
        );
        const screenshotCapture = (args.captureGameView ?? true)
          ? await capture(() =>
              unityCaptureGameView.run(
                {
                  width: args.width ?? 640,
                  height: args.height ?? 360,
                  save: args.saveScreenshot ?? true,
                  format: args.format ?? "jpg",
                  quality: args.quality ?? 80,
                },
                ctx
              )
            )
          : undefined;
        const consoleCapture = await capture(() =>
          unityGetConsoleLogs.run(
            {
              level: "error",
              limit: CONSOLE_RESULT_LIMIT,
              sinceTimestamp: consoleSince,
              detailLevel: "full",
            },
            ctx
          )
        );

        if ("thrown" in consoleCapture) {
          addCheck({
            name: "console_errors",
            pass: false,
            summary: `Could not inspect runtime console errors: ${consoleCapture.thrown}`,
          });
        } else if (!consoleCapture.env.ok) {
          addCheck({
            name: "console_errors",
            pass: false,
            summary: nestedFailure("Could not inspect runtime console errors", consoleCapture.env),
          });
        } else {
          appendWarnings("runtime console", consoleCapture.env, warnings);
          consoleResult = consoleCapture.env.data;
          const runtimeErrors = consoleResult.logs.filter(isErrorLog);
          const complete = !consoleResult.truncated;
          addCheck({
            name: "console_errors",
            pass: runtimeErrors.length === 0 && complete,
            summary:
              !complete
                ? `Runtime console results were truncated; a complete error check could not be verified${runtimeErrors.length > 0 ? ` (${runtimeErrors.length} error(s) were returned).` : "."}`
                : runtimeErrors.length === 0
                ? "No new Error, Assert, or Exception logs were emitted."
                : `${runtimeErrors.length} new runtime error/assert/exception log(s) were emitted.`,
            actual: runtimeErrors.length,
            expected: 0,
          });
        }

        if ("thrown" in performanceCapture) {
          addCheck({
            name: "performance_sample",
            pass: false,
            summary: `Could not collect profiler counters: ${performanceCapture.thrown}`,
          });
        } else if (!performanceCapture.env.ok) {
          addCheck({
            name: "performance_sample",
            pass: false,
            summary: nestedFailure("Could not collect profiler counters", performanceCapture.env),
          });
        } else {
          appendWarnings("performance", performanceCapture.env, warnings);
          const perf = performanceCapture.env.data;
          const gcAllocBytesPerFrame = perf.counters.find(
            (counter) => counter.name === "GC Allocated In Frame"
          )?.average;
          performanceResult = {
            ...perf,
            ...(gcAllocBytesPerFrame !== undefined ? { gcAllocBytesPerFrame } : {}),
          };
          const hasSamples =
            perf.warmingUp !== true &&
            (perf.mainThreadMs !== undefined ||
              perf.estimatedFps !== undefined ||
              perf.counters.some((counter) => (counter.sampleCount ?? 0) > 0));
          addCheck({
            name: "performance_sample",
            pass: hasSamples,
            summary: hasSamples
              ? "Profiler counters contained frame samples."
              : perf.fallback ?? "Profiler counters did not contain settled frame samples.",
          });

          if (args.minFps !== undefined) {
            const fps = perf.estimatedFps;
            addCheck({
              name: "minimum_fps",
              pass: fps !== undefined && fps >= args.minFps,
              summary:
                fps === undefined
                  ? `FPS was unavailable; the ${args.minFps} FPS minimum could not be verified.`
                  : fps >= args.minFps
                    ? `Estimated FPS ${formatMetric(fps)} met the ${args.minFps} minimum.`
                    : `Estimated FPS ${formatMetric(fps)} was below the ${args.minFps} minimum.`,
              ...(fps !== undefined ? { actual: fps } : {}),
              expected: args.minFps,
            });
          }
          if (args.maxMainThreadMs !== undefined) {
            const mainThreadMs = perf.mainThreadMs;
            addCheck({
              name: "main_thread_budget",
              pass: mainThreadMs !== undefined && mainThreadMs <= args.maxMainThreadMs,
              summary:
                mainThreadMs === undefined
                  ? `Main-thread time was unavailable; the ${args.maxMainThreadMs}ms budget could not be verified.`
                  : mainThreadMs <= args.maxMainThreadMs
                    ? `Main-thread time ${formatMetric(mainThreadMs)}ms met the ${args.maxMainThreadMs}ms budget.`
                    : `Main-thread time ${formatMetric(mainThreadMs)}ms exceeded the ${args.maxMainThreadMs}ms budget.`,
              ...(mainThreadMs !== undefined ? { actual: mainThreadMs } : {}),
              expected: args.maxMainThreadMs,
            });
          }
          if (args.maxGcAllocBytesPerFrame !== undefined) {
            addCheck({
              name: "gc_allocation_budget",
              pass:
                gcAllocBytesPerFrame !== undefined &&
                gcAllocBytesPerFrame <= args.maxGcAllocBytesPerFrame,
              summary:
                gcAllocBytesPerFrame === undefined
                  ? `Per-frame GC allocation was unavailable; the ${args.maxGcAllocBytesPerFrame}-byte budget could not be verified.`
                  : gcAllocBytesPerFrame <= args.maxGcAllocBytesPerFrame
                    ? `Per-frame GC allocation ${formatMetric(gcAllocBytesPerFrame)} bytes met the ${args.maxGcAllocBytesPerFrame}-byte budget.`
                    : `Per-frame GC allocation ${formatMetric(gcAllocBytesPerFrame)} bytes exceeded the ${args.maxGcAllocBytesPerFrame}-byte budget.`,
              ...(gcAllocBytesPerFrame !== undefined ? { actual: gcAllocBytesPerFrame } : {}),
              expected: args.maxGcAllocBytesPerFrame,
            });
          }
        }

        if (screenshotCapture === undefined) {
          addCheck({
            name: "game_view_capture",
            pass: true,
            skipped: true,
            summary: "Game-view capture was disabled.",
          });
        } else if ("thrown" in screenshotCapture) {
          addCheck({
            name: "game_view_capture",
            pass: false,
            summary: `Could not capture the Game view: ${screenshotCapture.thrown}`,
          });
        } else if (!screenshotCapture.env.ok) {
          addCheck({
            name: "game_view_capture",
            pass: false,
            summary: nestedFailure("Could not capture the Game view", screenshotCapture.env),
          });
        } else {
          appendWarnings("game view capture", screenshotCapture.env, warnings);
          screenshot = summarizeScreenshot(screenshotCapture.env.data);
          addCheck({
            name: "game_view_capture",
            pass: true,
            summary: `Captured ${screenshot.width}x${screenshot.height} ${screenshot.mimeType} from the Game view.`,
          });
          if (args.saveScreenshot ?? true) {
            addCheck({
              name: "game_view_saved",
              pass: screenshot.savedTo !== undefined,
              summary: screenshot.savedTo
                ? `Saved the Game-view capture to ${screenshot.savedTo}.`
                : "The Game-view capture succeeded but could not be saved.",
            });
          }
        }
      } else {
        addCheck({
          name: "runtime_observations",
          pass: false,
          skipped: true,
          summary: "Runtime observations were skipped because play mode was not ready.",
        });
      }
    } catch (error: unknown) {
      addCheck({
        name: "smoke_execution",
        pass: false,
        summary: `Smoke-test orchestration failed: ${errorMessage(error)}`,
      });
    } finally {
      const initialState = initialPlayState;
      if (initialState?.isPlaying) {
        const finalStatus = await capture(() => unityGetPlayModeStatus.run({}, ctx));
        if ("thrown" in finalStatus) {
          addCheck({
            name: "play_mode_cleanup",
            pass: false,
            summary: `Could not confirm the existing play-mode session was preserved: ${finalStatus.thrown}`,
          });
        } else if (!finalStatus.env.ok) {
          addCheck({
            name: "play_mode_cleanup",
            pass: false,
            summary: nestedFailure(
              "Could not confirm the existing play-mode session was preserved",
              finalStatus.env
            ),
          });
        } else {
          appendWarnings("final play mode status", finalStatus.env, warnings);
          const pausePreserved = finalStatus.env.data.isPaused === initialState.isPaused;
          const timeScalePreserved =
            initialState.timeScale === undefined ||
            (finalStatus.env.data.timeScale !== undefined &&
              approximatelyEqual(finalStatus.env.data.timeScale, initialState.timeScale));
          restoredPlayState =
            finalStatus.env.data.isPlaying &&
            finalStatus.env.data.isTransitioning !== true &&
            pausePreserved &&
            timeScalePreserved;
          addCheck({
            name: "play_mode_cleanup",
            pass: restoredPlayState,
            summary: restoredPlayState
              ? "Left the pre-existing play-mode session untouched."
              : "The pre-existing play-mode session changed unexpectedly during the smoke test.",
          });
        }
      } else if (attemptedEntry) {
        if (!enteredPlayMode) {
          const current = await capture(() => unityGetPlayModeStatus.run({}, ctx));
          if ("thrown" in current) {
            addCheck({
              name: "play_mode_cleanup",
              pass: false,
              summary: `Could not determine whether a failed entry attempt changed play mode: ${current.thrown}`,
            });
          } else if (!current.env.ok) {
            addCheck({
              name: "play_mode_cleanup",
              pass: false,
              summary: nestedFailure(
                "Could not determine whether a failed entry attempt changed play mode",
                current.env
              ),
            });
          } else {
            appendWarnings("cleanup play mode status", current.env, warnings);
            enteredPlayMode = current.env.data.isPlaying || current.env.data.isTransitioning === true;
            if (!enteredPlayMode) {
              restoredPlayState = true;
              addCheck({
                name: "play_mode_cleanup",
                pass: true,
                summary: "Unity remained stopped after the unsuccessful play-mode entry.",
              });
            }
          }
        }

        if (enteredPlayMode) {
          const exited = await capture(() =>
            unityExitPlayMode.run({ waitForReady: true, timeoutMs: 60_000 }, ctx)
          );
          if ("thrown" in exited) {
            addCheck({
              name: "play_mode_cleanup",
              pass: false,
              summary: `Could not restore edit mode: ${exited.thrown}`,
            });
          } else if (!exited.env.ok) {
            addCheck({
              name: "play_mode_cleanup",
              pass: false,
              summary: nestedFailure("Could not restore edit mode", exited.env),
            });
          } else {
            appendWarnings("exit play mode", exited.env, warnings);
            restoredPlayState =
              !exited.env.data.isPlaying && exited.env.data.isTransitioning !== true;
            addCheck({
              name: "play_mode_cleanup",
              pass: restoredPlayState,
              summary: restoredPlayState
                ? "Exited the play-mode session started by the smoke test."
                : "The exit call returned before edit mode was restored.",
            });
          }
        }
      } else {
        restoredPlayState = initialPlayState !== undefined && initialPlayState.isTransitioning !== true;
        addCheck({
          name: "play_mode_cleanup",
          pass: restoredPlayState,
          skipped: restoredPlayState,
          summary: restoredPlayState
            ? "No play-mode state change required cleanup."
            : "Unity's pre-existing play-mode transition could not be verified or restored.",
        });
      }
    }

    const postCleanupConsole = await capture(() =>
      unityGetConsoleLogs.run(
        {
          level: "error",
          limit: CONSOLE_RESULT_LIMIT,
          sinceTimestamp: consoleSince,
          detailLevel: "full",
        },
        ctx
      )
    );
    if ("thrown" in postCleanupConsole) {
      addCheck({
        name: "post_cleanup_console_errors",
        pass: false,
        summary: `Could not inspect console errors after play-mode cleanup: ${postCleanupConsole.thrown}`,
      });
    } else if (!postCleanupConsole.env.ok) {
      addCheck({
        name: "post_cleanup_console_errors",
        pass: false,
        summary: nestedFailure(
          "Could not inspect console errors after play-mode cleanup",
          postCleanupConsole.env
        ),
      });
    } else {
      appendWarnings("post-cleanup console", postCleanupConsole.env, warnings);
      const finalConsoleResult = postCleanupConsole.env.data;
      const finalErrors = finalConsoleResult.logs.filter(isErrorLog);
      const complete = !finalConsoleResult.truncated;
      consoleResult = mergeConsoleResults(consoleResult, finalConsoleResult);
      addCheck({
        name: "post_cleanup_console_errors",
        pass: finalErrors.length === 0 && complete,
        summary: !complete
          ? `Post-cleanup console results were truncated; the smoke test cannot prove that cleanup emitted no errors${finalErrors.length > 0 ? ` (${finalErrors.length} error(s) were returned).` : "."}`
          : finalErrors.length === 0
            ? "Play-mode cleanup emitted no Error, Assert, or Exception logs."
            : `${finalErrors.length} error/assert/exception log(s) were present after play-mode cleanup.`,
        actual: finalErrors.length,
        expected: 0,
      });
    }

    const durationMs = Date.now() - startedAt;
    const data: SmokeTestResult = {
      pass: checks.every((check) => check.pass),
      startedAt,
      durationMs,
      enteredPlayMode,
      restoredPlayState,
      ...(initialPlayState ? { initialPlayState } : {}),
      checks,
      reasons: unique(reasons),
      ...(consoleResult ? { console: consoleResult } : {}),
      ...(performanceResult ? { performance: performanceResult } : {}),
      ...(screenshot ? { screenshot } : {}),
    };
    return ok(data, { source: ctx.bridge.source, durationMs }, unique(warnings));
  },
};

async function capture<T>(call: () => Promise<ToolEnvelope<T>>): Promise<Captured<T>> {
  try {
    return { env: await call() };
  } catch (error: unknown) {
    return { thrown: errorMessage(error) };
  }
}

function nestedFailure(label: string, env: Extract<ToolEnvelope<unknown>, { ok: false }>): string {
  return `${label}: ${env.error.code} — ${env.error.message}`;
}

function appendWarnings<T>(label: string, env: ToolEnvelope<T>, warnings: string[]): void {
  if (!env.ok) return;
  warnings.push(...env.warnings.map((warning) => `${label}: ${warning}`));
}

function isErrorLog(log: ConsoleLog): boolean {
  return log.type === "Error" || log.type === "Assert" || log.type === "Exception";
}

function summarizeScreenshot(data: ScreenshotResult): ScreenshotSummary {
  return {
    source: data.source,
    width: data.width,
    height: data.height,
    mimeType: data.mimeType,
    ...(data.savedTo !== undefined ? { savedTo: data.savedTo } : {}),
    ...(data.subject !== undefined ? { subject: data.subject } : {}),
    ...(data.cameraName !== undefined ? { cameraName: data.cameraName } : {}),
  };
}

function mergeConsoleResults(
  beforeCleanup: ConsoleLogsResult | undefined,
  afterCleanup: ConsoleLogsResult
): ConsoleLogsResult {
  if (!beforeCleanup) return afterCleanup;
  const seen = new Set<string>();
  const logs = [...beforeCleanup.logs, ...afterCleanup.logs].filter((log) => {
    const key = `${log.timestamp}\u0000${log.type}\u0000${log.message}\u0000${log.stackTrace ?? ""}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const clipped = logs.length > CONSOLE_RESULT_LIMIT;
  return {
    logs: logs.slice(-CONSOLE_RESULT_LIMIT),
    truncated: beforeCleanup.truncated || afterCleanup.truncated || clipped,
    bufferSize: Math.max(beforeCleanup.bufferSize, afterCleanup.bufferSize),
    ...(afterCleanup.fallback !== undefined
      ? { fallback: afterCleanup.fallback }
      : beforeCleanup.fallback !== undefined
        ? { fallback: beforeCleanup.fallback }
        : {}),
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function formatMetric(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(2);
}

function approximatelyEqual(a: number, b: number): boolean {
  return Math.abs(a - b) <= 0.0001;
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
