import { z } from "zod";
import { ToolDef } from "../registry.js";
import { BRIDGE_METHODS, bridgeCall } from "./_helpers.js";
import { OpenScenesResult } from "@uvibe/core";

const InputShape = {
  detailLevel: z.enum(["summary", "normal", "full"]).optional(),
};

export const unityGetOpenScenes: ToolDef<typeof InputShape, OpenScenesResult> = {
  name: "unity_get_open_scenes",
  description:
    "Returns all currently loaded scenes in the Unity Editor with their path, name, dirty/loaded flags, root object count, and build index. Use this to discover which scenes are active before calling unity_get_scene_hierarchy.",
  requires: ["unity_bridge"],
  inputShape: InputShape,
  async run(args, ctx) {
    return bridgeCall<OpenScenesResult>(
      ctx.bridge,
      BRIDGE_METHODS.sceneGetOpenScenes,
      {},
      args.detailLevel ?? "normal"
    );
  },
};
