import { z } from "zod";
import { ToolDef } from "../registry.js";
import { BRIDGE_METHODS, bridgeCall } from "./_helpers.js";
import { SelectionInspectResult } from "@uvibe/core";

const InputShape = {
  detailLevel: z.enum(["summary", "normal", "full"]).optional(),
  includeFields: z.boolean().optional().describe("Include serialized inspector field values. Default true."),
};

export const unityInspectSelected: ToolDef<typeof InputShape, SelectionInspectResult> = {
  name: "unity_inspect_selected",
  description:
    "Inspects the currently selected GameObject in the Unity Editor. Returns name, path, tag, layer, transform, components, serialized inspector values, prefab info, and missing-script warnings. Use this when the user says 'this object', 'the selected one', 'why is this broken', etc.",
  requires: ["unity_bridge"],
  inputShape: InputShape,
  async run(args, ctx) {
    const detailLevel = args.detailLevel ?? "normal";
    return bridgeCall<SelectionInspectResult>(
      ctx.bridge,
      BRIDGE_METHODS.selectionInspect,
      {
        includeFields: args.includeFields ?? detailLevel !== "summary",
        detailLevel,
      },
      detailLevel
    );
  },
};
