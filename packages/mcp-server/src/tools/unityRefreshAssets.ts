import { z } from "zod";
import { CompileStatus } from "@uvibe/core";
import { ToolDef } from "../registry.js";
import { BRIDGE_METHODS, bridgeCall } from "./_helpers.js";

const InputShape = {
  detailLevel: z.enum(["summary", "normal", "full"]).optional(),
};

export const unityRefreshAssets: ToolDef<typeof InputShape, CompileStatus> = {
  name: "unity_refresh_assets",
  description:
    "Forces a synchronous Unity AssetDatabase refresh so files changed outside the Editor are imported and any resulting script compilation starts before verification. Returns the observed compile status and does not modify source files.",
  requires: ["unity_bridge"],
  inputShape: InputShape,
  async run(args, ctx) {
    return bridgeCall<CompileStatus>(
      ctx.bridge,
      BRIDGE_METHODS.assetRefresh,
      {},
      args.detailLevel ?? "normal"
    );
  },
};
