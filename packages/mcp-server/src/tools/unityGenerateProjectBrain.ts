import { z } from "zod";
import { ToolDef } from "../registry.js";
import { ok, err, timed } from "./_helpers.js";
import { generateBrain, BrainGenerationResult } from "@uvibe/project-brain";

const InputShape = {
  write: z.boolean().optional().describe("If true (default), writes brain files to .unity-vibe/. If false, returns the brain data only."),
  detailLevel: z.enum(["summary", "normal", "full"]).optional(),
};

export const unityGenerateProjectBrain: ToolDef<typeof InputShape, BrainGenerationResult> = {
  name: "unity_generate_project_brain",
  description:
    "Rebuilds the maintained Unity project map from the filesystem: engine and package metadata, scenes, prefabs, scripts, declared types, modules, and source-backed relationships. Writes the canonical .unity-vibe/knowledge store plus compact compatibility summaries. Does not require Unity to be running. Source: project_brain.",
  requires: ["filesystem", "project_brain"],
  inputShape: InputShape,
  async run(args, ctx) {
    const detailLevel = args.detailLevel ?? "normal";
    try {
      const { result, durationMs } = await timed(() =>
        generateBrain({ projectPath: ctx.projectPath, write: args.write ?? true })
      );
      return ok(result, {
        source: "project_brain",
        durationMs,
        detailLevel,
        projectPath: ctx.projectPath,
      });
    } catch (e: unknown) {
      const m = e instanceof Error ? e.message : String(e);
      return err("INTERNAL_ERROR", `Brain generation failed: ${m}`, {
        source: "project_brain",
        detailLevel,
      });
    }
  },
};
