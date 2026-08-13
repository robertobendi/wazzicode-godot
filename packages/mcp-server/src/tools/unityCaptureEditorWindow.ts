import { z } from "zod";
import { ToolDef } from "../registry.js";
import { BRIDGE_METHODS, ScreenshotResult, err } from "@uvibe/core";
import { screenshotCall } from "./_screenshot.js";

export function isEditorWindowCaptureSupported(platform: NodeJS.Platform): boolean {
  return platform !== "darwin";
}

const InputShape = {
  maxWidth: z
    .number()
    .int()
    .min(64)
    .max(7680)
    .optional()
    .describe(
      "If set, downscale so the window's longest side is at most this many pixels (preserves aspect). Omit/0 to capture at native resolution."
    ),
  save: z.boolean().optional().describe("If true (default), persist PNG to .unity-vibe/screenshots/."),
};

export const unityCaptureEditorWindow: ToolDef<typeof InputShape, ScreenshotResult> = {
  name: "unity_capture_editor_window",
  description:
    "Captures the whole Unity Editor main window as a PNG by reading the OS framebuffer. Disabled on macOS because Unity's framebuffer API can terminate the Editor; use unity_capture_scene_view or unity_capture_game_view there. Auto-saves to .unity-vibe/screenshots/ unless save=false.",
  requires: ["unity_bridge"],
  inputShape: InputShape,
  async run(args, ctx) {
    if (!isEditorWindowCaptureSupported(process.platform)) {
      return err(
        "FEATURE_UNAVAILABLE",
        "Whole-editor capture is disabled on macOS because Unity's framebuffer API can terminate the Editor. Use unity_capture_scene_view or unity_capture_game_view instead.",
        { source: ctx.bridge.source }
      );
    }
    return screenshotCall(
      ctx.bridge,
      BRIDGE_METHODS.screenshotEditorWindow,
      {
        maxWidth: args.maxWidth ?? 0,
      },
      ctx.projectPath,
      { save: args.save ?? true }
    );
  },
};
