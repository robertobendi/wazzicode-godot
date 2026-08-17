import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BRIDGE_METHODS, type BridgeMethod } from "@gvibe/core";
import { buildContext, type ToolContext } from "@gvibe/mcp-server";
import { godotCaptureFrames, type CaptureFramesResult } from "../packages/mcp-server/src/tools/godotCaptureFrames.js";

const temporaryProjects: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryProjects.splice(0).map((project) => rm(project, { recursive: true, force: true })));
});

async function project(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "gvibe-frames-test-"));
  temporaryProjects.push(root);
  return root;
}

/** A mock context whose game is already running, so frame capture has something to observe. */
async function playingContext() {
  const ctx = buildContext({ mock: true, projectPath: await project() });
  await ctx.bridge.call(BRIDGE_METHODS.playRun, { mode: "main" });
  return ctx;
}

async function capture(ctx: ToolContext, args: Parameters<typeof godotCaptureFrames.run>[0]) {
  const envelope = await godotCaptureFrames.run(args, ctx);
  expect(envelope.ok, JSON.stringify(envelope)).toBe(true);
  if (!envelope.ok) throw new Error("unreachable");
  return envelope;
}

describe("godot_capture_frames", () => {
  it("returns every captured frame in capture order with labelled offsets", async () => {
    const ctx = await playingContext();
    const envelope = await capture(ctx, { returnImages: "all", save: false });
    const data: CaptureFramesResult = envelope.data;

    expect(data.requested).toEqual({ frames: 8, intervalMs: 400, width: 480, format: "jpg", quality: 70, returnImages: "all", save: false });
    expect(data.actual).toEqual({ frames: 8, avgIntervalMs: 400, droppedFrames: 0, avgFrameTimeImpactMs: 3.5 });
    expect(data.dedup).toEqual({ captured: 8, returned: 8, skippedUnchanged: 0 });
    expect(data.savedPaths).toEqual([]);
    expect(data.frames.map((frame) => frame.index)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(data.frames.map((frame) => frame.label)).toEqual([
      "Frame 1/8 — t=+0ms",
      "Frame 2/8 — t=+400ms",
      "Frame 3/8 — t=+800ms",
      "Frame 4/8 — t=+1200ms",
      "Frame 5/8 — t=+1600ms",
      "Frame 6/8 — t=+2000ms",
      "Frame 7/8 — t=+2400ms",
      "Frame 8/8 — t=+2800ms",
    ]);
    for (const frame of data.frames) {
      expect(frame.returned).toBe(true);
      const bytes = Buffer.from(frame.base64 ?? "", "base64");
      expect([...bytes.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
      expect(frame.hash).toMatch(/^[0-9a-f]{16}$/);
    }
  });

  it("keeps the first frame and only visibly different frames under the changed policy", async () => {
    const ctx = await playingContext();
    const envelope = await capture(ctx, { returnImages: "changed", save: false });
    const data: CaptureFramesResult = envelope.data;

    expect(data.dedup).toEqual({ captured: 8, returned: 4, skippedUnchanged: 4 });
    expect(data.frames.filter((frame) => frame.returned).map((frame) => frame.index)).toEqual([1, 3, 5, 7]);
    for (const frame of data.frames) {
      expect(typeof frame.base64 === "string", `frame ${frame.index}`).toBe(frame.returned);
      // Every captured frame keeps its measurements even when its image is withheld.
      expect(frame.bytes).toBeGreaterThan(0);
      expect(frame.hash).toMatch(/^[0-9a-f]{16}$/);
    }
  });

  it("returns measurements without images under the none policy", async () => {
    const ctx = await playingContext();
    const envelope = await capture(ctx, { returnImages: "none", save: false });
    const data: CaptureFramesResult = envelope.data;

    expect(data.dedup).toEqual({ captured: 8, returned: 0, skippedUnchanged: 0 });
    expect(data.frames).toHaveLength(8);
    expect(data.frames.every((frame) => frame.returned === false)).toBe(true);
    expect(data.frames.every((frame) => frame.base64 === undefined)).toBe(true);
    expect(data.actual.frames).toBe(8);
  });

  it("pages a bounded sequence across several bridge calls without duplicating frames", async () => {
    const ctx = await playingContext();
    const calls: Array<{ method: BridgeMethod; params: Record<string, unknown> }> = [];
    const original = ctx.bridge.call.bind(ctx.bridge);
    ctx.bridge.call = async <T>(method: BridgeMethod, params: Record<string, unknown> = {}) => {
      calls.push({ method, params });
      return original<T>(method, params);
    };

    const envelope = await capture(ctx, { frames: 8, returnImages: "all", save: false });

    const captureCalls = calls.filter((call) => call.method === BRIDGE_METHODS.debugCaptureFrames);
    expect(captureCalls.length).toBeGreaterThan(1);
    expect(captureCalls[0].params).not.toHaveProperty("captureId");
    expect(captureCalls.slice(1).every((call) => call.params.captureId === "mock-frames-1")).toBe(true);
    expect(captureCalls.map((call) => call.params.sinceIndex)).toEqual([undefined, 4]);
    expect(envelope.data.frames.map((frame) => frame.index)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it("honours frame, interval, width, and format bounds in the request it sends", async () => {
    const ctx = await playingContext();
    const captureParams: Record<string, unknown>[] = [];
    const original = ctx.bridge.call.bind(ctx.bridge);
    ctx.bridge.call = async <T>(method: BridgeMethod, params: Record<string, unknown> = {}) => {
      if (method === BRIDGE_METHODS.debugCaptureFrames) captureParams.push(params);
      return original<T>(method, params);
    };

    const envelope = await capture(ctx, { frames: 2, intervalMs: 100, width: 160, format: "png", quality: 100, returnImages: "none", save: false });

    expect(captureParams[0]).toMatchObject({ frames: 2, intervalMs: 100, width: 160, format: "png", quality: 100 });
    expect(envelope.data.requested).toMatchObject({ frames: 2, intervalMs: 100, width: 160, format: "png", quality: 100 });
    expect(envelope.data.actual.frames).toBe(2);
  });

  it("writes each captured frame into the managed Godot capture cache when save is on", async () => {
    const root = await project();
    const ctx = buildContext({ mock: true, projectPath: root });
    await ctx.bridge.call(BRIDGE_METHODS.playRun, { mode: "main" });

    const envelope = await capture(ctx, { frames: 2, returnImages: "changed", save: true });

    expect(envelope.data.savedPaths).toEqual([
      "res://.godot/godot-vibe-os/captures/mock-frames-1-01.png",
      "res://.godot/godot-vibe-os/captures/mock-frames-1-02.png",
    ]);
    const directory = path.join(root, ".godot", "godot-vibe-os", "captures");
    expect((await readdir(directory)).sort()).toEqual(["mock-frames-1-01.png", "mock-frames-1-02.png"]);
    const written = await readFile(path.join(directory, "mock-frames-1-01.png"));
    expect([...written.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
    // A withheld image is still saved, so on-disk evidence is never a partial record of the run.
    expect(envelope.data.frames.map((frame) => frame.savedPath)).toEqual(envelope.data.savedPaths);
  });

  it("refuses honestly instead of fabricating frames when no game is running", async () => {
    const ctx = buildContext({ mock: true, projectPath: await project() });
    const envelope = await godotCaptureFrames.run({ save: false }, ctx);

    expect(envelope.ok).toBe(false);
    if (!envelope.ok) {
      expect(envelope.error.code).toBe("PLAY_MODE_REQUIRED");
      expect(envelope.error.message).toContain("runtime probe is not connected");
    }
  });

  it("reports a runtime capture failure as CAPTURE_UNAVAILABLE rather than an empty success", async () => {
    const ctx = await playingContext();
    const original = ctx.bridge.call.bind(ctx.bridge);
    ctx.bridge.call = async <T>(method: BridgeMethod, params: Record<string, unknown> = {}) => {
      if (method !== BRIDGE_METHODS.debugCaptureFrames) return original<T>(method, params);
      return {
        id: "frames", ok: true, error: null,
        meta: { godotVersion: "4.7.1.mock", projectPath: "/mock/godot", durationMs: 1 },
        result: {
          captureId: "", state: "error", runId: "mock-run-1",
          requested: { frames: 8, intervalMs: 400, width: 480, format: "jpg", quality: 70 },
          capturedCount: 0, frameCursor: 0, frames: [], droppedFrames: 0,
          error: "Runtime frame capture requires a display server.",
        } as T,
      };
    };

    const envelope = await godotCaptureFrames.run({ save: false }, ctx);

    expect(envelope.ok).toBe(false);
    if (!envelope.ok) {
      expect(envelope.error.code).toBe("CAPTURE_UNAVAILABLE");
      expect(envelope.error.message).toBe("Runtime frame capture requires a display server.");
    }
  });

  it("emits one progress notification per collected frame when the client asked for progress", async () => {
    const ctx = await playingContext();
    const updates: Array<{ progress: number; total?: number; message?: string }> = [];
    const progressCtx: ToolContext = { ...ctx, progress: (update) => updates.push(update) };

    await capture(progressCtx, { returnImages: "none", save: false });

    expect(updates[0]).toMatchObject({ progress: 0, total: 8, message: expect.stringContaining("Requesting 8 frames") });
    expect(updates.at(-1)).toMatchObject({ progress: 8, total: 8, message: "Captured frame 8/8" });
    expect(updates.every((update) => update.total === 8)).toBe(true);
  });
});
