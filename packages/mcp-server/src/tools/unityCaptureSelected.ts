import { z } from "zod";
import { ToolDef } from "../registry.js";
import { BRIDGE_METHODS, ScreenshotResult } from "@uvibe/core";
import { screenshotCall } from "./_screenshot.js";

const InputShape = {
  width: z.number().int().min(64).max(2048).optional(),
  height: z.number().int().min(64).max(2048).optional(),
  paddingFactor: z
    .number()
    .min(1)
    .max(8)
    .optional()
    .describe("Distance multiplier from the object's bounds. Larger = more zoomed out. Default 3.5."),
  save: z.boolean().optional(),
  format: z
    .enum(["png", "jpg"])
    .optional()
    .describe("Image encoding. jpg is ~10x smaller. Default png."),
  quality: z.number().int().min(1).max(100).optional().describe("JPEG quality (default 80; ignored for png)."),
};

export const unityCaptureSelected: ToolDef<typeof InputShape, ScreenshotResult> = {
  name: "unity_capture_selected",
  description:
    "Captures the currently selected GameObject from a 3/4 angle by spawning a temporary camera framed around its bounds. Falls back to the AssetPreview cache when the selection is a prefab asset. Returns OBJECT_NOT_FOUND if nothing is selected.",
  requires: ["unity_bridge"],
  inputShape: InputShape,
  async run(args, ctx) {
    return screenshotCall(
      ctx.bridge,
      BRIDGE_METHODS.screenshotSelected,
      {
        width: args.width ?? 768,
        height: args.height ?? 768,
        paddingFactor: args.paddingFactor ?? 3.5,
        format: args.format ?? "png",
        quality: args.quality ?? 80,
      },
      ctx.projectPath,
      { save: args.save ?? true }
    );
  },
};
