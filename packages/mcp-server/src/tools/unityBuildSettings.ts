import { z } from "zod";
import { BuildSettingsResult } from "@uvibe/core";
import { ToolDef } from "../registry.js";
import { BRIDGE_METHODS, bridgeCall } from "./_helpers.js";

const InputShape = {
  detailLevel: z.enum(["summary", "normal", "full"]).optional(),
};

export const unityGetBuildSettings: ToolDef<typeof InputShape, BuildSettingsResult> = {
  name: "unity_get_build_settings",
  description:
    "Checks whether the current Unity player build configuration is ready: active target and target support, Development Build state, enabled scene count, missing scene assets, and a single valid/issues verdict. Read-only; it does not start a build or change settings.",
  requires: ["unity_bridge"],
  inputShape: InputShape,
  async run(args, ctx) {
    return bridgeCall<BuildSettingsResult>(
      ctx.bridge,
      BRIDGE_METHODS.buildGetSettings,
      {},
      args.detailLevel ?? "normal"
    );
  },
};
