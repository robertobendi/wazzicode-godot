import { z } from "zod";
import { ToolDef } from "../registry.js";
import { BRIDGE_METHODS, bridgeCall } from "./_helpers.js";
import { RuntimeFindResult, SelectionInspectResult } from "@uvibe/core";

const FindShape = {
  query: z.string().optional().describe("Case-insensitive substring match on GameObject name."),
  component: z.string().optional().describe("Only objects that have this component type (e.g. 'Rigidbody')."),
  includeInactive: z.boolean().optional(),
  limit: z.number().int().min(1).max(1000).optional(),
  detailLevel: z.enum(["summary", "normal", "full"]).optional(),
};

export const unityFindRuntimeObjects: ToolDef<typeof FindShape, RuntimeFindResult> = {
  name: "unity_find_runtime_objects",
  description:
    "Finds live GameObjects by name substring and/or component type. Works in edit mode against loaded scene objects, but is most useful in play mode where it sees runtime-spawned objects. Returns name, hierarchy path, instanceId, and component list for each match — feed an instanceId to unity_inspect_runtime_object for full state.",
  requires: ["unity_bridge"],
  inputShape: FindShape,
  async run(args, ctx) {
    return bridgeCall<RuntimeFindResult>(
      ctx.bridge,
      BRIDGE_METHODS.runtimeFindObjects,
      {
        query: args.query,
        component: args.component,
        includeInactive: args.includeInactive ?? false,
        limit: args.limit ?? 100,
      },
      args.detailLevel ?? "normal"
    );
  },
};

const InspectShape = {
  instanceId: z.number().int().optional(),
  path: z.string().optional(),
  includeFields: z.boolean().optional(),
  detailLevel: z.enum(["summary", "normal", "full"]).optional(),
};

export const unityInspectRuntimeObject: ToolDef<typeof InspectShape, SelectionInspectResult> = {
  name: "unity_inspect_runtime_object",
  description:
    "Inspects a single live object's current state (components and serialized field values) by instanceId (from unity_find_runtime_objects) or hierarchy path. In play mode this shows the actual runtime values, not the edit-time defaults.",
  requires: ["unity_bridge"],
  inputShape: InspectShape,
  async run(args, ctx) {
    return bridgeCall<SelectionInspectResult>(
      ctx.bridge,
      BRIDGE_METHODS.runtimeInspect,
      {
        instanceId: args.instanceId ?? 0,
        path: args.path,
        includeFields: args.includeFields ?? true,
      },
      args.detailLevel ?? "normal"
    );
  },
};
