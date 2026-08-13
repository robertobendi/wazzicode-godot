import { z } from "zod";
import { ToolDef } from "../registry.js";
import { BRIDGE_METHODS, bridgeCall } from "./_helpers.js";
import { ProjectSummary } from "@uvibe/core";

const InputShape = {
  detailLevel: z.enum(["summary", "normal", "full"]).optional(),
};

export const unityProjectSummary: ToolDef<typeof InputShape, ProjectSummary> = {
  name: "unity_project_summary",
  description:
    "Returns Unity project metadata: Unity version, render pipeline, input system, build target, packages, product/company name. Source: unity_bridge.",
  requires: ["unity_bridge"],
  inputShape: InputShape,
  async run(args, ctx) {
    return bridgeCall<ProjectSummary>(
      ctx.bridge,
      BRIDGE_METHODS.systemSummary,
      {},
      args.detailLevel ?? "normal"
    );
  },
};
