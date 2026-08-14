import { z } from "zod";
import type {
  DebugEvent,
  DebugRuntime,
  DebugSample,
  DebugScreenshot,
  DebugSnapshotResult,
  OpenScenesResult,
  PlayStatus,
  ToolEnvelope,
} from "@gvibe/core";
import type { ToolDef, ToolContext } from "../registry.js";
import { BRIDGE_METHODS, bridgeCall, ok } from "./_helpers.js";

const DebugRunShape = {
  mode: z.enum(["current", "main", "custom"]).optional(),
  path: z.string().optional().describe("Required when mode is custom."),
  observeMs: z.number().int().min(250).max(15_000).optional(),
  stopAfter: z.boolean().optional(),
  capture: z.boolean().optional(),
  maxEvents: z.number().int().min(1).max(200).optional(),
  targetFps: z.number().finite().positive().max(1_000).optional(),
};

export interface DebugRunIssue {
  severity: "error" | "warning";
  source: "editor" | "runtime";
  kind: string;
  message: string;
  file?: string;
  line?: number;
  function?: string;
  count: number;
}

export interface DebugRunResult {
  verdict: "clean" | "issues" | "unverified" | "launch_failed";
  summary: string;
  scenePath: string;
  observeMs: number;
  lifecycle: {
    startedByTool: boolean;
    attachedToExisting: boolean;
    stopRequested: boolean;
    stopped: boolean;
    playingAfter: boolean;
  };
  diagnostics: {
    errorCount: number;
    warningCount: number;
    infoCount: number;
    droppedEvents: number;
    droppedSamples: number;
    missedEvents: number;
    missedSamples: number;
    truncatedEvents: number;
    omittedIssueGroups: number;
    issues: DebugRunIssue[];
  };
  performance: {
    sampleCount: number;
    fps?: MetricRange;
    frameMs?: PercentileRange;
    physicsMs?: PercentileRange;
    memoryBytesMax?: number;
    nodeCountMax?: number;
    orphanNodeDelta?: number;
    drawCallsP95?: number;
    findings: Array<{ severity: "warning"; code: string; message: string }>;
  };
  runtime: {
    connected: boolean;
    runId: string;
    rootName: string;
    rootType: string;
    nodeCount: number;
    pid: number;
  } | null;
  screenshot: {
    available: boolean;
    width?: number;
    height?: number;
    bytes?: number;
    captureError?: string;
  };
  pngBase64?: string;
  mimeType?: "image/png";
}

interface MetricRange { min: number; average: number; max: number }
interface PercentileRange { p50: number; p95: number; max: number }

export const godotDebugRun: ToolDef<typeof DebugRunShape, DebugRunResult> = {
  name: "godot_debug_run",
  description: "Runs or attaches to a Godot game, then returns one bounded evidence packet of runtime errors, warnings, performance samples, lifecycle state, and an optional game screenshot.",
  requires: ["godot_bridge"],
  write: true,
  writeTarget: "editor",
  inputShape: DebugRunShape,
  async run(args, ctx) {
    let mode = args.mode;
    const observeMs = args.observeMs ?? 3_000;
    const stopAfter = args.stopAfter ?? true;
    const capture = args.capture ?? true;
    const maxEvents = args.maxEvents ?? 100;
    const targetFps = args.targetFps ?? 60;
    const started = Date.now();
    if (mode === "custom" && (!args.path || args.path.trim().length === 0)) {
      return debugResult(ctx, started, observeMs, {
        verdict: "launch_failed",
        summary: "A res:// scene path is required for a custom debug run.",
      });
    }

    let initialStatus: ToolEnvelope<PlayStatus>;
    try {
      initialStatus = await bridgeCall(ctx.bridge, BRIDGE_METHODS.playStatus);
    } catch (error) {
      return debugResult(ctx, started, observeMs, {
        verdict: "unverified",
        summary: `Could not read Godot play state: ${errorMessage(error)}`,
      });
    }
    if (!initialStatus.ok) {
      return debugResult(ctx, started, observeMs, {
        verdict: "unverified",
        summary: `Could not read Godot play state: ${initialStatus.error.message}`,
      });
    }

    const attachedToExisting = initialStatus.data.playing;
    if (!attachedToExisting && mode === undefined) {
      try {
        const scenes = await bridgeCall<OpenScenesResult>(ctx.bridge, BRIDGE_METHODS.sceneGetOpenScenes);
        mode = scenes.ok && scenes.data.activeScene.length > 0 ? "current" : "main";
      } catch {
        mode = "main";
      }
    }
    let baseline: ToolEnvelope<DebugSnapshotResult>;
    try {
      baseline = await bridgeCall(ctx.bridge, BRIDGE_METHODS.debugSnapshot, {
        maxEvents: 1,
        maxSamples: 1,
        requestScreenshot: false,
        includeScreenshot: false,
      }, "full");
    } catch (error) {
      return debugResult(ctx, started, observeMs, {
        verdict: "unverified",
        summary: `Could not establish a debug cursor baseline: ${errorMessage(error)}`,
        scenePath: initialStatus.data.scenePath,
      });
    }
    if (!baseline.ok) {
      return debugResult(ctx, started, observeMs, {
        verdict: "unverified",
        summary: `Could not establish a debug cursor baseline: ${baseline.error.message}`,
        scenePath: initialStatus.data.scenePath,
      });
    }

    let startedByTool = false;
    let scenePath = initialStatus.data.scenePath;
    if (!attachedToExisting) {
      let launch: ToolEnvelope<PlayStatus>;
      try {
        launch = await bridgeCall(ctx.bridge, BRIDGE_METHODS.playRun, {
          mode,
          ...(mode === "custom" ? { path: args.path } : {}),
        });
      } catch (error) {
        return debugResult(ctx, started, observeMs, {
          verdict: "launch_failed",
          summary: `Godot could not launch the requested scene: ${errorMessage(error)}`,
        });
      }
      if (!launch.ok || !launch.data.playing) {
        return debugResult(ctx, started, observeMs, {
          verdict: "launch_failed",
          summary: !launch.ok
            ? `Godot could not launch the requested scene: ${launch.error.message}`
            : "Godot accepted the run request but did not enter play mode.",
          scenePath: launch.ok ? launch.data.scenePath : scenePath,
        });
      }
      startedByTool = true;
      scenePath = launch.data.scenePath;
    }

    const state = createObservationState(baseline.data, attachedToExisting);
    let observationFailure = "";
    let stopFailure = "";
    let stopAccepted = false;
    let ownedRunId = "";
    let stopped = false;
    const stopRequested = startedByTool && stopAfter;
    const deadline = Date.now() + observeMs;
    let polls = 0;

    try {
      for (;;) {
        if (polls >= 600) {
          observationFailure = "Debug pagination exceeded its bounded 600-snapshot limit.";
          break;
        }
        const eventPageLimit = eventPageSize(state, maxEvents);
        const snapshot = await takeSnapshot(ctx, state, eventPageLimit, observeMs, false, true);
        if (!snapshot.ok) {
          observationFailure = snapshot.error.message;
          break;
        }
        const page = consumeSnapshot(state, snapshot.data, false, true, maxEvents, eventPageLimit, samplePageSize(observeMs));
        if (snapshot.data.runtime?.scenePath) scenePath = snapshot.data.runtime.scenePath;
        polls += 1;
        if (!snapshot.data.playing) {
          addSyntheticIssue(state, "warning", "runtime", "runtime_stopped", "The game stopped before the observation window ended.");
          break;
        }
        const mustContinue = page.moreEvents || page.moreSamples;
        if (ctx.bridge.source === "mock") {
          if (!mustContinue && polls >= 4) break;
          if (polls >= 32) break;
        } else {
          if (Date.now() >= deadline && !page.moreEvents && !page.moreSamples) break;
          if (!page.moreEvents && !page.moreSamples) {
            await delay(Math.min(200, Math.max(1, deadline - Date.now())));
          }
        }
      }

      if (!observationFailure && capture && state.runtimeConnectedEver && state.latestPlaying) {
        const captureDeadline = Date.now() + 2_000;
        for (let capturePoll = 0; capturePoll < 40; capturePoll += 1) {
          const eventPageLimit = eventPageSize(state, maxEvents);
          const snapshot = await takeSnapshot(ctx, state, eventPageLimit, observeMs, true, false);
          if (!snapshot.ok) {
            observationFailure = snapshot.error.message;
            break;
          }
          const page = consumeSnapshot(state, snapshot.data, false, false, maxEvents, eventPageLimit, 1);
          if (snapshot.data.runtime?.scenePath) scenePath = snapshot.data.runtime.scenePath;
          polls += 1;
          const captureFinished = Boolean(state.screenshot) || Boolean(state.captureError) || !snapshot.data.playing;
          if (captureFinished && !page.moreEvents) break;
          const withinCaptureBudget = ctx.bridge.source === "mock" ? capturePoll < 7 : Date.now() < captureDeadline;
          if (!withinCaptureBudget) break;
          if (!page.moreEvents && ctx.bridge.source !== "mock") await delay(50);
        }
      }
    } catch (error) {
      observationFailure = errorMessage(error);
    } finally {
      if (stopRequested) {
        if (!state.latestRunId) {
          try {
            const eventPageLimit = eventPageSize(state, maxEvents);
            const guardSnapshot = await takeSnapshot(ctx, state, eventPageLimit, observeMs, false, false);
            if (guardSnapshot.ok) consumeSnapshot(state, guardSnapshot.data, false, false, maxEvents, eventPageLimit, 1);
          } catch {
            // Cleanup below remains fail-closed when the run identity cannot be established.
          }
        }
        if (!state.latestRunId) {
          stopFailure = "The launched run could not be identified safely, so it was left running.";
        } else {
          ownedRunId = state.latestRunId;
          try {
            const stop = await bridgeCall<PlayStatus>(ctx.bridge, BRIDGE_METHODS.playStop, { expectedRunId: ownedRunId });
            if (stop.ok) {
              stopAccepted = stop.data.stopped === true || !stop.data.playing;
              if (!stopAccepted) stopFailure = "Godot did not accept the guarded stop request.";
            }
            else stopFailure = stop.error.message;
          } catch (error) {
            stopFailure = errorMessage(error);
          }
        }
      }
    }

    try {
      const postStopDeadline = Date.now() + 2_000;
      for (let finalPoll = 0; finalPoll < 600; finalPoll += 1) {
        const eventPageLimit = eventPageSize(state, maxEvents);
        const finalSnapshot = await takeSnapshot(ctx, state, eventPageLimit, observeMs, false, false);
        if (!finalSnapshot.ok) {
          if (!observationFailure) observationFailure = finalSnapshot.error.message;
          break;
        }
        const page = consumeSnapshot(state, finalSnapshot.data, stopRequested && (stopAccepted || stopped), false, maxEvents, eventPageLimit, 1);
        if (stopRequested && ownedRunId && finalSnapshot.data.runId === ownedRunId && finalSnapshot.data.stoppedAtMs !== null) {
          stopped = true;
          stopFailure = "";
        }
        if (page.moreEvents || page.moreSamples) continue;
        const awaitingStopConfirmation = stopRequested && Boolean(ownedRunId) && !stopped;
        const withinConfirmationBudget = ctx.bridge.source === "mock" ? finalPoll < 7 : Date.now() < postStopDeadline;
        if (awaitingStopConfirmation && withinConfirmationBudget) {
          if (ctx.bridge.source !== "mock") await delay(50);
          continue;
        }
        break;
      }
    } catch (error) {
      if (!observationFailure) observationFailure = errorMessage(error);
    }
    if (stopRequested && stopAccepted && !stopped && !stopFailure) {
      stopFailure = "Godot accepted the stop request, but the debugger did not confirm that the owned run exited.";
    }

    let playingAfter = state.latestPlaying;
    try {
      const finalStatus = await bridgeCall<PlayStatus>(ctx.bridge, BRIDGE_METHODS.playStatus);
      if (finalStatus.ok) playingAfter = finalStatus.data.playing;
    } catch {
      // The final debug snapshot still provides a truthful last observed play state.
    }
    if (stopFailure && stopped) {
      stopFailure = "";
    } else if (stopFailure) {
      addSyntheticIssue(state, "warning", "editor", "stop_failed", `Godot did not confirm cleanup: ${stopFailure}`);
    }

    const diagnostics = summarizeDiagnostics(state);
    const performance = summarizePerformance(state.samples, targetFps);
    const hasObservedIssues = diagnostics.issues.some((issue) => issue.kind !== "stop_failed") || performance.findings.length > 0;
    const missedEvidence = Math.max(state.missedEvents, state.droppedEvents) + Math.max(state.missedSamples, state.droppedSamples) + state.truncatedEvents;
    const evidenceFailure = observationFailure || stopFailure;
    const evidenceMissing = Boolean(evidenceFailure) || !state.runtimeConnectedEver || state.samples.length === 0 || missedEvidence > 0;
    const verdict: DebugRunResult["verdict"] = hasObservedIssues ? "issues" : evidenceMissing ? "unverified" : "clean";
    const summary = summarizeVerdict(verdict, diagnostics.issues.length + diagnostics.omittedIssueGroups, performance.findings.length, observeMs, evidenceFailure, missedEvidence);
    const screenshot = screenshotSummary(capture, state);
    const runtime = runtimeSummary(state);
    const result: DebugRunResult = {
      verdict,
      summary,
      scenePath,
      observeMs,
      lifecycle: { startedByTool, attachedToExisting, stopRequested, stopped, playingAfter },
      diagnostics,
      performance,
      runtime,
      screenshot,
      ...(state.screenshot ? { pngBase64: state.screenshot.pngBase64, mimeType: state.screenshot.mimeType } : {}),
    };
    return ok(result, { source: ctx.bridge.source, durationMs: Date.now() - started }, evidenceFailure ? [`Debug evidence was incomplete: ${evidenceFailure}`] : []);
  },
};

interface ObservationState {
  eventCursor?: number;
  sampleCursor?: number;
  events: DebugEvent[];
  samples: DebugSample[];
  eventKeys: Set<string>;
  sampleKeys: Set<string>;
  syntheticIssues: DebugRunIssue[];
  latestRuntime: DebugRuntime | null;
  baselineRunId: string;
  latestRunId: string;
  runtimeConnectedEver: boolean;
  latestPlaying: boolean;
  missedEvents: number;
  missedSamples: number;
  baselineDroppedEvents: number;
  baselineDroppedSamples: number;
  droppedEvents: number;
  droppedSamples: number;
  truncatedEvents: number;
  screenshotRequested: boolean;
  baselineScreenshotId: string;
  requestedScreenshotId: string;
  screenshot: DebugScreenshot | null;
  capturePending: boolean;
  captureError: string;
}

function createObservationState(baseline: DebugSnapshotResult, attachedToExisting: boolean): ObservationState {
  return {
    eventCursor: baseline.eventCursor,
    sampleCursor: baseline.sampleCursor,
    events: [], samples: [], eventKeys: new Set(), sampleKeys: new Set(), syntheticIssues: [],
    latestRuntime: attachedToExisting ? baseline.runtime : null,
    baselineRunId: baseline.runId,
    latestRunId: attachedToExisting ? baseline.runId : "",
    runtimeConnectedEver: attachedToExisting && baseline.runtimeConnected,
    latestPlaying: baseline.playing,
    missedEvents: 0, missedSamples: 0,
    baselineDroppedEvents: baseline.droppedEvents,
    baselineDroppedSamples: baseline.droppedSamples,
    droppedEvents: 0, droppedSamples: 0, truncatedEvents: 0, screenshotRequested: false,
    baselineScreenshotId: baseline.screenshotId,
    requestedScreenshotId: "", screenshot: null, capturePending: false, captureError: "",
  };
}

async function takeSnapshot(
  ctx: ToolContext,
  state: ObservationState,
  maxEvents: number,
  observeMs: number,
  requestCapture: boolean,
  collectPerformanceSamples: boolean,
): Promise<ToolEnvelope<DebugSnapshotResult>> {
  const requestScreenshot = requestCapture && state.runtimeConnectedEver && !state.screenshotRequested;
  if (requestScreenshot) state.screenshotRequested = true;
  const maxSamples = collectPerformanceSamples ? samplePageSize(observeMs) : 1;
  return bridgeCall(ctx.bridge, BRIDGE_METHODS.debugSnapshot, {
    ...(state.eventCursor !== undefined ? { sinceEventCursor: state.eventCursor } : {}),
    ...(state.sampleCursor !== undefined ? { sinceSampleCursor: state.sampleCursor } : {}),
    maxEvents,
    maxSamples,
    requestScreenshot,
    includeScreenshot: requestCapture || state.screenshotRequested,
  }, "full");
}

function consumeSnapshot(
  state: ObservationState,
  snapshot: DebugSnapshotResult,
  afterToolStop: boolean,
  collectPerformanceSamples: boolean,
  totalEventLimit: number,
  eventPageLimit: number,
  maxSamples: number,
): { moreEvents: boolean; moreSamples: boolean } {
  const previousRunId = state.latestRunId;
  const identifiesCurrentRun = snapshot.runId && (snapshot.runtimeConnected || snapshot.runId !== state.baselineRunId || previousRunId === snapshot.runId);
  if (identifiesCurrentRun) state.latestRunId = snapshot.runId;
  if (previousRunId && identifiesCurrentRun && previousRunId !== snapshot.runId) {
    addSyntheticIssue(state, "warning", "runtime", "runtime_restarted", "The running game changed during the observation window.");
  }
  const runKey = snapshot.runId || "no-run";
  const remainingEvents = Math.max(0, totalEventLimit - state.events.length);
  const retainedEvents = snapshot.events.slice(0, remainingEvents);
  for (const event of retainedEvents) {
    const key = `${runKey}:${event.cursor}`;
    if (!state.eventKeys.has(key)) {
      state.eventKeys.add(key);
      state.events.push(event);
    }
  }
  if (collectPerformanceSamples) {
    for (const sample of snapshot.samples) {
      const key = `${runKey}:${sample.cursor}`;
      if (!state.sampleKeys.has(key)) {
        state.sampleKeys.add(key);
        state.samples.push(sample);
      }
    }
  }
  const previousEventCursor = state.eventCursor ?? 0;
  const previousSampleCursor = state.sampleCursor ?? 0;
  const lastEventCursor = retainedEvents.at(-1)?.cursor;
  const lastSampleCursor = snapshot.samples.at(-1)?.cursor;
  const eventLimitReached = state.events.length >= totalEventLimit;
  const skippedFromCursor = lastEventCursor ?? previousEventCursor;
  if (eventLimitReached && snapshot.eventCursor > skippedFromCursor) {
    const gapAlreadyMissing = retainedEvents.length === 0 ? snapshot.missedEvents : 0;
    state.truncatedEvents += Math.max(0, snapshot.eventCursor - skippedFromCursor - gapAlreadyMissing);
  }
  const moreEvents = !eventLimitReached && snapshot.events.length >= eventPageLimit && lastEventCursor !== undefined && lastEventCursor < snapshot.eventCursor;
  const moreSamples = collectPerformanceSamples && snapshot.samples.length >= maxSamples && lastSampleCursor !== undefined && lastSampleCursor < snapshot.sampleCursor;
  state.eventCursor = eventLimitReached ? snapshot.eventCursor : moreEvents ? lastEventCursor : snapshot.eventCursor;
  state.sampleCursor = collectPerformanceSamples && moreSamples ? lastSampleCursor : snapshot.sampleCursor;
  state.runtimeConnectedEver ||= snapshot.runtimeConnected;
  state.latestPlaying = snapshot.playing;
  state.latestRuntime = snapshot.runtime ?? state.latestRuntime;
  state.missedEvents += snapshot.missedEvents;
  if (collectPerformanceSamples) state.missedSamples += snapshot.missedSamples;
  state.droppedEvents = Math.max(state.droppedEvents, snapshot.droppedEvents - state.baselineDroppedEvents, 0);
  if (collectPerformanceSamples) {
    state.droppedSamples = Math.max(state.droppedSamples, snapshot.droppedSamples - state.baselineDroppedSamples, 0);
  }
  if (snapshot.breaked && !afterToolStop) {
    addSyntheticIssue(state, "warning", "runtime", "debugger_break", "The game paused in the debugger during the observation window.");
  }
  if (
    state.screenshotRequested &&
    !state.requestedScreenshotId &&
    snapshot.screenshotId &&
    snapshot.screenshotId !== state.baselineScreenshotId
  ) {
    state.requestedScreenshotId = snapshot.screenshotId;
  }
  if (state.requestedScreenshotId && snapshot.screenshotId === state.requestedScreenshotId) {
    state.capturePending = snapshot.capturePending;
    state.captureError = snapshot.captureError ?? "";
    if (snapshot.screenshot?.id === state.requestedScreenshotId) {
      state.screenshot = snapshot.screenshot;
      state.capturePending = false;
      state.captureError = "";
    }
  }
  return {
    moreEvents: moreEvents && state.eventCursor > previousEventCursor,
    moreSamples: moreSamples && state.sampleCursor > previousSampleCursor,
  };
}

function addSyntheticIssue(
  state: ObservationState,
  severity: "error" | "warning",
  source: "editor" | "runtime",
  kind: string,
  message: string,
): void {
  if (state.syntheticIssues.some((issue) => issue.severity === severity && issue.source === source && issue.kind === kind && issue.message === message)) return;
  state.syntheticIssues.push({ severity, source, kind, message, count: 1 });
}

function summarizeDiagnostics(state: ObservationState): DebugRunResult["diagnostics"] {
  const MAX_ISSUE_GROUPS = 40;
  const grouped = new Map<string, DebugRunIssue>();
  let errorCount = 0;
  let warningCount = 0;
  let infoCount = 0;
  for (const event of state.events) {
    if (event.severity === "error") errorCount += 1;
    else if (event.severity === "warning") warningCount += 1;
    else infoCount += 1;
    if (event.severity === "info") continue;
    const key = [event.severity, event.source, event.kind, event.message, event.file, event.line, event.function].join("\u0000");
    const current = grouped.get(key);
    if (current) current.count += 1;
    else grouped.set(key, {
      severity: event.severity,
      source: event.source,
      kind: event.kind,
      message: event.message,
      ...(event.file ? { file: event.file } : {}),
      ...(event.line > 0 ? { line: event.line } : {}),
      ...(event.function ? { function: event.function } : {}),
      count: 1,
    });
  }
  for (const issue of state.syntheticIssues) {
    const key = [issue.severity, issue.source, issue.kind, issue.message, issue.file ?? "", issue.line ?? 0, issue.function ?? ""].join("\u0000");
    const current = grouped.get(key);
    if (current) current.count += issue.count;
    else grouped.set(key, { ...issue });
    if (issue.severity === "error") errorCount += issue.count;
    else warningCount += issue.count;
  }
  const allIssues = [...grouped.values()].sort((a, b) => {
    const severity = (a.severity === "error" ? 0 : 1) - (b.severity === "error" ? 0 : 1);
    if (severity !== 0) return severity;
    return [a.source, a.kind, a.file ?? "", String(a.line ?? 0), a.message].join("\u0000")
      .localeCompare([b.source, b.kind, b.file ?? "", String(b.line ?? 0), b.message].join("\u0000"));
  });
  const issues = allIssues.slice(0, MAX_ISSUE_GROUPS).map((issue) => ({
    ...issue,
    kind: compact(issue.kind, 100),
    message: compact(issue.message, 600),
    ...(issue.file ? { file: compact(issue.file, 400) } : {}),
    ...(issue.function ? { function: compact(issue.function, 200) } : {}),
  }));
  return {
    errorCount,
    warningCount,
    infoCount,
    droppedEvents: state.droppedEvents,
    droppedSamples: state.droppedSamples,
    missedEvents: state.missedEvents,
    missedSamples: state.missedSamples,
    truncatedEvents: state.truncatedEvents,
    omittedIssueGroups: allIssues.length - issues.length,
    issues,
  };
}

function summarizePerformance(samples: DebugSample[], targetFps: number): DebugRunResult["performance"] {
  const values = <K extends keyof DebugSample>(key: K): number[] => samples
    .map((sample) => sample[key])
    .filter((value): value is number => typeof value === "number" && Number.isFinite(value));
  const stableTimingSamples = samples.filter((sample) => sample.timestampMs >= 2_000);
  const stableTimingValues = <K extends "processMs" | "physicsMs">(key: K): number[] => stableTimingSamples
    .map((sample) => sample[key])
    .filter((value): value is number => typeof value === "number" && Number.isFinite(value));
  const fpsValues = stableTimingSamples
    .map((sample) => sample.fps)
    .filter((value): value is number => typeof value === "number" && Number.isFinite(value));
  const frameValues = stableTimingValues("processMs");
  const physicsValues = stableTimingValues("physicsMs");
  const memoryValues = values("memoryBytes");
  const nodeValues = values("nodeCount");
  const orphanValues = values("orphanNodeCount");
  const drawValues = values("drawCalls");
  const fps = metricRange(fpsValues);
  const frameMs = percentileRange(frameValues);
  const physicsMs = percentileRange(physicsValues);
  const findings: DebugRunResult["performance"]["findings"] = [];
  const frameBudget = 1_000 / targetFps;
  if (fps && fps.average < targetFps * 0.9) findings.push({ severity: "warning", code: "LOW_FPS", message: `Average FPS ${fps.average} was below 90% of the ${round(targetFps)} target.` });
  if (frameMs && frameMs.p95 > frameBudget * 1.25) findings.push({ severity: "warning", code: "FRAME_TIME_BUDGET", message: `95th-percentile process time ${frameMs.p95}ms exceeded the ${round(frameBudget)}ms frame budget.` });
  if (physicsMs && physicsMs.p95 > frameBudget) findings.push({ severity: "warning", code: "PHYSICS_TIME_BUDGET", message: `95th-percentile physics time ${physicsMs.p95}ms exceeded the ${round(frameBudget)}ms frame budget.` });
  const orphanNodeDelta = orphanValues.length >= 2 ? round(orphanValues[orphanValues.length - 1] - orphanValues[0]) : undefined;
  if (orphanNodeDelta !== undefined && orphanNodeDelta > 0) findings.push({ severity: "warning", code: "ORPHAN_NODE_GROWTH", message: `Orphan node count grew by ${orphanNodeDelta} during the run.` });
  return {
    sampleCount: samples.length,
    ...(fps ? { fps } : {}),
    ...(frameMs ? { frameMs } : {}),
    ...(physicsMs ? { physicsMs } : {}),
    ...(memoryValues.length ? { memoryBytesMax: Math.max(...memoryValues) } : {}),
    ...(nodeValues.length ? { nodeCountMax: Math.max(...nodeValues) } : {}),
    ...(orphanNodeDelta !== undefined ? { orphanNodeDelta } : {}),
    ...(drawValues.length ? { drawCallsP95: percentile(drawValues, 0.95) } : {}),
    findings,
  };
}

function metricRange(values: number[]): MetricRange | undefined {
  if (!values.length) return undefined;
  return { min: round(Math.min(...values)), average: round(values.reduce((sum, value) => sum + value, 0) / values.length), max: round(Math.max(...values)) };
}

function percentileRange(values: number[]): PercentileRange | undefined {
  if (!values.length) return undefined;
  return { p50: percentile(values, 0.5), p95: percentile(values, 0.95), max: round(Math.max(...values)) };
}

function percentile(values: number[], quantile: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return round(sorted[Math.max(0, Math.ceil(sorted.length * quantile) - 1)]);
}

function round(value: number): number { return Math.round(value * 100) / 100; }
function samplePageSize(observeMs: number): number { return Math.min(120, Math.max(16, Math.ceil(observeMs / 50) + 16)); }
function eventPageSize(state: ObservationState, totalLimit: number): number { return Math.max(1, totalLimit - state.events.length); }
function compact(value: string, maxLength: number): string { return value.length <= maxLength ? value : `${value.slice(0, maxLength - 1)}…`; }

function runtimeSummary(state: ObservationState): DebugRunResult["runtime"] {
  if (!state.latestRuntime) return null;
  return {
    connected: state.runtimeConnectedEver,
    runId: state.latestRunId,
    rootName: state.latestRuntime.rootName,
    rootType: state.latestRuntime.rootType,
    nodeCount: state.latestRuntime.nodeCount,
    pid: state.latestRuntime.pid,
  };
}

function screenshotSummary(capture: boolean, state: ObservationState): DebugRunResult["screenshot"] {
  if (state.screenshot) return { available: true, width: state.screenshot.width, height: state.screenshot.height, bytes: state.screenshot.bytes };
  if (!capture) return { available: false };
  if (state.captureError) return { available: false, captureError: state.captureError };
  if (state.capturePending) return { available: false, captureError: "Game screenshot capture was still pending when the observation ended." };
  return { available: false, captureError: "No screenshot was returned for this debug run." };
}

function summarizeVerdict(
  verdict: DebugRunResult["verdict"],
  issueCount: number,
  performanceCount: number,
  observeMs: number,
  failure: string,
  missedEvidence: number,
): string {
  if (verdict === "issues") return `${issueCount} diagnostic issue${issueCount === 1 ? "" : "s"} and ${performanceCount} performance finding${performanceCount === 1 ? "" : "s"} were observed in ${observeMs}ms.`;
  if (verdict === "clean") return `No runtime warnings, errors, or performance regressions were observed in ${observeMs}ms.`;
  if (failure) return `The game launched, but the debug evidence was incomplete: ${failure}`;
  if (missedEvidence > 0) return `The game launched, but ${missedEvidence} diagnostic item${missedEvidence === 1 ? " was" : "s were"} missed before collection.`;
  return "The game launched, but the runtime probe did not provide enough evidence for a clean verdict.";
}

function debugResult(
  ctx: ToolContext,
  started: number,
  observeMs: number,
  partial: { verdict: DebugRunResult["verdict"]; summary: string; scenePath?: string },
) {
  return ok<DebugRunResult>({
    verdict: partial.verdict,
    summary: partial.summary,
    scenePath: partial.scenePath ?? "",
    observeMs,
    lifecycle: { startedByTool: false, attachedToExisting: false, stopRequested: false, stopped: false, playingAfter: false },
    diagnostics: { errorCount: 0, warningCount: 0, infoCount: 0, droppedEvents: 0, droppedSamples: 0, missedEvents: 0, missedSamples: 0, truncatedEvents: 0, omittedIssueGroups: 0, issues: [] },
    performance: { sampleCount: 0, findings: [] },
    runtime: null,
    screenshot: { available: false },
  }, { source: ctx.bridge.source, durationMs: Date.now() - started });
}

function delay(ms: number): Promise<void> { return new Promise((resolve) => setTimeout(resolve, ms)); }
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }
