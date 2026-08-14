import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { BridgeClient } from "@gvibe/bridge-client";
import {
  BRIDGE_METHODS,
  type BridgeMethod,
  type BridgeResponse,
  type DebugEvent,
  type DebugSample,
  type DebugSnapshotResult,
} from "@gvibe/core";
import { buildContext } from "@gvibe/mcp-server";
import { GVibeConfigSchema, readActions, writeConfig } from "@gvibe/safety";
import { executeTool } from "../packages/mcp-server/src/execute.js";
import { godotDebugRun } from "../packages/mcp-server/src/tools/godotDebug.js";

const temporaryProjects: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryProjects.splice(0).map((project) => rm(project, { recursive: true, force: true })));
});

async function project(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "gvibe-debug-test-"));
  temporaryProjects.push(root);
  return root;
}

interface DebugBridgeOptions {
  existing?: boolean;
  staleEvents?: DebugEvent[];
  events?: DebugEvent[];
  samples?: DebugSample[];
  snapshotFailure?: boolean;
  connectAfterSnapshots?: number;
  replaceBeforeStop?: boolean;
  activeScene?: string;
  stopSignalDelaySnapshots?: number;
}

function debugBridge(options: DebugBridgeOptions = {}): { bridge: BridgeClient; calls: BridgeMethod[]; callParams: Array<{ method: BridgeMethod; params: Record<string, unknown> }> } {
  const calls: BridgeMethod[] = [];
  const callParams: Array<{ method: BridgeMethod; params: Record<string, unknown> }> = [];
  let playing = options.existing ?? false;
  let startedAtMs = playing ? 500 : 0;
  let runStarted = playing;
  let runtimeEverConnected = false;
  let observationSnapshots = 0;
  let screenshotId = "";
  let activeRunId = playing ? "run-1" : "stale-run";
  let replacementApplied = false;
  let postStopSnapshots = 0;
  const generatedSamples: DebugSample[] = [];
  const bridge: BridgeClient = {
    source: "mock",
    async call<T>(method: BridgeMethod, params: Record<string, unknown> = {}): Promise<BridgeResponse<T>> {
      calls.push(method);
      callParams.push({ method, params });
      if (method === BRIDGE_METHODS.playStatus) return success({ playing, scenePath: playing ? "res://main.tscn" : "" } as T);
      if (method === BRIDGE_METHODS.sceneGetOpenScenes) {
        const activeScene = options.activeScene === undefined ? "res://main.tscn" : options.activeScene;
        return success({
          scenes: activeScene ? [{ path: activeScene, name: "Main", rootType: "Node2D", active: true, unsaved: false }] : [],
          count: activeScene ? 1 : 0,
          activeScene,
        } as T);
      }
      if (method === BRIDGE_METHODS.playRun) {
        playing = true;
        runStarted = true;
        activeRunId = "run-1";
        startedAtMs = 1_000;
        return success({ playing: true, scenePath: "res://main.tscn", started: true, requestedMode: params.mode ?? "main" } as T);
      }
      if (method === BRIDGE_METHODS.playStop) {
        if (options.replaceBeforeStop && !replacementApplied) {
          activeRunId = "run-2";
          replacementApplied = true;
        }
        if (typeof params.expectedRunId === "string" && params.expectedRunId !== activeRunId) {
          return { id: "debug", ok: false, result: null, error: { code: "RUN_CHANGED", message: "replacement run left active" }, meta: {} };
        }
        playing = false;
        return success({ playing: false, scenePath: "", stopped: true } as T);
      }
      if (method === BRIDGE_METHODS.debugSnapshot) {
        if (playing) observationSnapshots += 1;
        else if (runStarted) postStopSnapshots += 1;
        if (options.snapshotFailure && playing && observationSnapshots === 2) {
          return { id: "debug", ok: false, result: null, error: { code: "BRIDGE_TIMEOUT", message: "snapshot timed out" }, meta: {} };
        }
        const runtimeConnected = playing && observationSnapshots > (options.connectAfterSnapshots ?? 0);
        runtimeEverConnected ||= runtimeConnected;
        if (runtimeConnected && !options.samples) {
          const cursor = generatedSamples.length + 1;
          generatedSamples.push(sample(cursor, { timestampMs: 1_000 + cursor * 400 }));
        }
        const eventPool = [
          ...(options.staleEvents ?? []),
          ...(runtimeEverConnected ? (options.events ?? []) : []),
        ];
        const samplePool = runtimeEverConnected ? (options.samples ?? generatedSamples) : [];
        const sinceEventCursor = typeof params.sinceEventCursor === "number" ? params.sinceEventCursor : 0;
        const sinceSampleCursor = typeof params.sinceSampleCursor === "number" ? params.sinceSampleCursor : 0;
        const maxEvents = typeof params.maxEvents === "number" ? params.maxEvents : 100;
        const maxSamples = typeof params.maxSamples === "number" ? params.maxSamples : 120;
        const events = eventPool.filter((event) => event.cursor > sinceEventCursor).slice(0, maxEvents);
        const samples = samplePool.filter((entry) => entry.cursor > sinceSampleCursor).slice(0, maxSamples);
        if (params.requestScreenshot === true && runtimeConnected) screenshotId = "capture-1";
        const snapshot: DebugSnapshotResult = {
          runId: activeRunId,
          sessionId: runStarted ? 1 : null,
          runtimeConnected,
          playing,
          breaked: false,
          startedAtMs,
          stoppedAtMs: playing || postStopSnapshots <= (options.stopSignalDelaySnapshots ?? 0) ? null : 2_000,
          eventCursor: eventPool.at(-1)?.cursor ?? 0,
          sampleCursor: samplePool.at(-1)?.cursor ?? 0,
          firstEventCursor: eventPool[0]?.cursor ?? 0,
          firstSampleCursor: samplePool[0]?.cursor ?? 0,
          missedEvents: 0,
          missedSamples: 0,
          events,
          samples,
          droppedEvents: 0,
          droppedSamples: 0,
          runtime: runtimeEverConnected ? { scenePath: "res://main.tscn", rootName: "Main", rootType: "Node2D", nodeCount: 12, pid: 123 } : null,
          screenshotId,
          screenshot: params.includeScreenshot === true && screenshotId ? {
            id: "capture-1", mimeType: "image/png", pngBase64: "iVBORw0KGgo=", width: 640, height: 360, bytes: 8, capturedAtMs: 1_500,
          } : null,
          capturePending: false,
          captureError: null,
        };
        return success(snapshot as T);
      }
      throw new Error(`Unexpected method ${method}`);
    },
    async isConnected() { return true; },
  };
  return { bridge, calls, callParams };
}

function success<T>(result: T): BridgeResponse<T> {
  return { id: "debug", ok: true, result, error: null, meta: { godotVersion: "4.7.1.mock", projectPath: "/mock/godot", durationMs: 1 } };
}

function sample(cursor: number, override: Partial<DebugSample> = {}): DebugSample {
  return {
    cursor, timestampMs: 1_000 + cursor, fps: 60, processMs: 8, physicsMs: 2,
    memoryBytes: 64_000_000, objectCount: 100, nodeCount: 12,
    orphanNodeCount: 0, drawCalls: 20, ...override,
  };
}

describe("godot_debug_run", () => {
  it("launches, observes, captures, stops, and returns a clean evidence packet", async () => {
    const root = await project();
    const { bridge, calls } = debugBridge();
    const ctx = buildContext({ bridgeOverride: bridge, projectPath: root });
    const envelope = await executeTool(godotDebugRun, { observeMs: 250 }, ctx);

    expect(envelope.ok).toBe(true);
    if (envelope.ok) {
      expect(envelope.data).toMatchObject({
        verdict: "clean",
        scenePath: "res://main.tscn",
        lifecycle: { startedByTool: true, attachedToExisting: false, stopRequested: true, stopped: true, playingAfter: false },
        diagnostics: { errorCount: 0, warningCount: 0, infoCount: 0, droppedEvents: 0, issues: [] },
        performance: { sampleCount: 4, fps: { min: 60, average: 60, max: 60 }, findings: [] },
        runtime: { connected: true, runId: "run-1", rootName: "Main", rootType: "Node2D", nodeCount: 12, pid: 123 },
        screenshot: { available: true, width: 640, height: 360, bytes: 8 },
        mimeType: "image/png",
      });
      expect(envelope.data.pngBase64).toBe("iVBORw0KGgo=");
    }
    expect(calls.filter((method) => method === BRIDGE_METHODS.playRun)).toHaveLength(1);
    expect(calls.filter((method) => method === BRIDGE_METHODS.playStop)).toHaveLength(1);
    expect(await readActions(root)).toEqual([expect.objectContaining({ tool: "godot_debug_run", result: "ok" })]);
  });

  it.each([
    { activeScene: "res://main.tscn", expectedMode: "current" },
    { activeScene: "", expectedMode: "main" },
  ])("automatically selects $expectedMode when the active scene is '$activeScene'", async ({ activeScene, expectedMode }) => {
    const root = await project();
    const { bridge, callParams } = debugBridge({ activeScene });
    const envelope = await executeTool(godotDebugRun, { observeMs: 250 }, buildContext({ bridgeOverride: bridge, projectPath: root }));

    expect(envelope.ok).toBe(true);
    const launch = callParams.find((call) => call.method === BRIDGE_METHODS.playRun);
    expect(launch?.params).toMatchObject({ mode: expectedMode });
  });

  it("deduplicates repeated diagnostics and reports deterministic performance findings", async () => {
    const root = await project();
    const repeated: DebugEvent = {
      cursor: 7, source: "runtime", severity: "error", kind: "script_error",
      message: "Invalid call", file: "res://player.gd", line: 12, function: "_process", timestampMs: 1_200,
    };
    const slow = sample(1, { timestampMs: 1_000, fps: 20, processMs: 70, physicsMs: 30, orphanNodeCount: 1 });
    const stableSlow = sample(2, { timestampMs: 2_100, fps: 20, processMs: 70, physicsMs: 30, orphanNodeCount: 1 });
    const { bridge } = debugBridge({ events: [repeated], samples: [slow, stableSlow] });
    const envelope = await executeTool(godotDebugRun, { observeMs: 250, targetFps: 60 }, buildContext({ bridgeOverride: bridge, projectPath: root }));

    expect(envelope.ok).toBe(true);
    if (envelope.ok) {
      expect(envelope.data.verdict).toBe("issues");
      expect(envelope.data.diagnostics).toMatchObject({ errorCount: 1, warningCount: 0 });
      expect(envelope.data.diagnostics.issues).toEqual([expect.objectContaining({ kind: "script_error", file: "res://player.gd", line: 12, count: 1 })]);
      expect(envelope.data.performance.findings.map((finding) => finding.code)).toEqual(["LOW_FPS", "FRAME_TIME_BUDGET", "PHYSICS_TIME_BUDGET"]);
    }
  });

  it("does not treat Godot's initial FPS warm-up values as a regression", async () => {
    const root = await project();
    const warmup = [
      sample(1, { timestampMs: 1_000, fps: 1 }),
      sample(2, { timestampMs: 1_250, fps: 1 }),
    ];
    const { bridge } = debugBridge({ samples: warmup });
    const envelope = await executeTool(godotDebugRun, { observeMs: 250 }, buildContext({ bridgeOverride: bridge, projectPath: root }));

    expect(envelope.ok).toBe(true);
    if (envelope.ok) {
      expect(envelope.data.verdict).toBe("clean");
      expect(envelope.data.performance).not.toHaveProperty("fps");
      expect(envelope.data.performance.findings.map((finding) => finding.code)).not.toContain("LOW_FPS");
    }
  });

  it("best-effort stops a run it launched when snapshot collection fails", async () => {
    const root = await project();
    const { bridge, calls } = debugBridge({ snapshotFailure: true });
    const envelope = await executeTool(godotDebugRun, { observeMs: 250 }, buildContext({ bridgeOverride: bridge, projectPath: root }));

    expect(envelope.ok).toBe(true);
    if (envelope.ok) {
      expect(envelope.data.verdict).toBe("unverified");
      expect(envelope.data.lifecycle).toMatchObject({ startedByTool: true, stopRequested: true, stopped: true, playingAfter: false });
    }
    expect(calls.filter((method) => method === BRIDGE_METHODS.playStop)).toHaveLength(1);
  });

  it("baselines retained prior-run evidence before launching a new run", async () => {
    const root = await project();
    const stale: DebugEvent = { cursor: 1, source: "runtime", severity: "error", kind: "old_error", message: "OLD RUN", file: "res://old.gd", line: 1, function: "old", timestampMs: 100 };
    const fresh: DebugEvent = { cursor: 2, source: "runtime", severity: "warning", kind: "new_warning", message: "NEW RUN", file: "res://new.gd", line: 2, function: "fresh", timestampMs: 1_100 };
    const { bridge } = debugBridge({ staleEvents: [stale], events: [fresh] });
    const envelope = await executeTool(godotDebugRun, { observeMs: 250 }, buildContext({ bridgeOverride: bridge, projectPath: root }));

    expect(envelope.ok).toBe(true);
    if (envelope.ok) {
      expect(envelope.data.diagnostics.issues).toEqual([expect.objectContaining({ kind: "new_warning", message: "NEW RUN" })]);
      expect(JSON.stringify(envelope.data)).not.toContain("OLD RUN");
    }
  });

  it("waits for the runtime probe before making its single screenshot request", async () => {
    const root = await project();
    const { bridge, callParams } = debugBridge({ connectAfterSnapshots: 2 });
    const envelope = await executeTool(godotDebugRun, { observeMs: 250 }, buildContext({ bridgeOverride: bridge, projectPath: root }));

    expect(envelope.ok).toBe(true);
    if (envelope.ok) expect(envelope.data.screenshot.available).toBe(true);
    const snapshots = callParams.filter((call) => call.method === BRIDGE_METHODS.debugSnapshot);
    expect(snapshots.filter((call) => call.params.requestScreenshot === true)).toHaveLength(1);
    expect(snapshots.findIndex((call) => call.params.requestScreenshot === true)).toBeGreaterThanOrEqual(3);
  });

  it("treats maxEvents as a hard total and keeps storm output compact", async () => {
    const root = await project();
    const events: DebugEvent[] = Array.from({ length: 500 }, (_, index) => ({
      cursor: index + 1,
      source: "runtime",
      severity: "error",
      kind: `error_${index + 1}`,
      message: `Failure ${index + 1}: ${"x".repeat(4_000)}`,
      file: "res://main.gd",
      line: index + 1,
      function: "_process",
      timestampMs: 1_000 + index,
    }));
    const { bridge, callParams } = debugBridge({ events });
    const envelope = await executeTool(godotDebugRun, { observeMs: 250, maxEvents: 200, capture: false }, buildContext({ bridgeOverride: bridge, projectPath: root }));

    expect(envelope.ok).toBe(true);
    if (envelope.ok) {
      expect(envelope.data.verdict).toBe("issues");
      expect(envelope.data.diagnostics).toMatchObject({ errorCount: 200, truncatedEvents: 300, omittedIssueGroups: 160 });
      expect(envelope.data.diagnostics.issues).toHaveLength(40);
      expect(Math.max(...envelope.data.diagnostics.issues.map((issue) => issue.message.length))).toBeLessThanOrEqual(600);
      expect(JSON.stringify(envelope.data).length).toBeLessThan(50_000);
    }
    const snapshots = callParams.filter((call) => call.method === BRIDGE_METHODS.debugSnapshot);
    expect(snapshots.length).toBeLessThan(10);
    expect(snapshots).toEqual(expect.arrayContaining([expect.objectContaining({ params: expect.objectContaining({ sinceEventCursor: 500, maxEvents: 1 }) })]));
  });

  it("returns unverified when an event bound truncates otherwise clean evidence", async () => {
    const root = await project();
    const events: DebugEvent[] = Array.from({ length: 3 }, (_, index) => ({
      cursor: index + 1, source: "runtime", severity: "info", kind: "print",
      message: `trace ${index + 1}`, file: "", line: 0, function: "", timestampMs: 1_000 + index,
    }));
    const { bridge } = debugBridge({ events });
    const envelope = await executeTool(godotDebugRun, { observeMs: 250, maxEvents: 2, capture: false }, buildContext({ bridgeOverride: bridge, projectPath: root }));

    expect(envelope.ok).toBe(true);
    if (envelope.ok) {
      expect(envelope.data.verdict).toBe("unverified");
      expect(envelope.data.diagnostics).toMatchObject({ infoCount: 2, truncatedEvents: 1, omittedIssueGroups: 0, issues: [] });
    }
  });

  it("attaches to an existing run without restarting or stopping it", async () => {
    const root = await project();
    const { bridge, calls } = debugBridge({ existing: true });
    const envelope = await executeTool(godotDebugRun, { observeMs: 250 }, buildContext({ bridgeOverride: bridge, projectPath: root }));

    expect(envelope.ok).toBe(true);
    if (envelope.ok) expect(envelope.data.lifecycle).toEqual({ startedByTool: false, attachedToExisting: true, stopRequested: false, stopped: false, playingAfter: true });
    expect(calls).not.toContain(BRIDGE_METHODS.playRun);
    expect(calls).not.toContain(BRIDGE_METHODS.playStop);
  });

  it("does not stop a replacement run when the owned run changes during cleanup", async () => {
    const root = await project();
    const { bridge, callParams } = debugBridge({ replaceBeforeStop: true });
    const envelope = await executeTool(godotDebugRun, { observeMs: 250 }, buildContext({ bridgeOverride: bridge, projectPath: root }));

    expect(envelope.ok).toBe(true);
    if (envelope.ok) {
      expect(envelope.data.lifecycle).toMatchObject({ startedByTool: true, stopRequested: true, stopped: false, playingAfter: true });
      expect(envelope.data.verdict).toBe("issues");
      expect(envelope.data.diagnostics.issues).toEqual(expect.arrayContaining([
        expect.objectContaining({ kind: "runtime_restarted" }),
        expect.objectContaining({ kind: "stop_failed", message: expect.stringContaining("replacement run left active") }),
      ]));
    }
    const stop = callParams.find((call) => call.method === BRIDGE_METHODS.playStop);
    expect(stop?.params).toEqual({ expectedRunId: "run-1" });
  });

  it("waits for the owned debugger run to publish its delayed stop signal", async () => {
    const root = await project();
    const { bridge, callParams } = debugBridge({ stopSignalDelaySnapshots: 2 });
    const envelope = await executeTool(godotDebugRun, { observeMs: 250 }, buildContext({ bridgeOverride: bridge, projectPath: root }));

    expect(envelope.ok).toBe(true);
    if (envelope.ok) expect(envelope.data.lifecycle).toMatchObject({ stopRequested: true, stopped: true, playingAfter: false });
    const stopIndex = callParams.findIndex((call) => call.method === BRIDGE_METHODS.playStop);
    expect(callParams.slice(stopIndex + 1).filter((call) => call.method === BRIDGE_METHODS.debugSnapshot).length).toBeGreaterThanOrEqual(3);
  });

  it("does not claim cleanup when debugger stop confirmation never arrives", async () => {
    const root = await project();
    const { bridge } = debugBridge({ stopSignalDelaySnapshots: 100 });
    const envelope = await executeTool(godotDebugRun, { observeMs: 250 }, buildContext({ bridgeOverride: bridge, projectPath: root }));

    expect(envelope.ok).toBe(true);
    if (envelope.ok) {
      expect(envelope.data.verdict).toBe("unverified");
      expect(envelope.data.lifecycle).toMatchObject({ stopRequested: true, stopped: false, playingAfter: false });
      expect(envelope.data.diagnostics.issues).toEqual(expect.arrayContaining([
        expect.objectContaining({ kind: "stop_failed", message: expect.stringContaining("did not confirm") }),
      ]));
    }
  });

  it("is blocked before touching the bridge in read-only mode", async () => {
    const root = await project();
    await writeConfig(root, GVibeConfigSchema.parse({ safetyMode: "read_only" }));
    const { bridge, calls } = debugBridge();
    const envelope = await executeTool(godotDebugRun, { observeMs: 250 }, buildContext({ bridgeOverride: bridge, projectPath: root }));

    expect(envelope.ok).toBe(false);
    if (!envelope.ok) expect(envelope.error.code).toBe("SAFETY_MODE_BLOCKED");
    expect(calls).toEqual([]);
  });
});
