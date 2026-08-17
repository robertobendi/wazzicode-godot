import { promises as fs } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { CAPTURE_FRAME_LIMITS, type DebugCaptureFramesResult, type DebugFrame, type ToolEnvelope } from "@gvibe/core";
import { resolveProjectPath } from "@gvibe/safety";
import type { ToolContext, ToolDef } from "../registry.js";
import { reportProgress } from "../progress.js";
import { BRIDGE_METHODS, bridgeCall, err, ok } from "./_helpers.js";

const LIMITS = CAPTURE_FRAME_LIMITS;
const CAPTURE_DIRECTORY = ".godot/godot-vibe-os/captures";
/** Hamming distance over the 64-bit average hash above which two frames read as different. */
const CHANGE_THRESHOLD = 5;
const POLL_GRACE_MS = 10_000;
const MAX_POLLS = 512;
/** A capture cost past one 60fps frame is a hitch a player would feel. */
const HITCH_BUDGET_MS = 16.7;

const CaptureFramesShape = {
  frames: z.number().int().min(LIMITS.frames.min).max(LIMITS.frames.max).optional(),
  intervalMs: z.number().int().min(LIMITS.intervalMs.min).max(LIMITS.intervalMs.max).optional()
    .describe("Requested spacing between frames. Godot's own viewport-capture cadence is 400ms because get_image() forces a GPU flush."),
  width: z.number().int().min(LIMITS.width.min).max(LIMITS.width.max).optional().describe("Frame width; height follows the game's aspect ratio."),
  format: z.enum(["jpg", "png"]).optional(),
  quality: z.number().int().min(LIMITS.quality.min).max(LIMITS.quality.max).optional().describe("JPEG quality; ignored for png."),
  save: z.boolean().optional().describe("Also write the frames under res://.godot/godot-vibe-os/captures/."),
  returnImages: z.enum(["all", "changed", "none"]).optional()
    .describe("'changed' returns the first frame plus frames that visibly differ from the last returned one."),
};

export interface CaptureFrameSummary {
  index: number;
  label: string;
  tMs: number;
  deltaMs: number;
  frameTimeMs: number;
  captureCostMs: number;
  width: number;
  height: number;
  bytes: number;
  hash: string;
  returned: boolean;
  savedPath?: string;
  mimeType?: string;
  base64?: string;
}

export interface CaptureFramesResult {
  requested: { frames: number; intervalMs: number; width: number; format: "jpg" | "png"; quality: number; returnImages: "all" | "changed" | "none"; save: boolean };
  actual: { frames: number; avgIntervalMs: number | null; droppedFrames: number; avgFrameTimeImpactMs: number | null };
  savedPaths: string[];
  dedup: { captured: number; returned: number; skippedUnchanged: number };
  frames: CaptureFrameSummary[];
}

export const godotCaptureFrames: ToolDef<typeof CaptureFramesShape, CaptureFramesResult> = {
  name: "godot_capture_frames",
  description: "Captures a timed sequence of frames from the RUNNING Godot game over the editor debugger channel, so motion, animation, and transitions are visible instead of a single still. Requires a live play session; the editor-viewport tools cannot see the game.",
  requires: ["godot_bridge", "filesystem"],
  inputShape: CaptureFramesShape,
  async run(args, ctx) {
    const started = Date.now();
    const requested = {
      frames: args.frames ?? LIMITS.frames.default,
      intervalMs: args.intervalMs ?? LIMITS.intervalMs.default,
      width: args.width ?? LIMITS.width.default,
      format: args.format ?? ("jpg" as const),
      quality: args.quality ?? LIMITS.quality.default,
      returnImages: args.returnImages ?? ("changed" as const),
      save: args.save ?? true,
    };

    reportProgress(ctx, 0, `Requesting ${requested.frames} frames from the running game…`, requested.frames);
    const first = await bridgeCall<DebugCaptureFramesResult>(ctx.bridge, BRIDGE_METHODS.debugCaptureFrames, {
      frames: requested.frames,
      intervalMs: requested.intervalMs,
      width: requested.width,
      format: requested.format,
      quality: requested.quality,
      maxFrames: LIMITS.page.default,
    }, "full");
    if (!first.ok) return first;

    const refusal = captureRefusal(first.data, ctx);
    if (refusal) return refusal;

    const collected: DebugFrame[] = [...first.data.frames];
    const reportCollected = () => reportProgress(ctx, collected.length, `Captured frame ${collected.length}/${requested.frames}`, requested.frames);
    if (collected.length > 0) reportCollected();
    let state = first.data.state;
    let capturedCount = first.data.capturedCount;
    let droppedFrames = first.data.droppedFrames;
    let captureError = first.data.error;
    let timedOut = false;
    const deadline = Date.now() + requested.frames * requested.intervalMs + POLL_GRACE_MS;
    const pollDelayMs = Math.max(50, Math.min(200, Math.round(requested.intervalMs / 2)));

    for (let poll = 0; poll < MAX_POLLS; poll += 1) {
      if (state !== "pending" && collected.length >= capturedCount) break;
      if (Date.now() >= deadline) {
        timedOut = true;
        break;
      }
      if (collected.length >= capturedCount && ctx.bridge.source !== "mock") await delay(pollDelayMs);
      const page: ToolEnvelope<DebugCaptureFramesResult> = await bridgeCall(ctx.bridge, BRIDGE_METHODS.debugCaptureFrames, {
        captureId: first.data.captureId,
        sinceIndex: collected.at(-1)?.index ?? 0,
        maxFrames: LIMITS.page.default,
      }, "full");
      if (!page.ok) return page;
      state = page.data.state;
      capturedCount = page.data.capturedCount;
      droppedFrames = page.data.droppedFrames;
      captureError = page.data.error;
      collected.push(...page.data.frames);
      reportCollected();
      if (state === "error") break;
    }
    if (state === "error" && collected.length === 0) {
      return err("CAPTURE_UNAVAILABLE", captureError ?? "The running game could not capture frames.", { source: ctx.bridge.source, durationMs: Date.now() - started });
    }

    const summaries = summarizeFrames(collected, requested.returnImages);
    const saved = requested.save ? await saveFrames(ctx, first.data.captureId, collected, summaries) : { paths: [], warnings: [] };
    const intervals = collected.slice(1).map((frame) => frame.deltaMs);
    const costs = collected.map((frame) => frame.captureCostMs);
    const avgFrameTimeImpactMs = average(costs);
    const result: CaptureFramesResult = {
      requested,
      actual: {
        frames: collected.length,
        avgIntervalMs: average(intervals),
        droppedFrames,
        avgFrameTimeImpactMs,
      },
      savedPaths: saved.paths,
      dedup: {
        captured: collected.length,
        returned: summaries.filter((frame) => frame.returned).length,
        skippedUnchanged: requested.returnImages === "changed" ? summaries.filter((frame) => !frame.returned).length : 0,
      },
      frames: summaries,
    };

    const warnings = [...saved.warnings];
    if (timedOut) warnings.push(`The frame sequence did not finish within its ${Math.round((deadline - started) / 1000)}s budget; ${collected.length} of ${requested.frames} frames were collected.`);
    if (state === "error" && captureError) warnings.push(`The running game stopped capturing early: ${captureError}`);
    if (droppedFrames > 0) warnings.push(`${droppedFrames} frame(s) were dropped by the running game and are not part of this sequence.`);
    if (collected.length < requested.frames && !timedOut && state !== "error") warnings.push(`Only ${collected.length} of the ${requested.frames} requested frames were captured.`);
    if (avgFrameTimeImpactMs !== null && avgFrameTimeImpactMs > HITCH_BUDGET_MS) {
      warnings.push(`Capturing cost the running game ${avgFrameTimeImpactMs}ms per frame on average, so the observed motion includes capture-induced stutter.`);
    }
    return ok(result, { source: ctx.bridge.source, durationMs: Date.now() - started, projectPath: ctx.projectPath }, warnings);
  },
};

function captureRefusal(data: DebugCaptureFramesResult, ctx: ToolContext) {
  if (data.state === "not_running") {
    return err("PLAY_MODE_REQUIRED", data.error ?? "No Godot game is running, so there are no frames to capture.", { source: ctx.bridge.source });
  }
  if (data.state === "error" && data.frames.length === 0) {
    return err("CAPTURE_UNAVAILABLE", data.error ?? "The running game could not capture frames.", { source: ctx.bridge.source });
  }
  return undefined;
}

function summarizeFrames(frames: DebugFrame[], returnImages: "all" | "changed" | "none"): CaptureFrameSummary[] {
  let lastReturnedHash = "";
  return frames.map((frame, position) => {
    const returned = returnImages === "none"
      ? false
      : returnImages === "all" || lastReturnedHash.length === 0 || hammingDistance(frame.hash, lastReturnedHash) > CHANGE_THRESHOLD;
    if (returned) lastReturnedHash = frame.hash;
    return {
      index: frame.index,
      label: `Frame ${position + 1}/${frames.length} — t=+${frame.tMs}ms`,
      tMs: frame.tMs,
      deltaMs: frame.deltaMs,
      frameTimeMs: round(frame.frameTimeMs),
      captureCostMs: round(frame.captureCostMs),
      width: frame.width,
      height: frame.height,
      bytes: frame.bytes,
      hash: frame.hash,
      returned,
      ...(returned ? { mimeType: frame.mimeType, base64: frame.base64 } : {}),
    };
  });
}

async function saveFrames(
  ctx: ToolContext,
  captureId: string,
  frames: DebugFrame[],
  summaries: CaptureFrameSummary[],
): Promise<{ paths: string[]; warnings: string[] }> {
  const paths: string[] = [];
  const warnings: string[] = [];
  const stem = captureId.replace(/[^A-Za-z0-9._-]/g, "-").slice(0, 60) || "frames";
  for (const [position, frame] of frames.entries()) {
    const extension = frame.mimeType === "image/png" ? "png" : "jpg";
    const relative = `${CAPTURE_DIRECTORY}/${stem}-${String(frame.index).padStart(2, "0")}.${extension}`;
    try {
      const resolved = await resolveProjectPath(ctx.projectPath, relative);
      await fs.mkdir(path.dirname(resolved.absolute), { recursive: true });
      await fs.writeFile(resolved.absolute, Buffer.from(frame.base64, "base64"));
      const resPath = `res://${resolved.relative.split(path.sep).join("/")}`;
      paths.push(resPath);
      summaries[position].savedPath = resPath;
    } catch (error) {
      warnings.push(`Frame ${frame.index} was captured but could not be written to ${relative}: ${error instanceof Error ? error.message : String(error)}`);
      break;
    }
  }
  return { paths, warnings };
}

function hammingDistance(a: string, b: string): number {
  if (a.length !== b.length) return Number.MAX_SAFE_INTEGER;
  let distance = 0;
  for (let index = 0; index < a.length; index += 1) {
    let difference = parseInt(a[index], 16) ^ parseInt(b[index], 16);
    while (difference > 0) {
      distance += difference & 1;
      difference >>= 1;
    }
  }
  return distance;
}

function average(values: number[]): number | null {
  if (values.length === 0) return null;
  return round(values.reduce((sum, value) => sum + value, 0) / values.length);
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
