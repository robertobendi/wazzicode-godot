import { z } from "zod";
import { ToolDef } from "../registry.js";
import { BRIDGE_METHODS, bridgeCall } from "./_helpers.js";
import { SceneHierarchy } from "@uvibe/core";

const InputShape = {
  scenePath: z.string().optional().describe("Path of a loaded scene (e.g. Assets/Scenes/Main.unity). Defaults to the active scene."),
  detailLevel: z.enum(["summary", "normal", "full"]).optional(),
  maxDepth: z.number().int().min(1).max(64).optional(),
  includeComponents: z.boolean().optional(),
  maxNodes: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe("Cap on total nodes returned (default 5000) so large scenes don't blow context. The result sets truncated:true when hit; narrow with scenePath/maxDepth or pass 0 to disable."),
};

export const unityGetSceneHierarchy: ToolDef<typeof InputShape, SceneHierarchy> = {
  name: "unity_get_scene_hierarchy",
  description:
    "Returns the GameObject hierarchy of a Unity scene. Each node includes name, path, active state, child count, and (optionally) component types. Use detailLevel=summary for a flat root list, normal for the standard tree, full for component lists on every node. Capped at maxNodes (default 5000) — the response flags truncated:true and childrenOmitted on depth-clipped nodes.",
  requires: ["unity_bridge"],
  inputShape: InputShape,
  async run(args, ctx) {
    const detailLevel = args.detailLevel ?? "normal";
    return bridgeCall<SceneHierarchy>(
      ctx.bridge,
      BRIDGE_METHODS.sceneGetHierarchy,
      {
        scenePath: args.scenePath,
        maxDepth: args.maxDepth ?? (detailLevel === "summary" ? 1 : 32),
        includeComponents: args.includeComponents ?? detailLevel !== "summary",
        maxNodes: args.maxNodes ?? 5000,
      },
      detailLevel
    );
  },
};
