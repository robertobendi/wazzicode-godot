import { z } from "zod";
import { ToolDef } from "../registry.js";
import { BRIDGE_METHODS, bridgeCall } from "./_helpers.js";
import { EditResult } from "@uvibe/core";

/**
 * Prefab-mode editing. unity_open_prefab enters isolation/prefab mode (non-write navigation);
 * once inside, the existing scene-edit tools (set_serialized_field, set_transform, add_component,
 * reparent, …) operate on the prefab contents, and unity_save_prefab persists them back to the
 * asset. unity_apply_prefab_instance pushes a scene instance's overrides up to its source prefab.
 */

const OpenPrefabShape = {
  prefabPath: z.string().optional().describe("Prefab asset path, e.g. 'Assets/Prefabs/Enemy.prefab'."),
  prefabGuid: z.string().optional().describe("Prefab by GUID (alternative to prefabPath)."),
};

export const unityOpenPrefab: ToolDef<typeof OpenPrefabShape, unknown> = {
  name: "unity_open_prefab",
  description:
    "Opens a prefab asset in prefab (isolation) mode so the scene-edit tools operate on the prefab's own contents instead of a scene instance. Then edit with unity_set_serialized_field / unity_set_transform / unity_add_component / etc. and persist with unity_save_prefab. Not gated — opening is navigation.",
  requires: ["unity_bridge"],
  inputShape: OpenPrefabShape,
  async run(args, ctx) {
    return bridgeCall(ctx.bridge, BRIDGE_METHODS.prefabOpen, {
      prefabPath: args.prefabPath,
      prefabGuid: args.prefabGuid,
    });
  },
};

const SavePrefabShape = {
  closeAfter: z
    .boolean()
    .optional()
    .describe("Exit prefab mode (return to the previous stage) after saving. Default false."),
};

export const unitySavePrefab: ToolDef<typeof SavePrefabShape, EditResult> = {
  name: "unity_save_prefab",
  description:
    "Saves the currently open prefab stage back to its asset (the things your game is built from). Returns OBJECT_NOT_FOUND if no prefab is open — call unity_open_prefab first. Gated by safetyMode (confirm/autopilot + allowPrefabWrites).",
  requires: ["unity_bridge"],
  write: true,
  writeTarget: "prefab",
  inputShape: SavePrefabShape,
  async run(args, ctx) {
    return bridgeCall<EditResult>(ctx.bridge, BRIDGE_METHODS.prefabSave, {
      closeAfter: args.closeAfter ?? false,
    });
  },
};

const ApplyInstanceShape = {
  instanceId: z.number().int().optional().describe("Prefab-instance GameObject by instanceId."),
  path: z.string().optional().describe("Prefab-instance by hierarchy path (or current selection)."),
};

export const unityApplyPrefabInstance: ToolDef<typeof ApplyInstanceShape, EditResult> = {
  name: "unity_apply_prefab_instance",
  description:
    "Applies all overrides on a scene prefab-instance back up to its source prefab asset (PrefabUtility.ApplyPrefabInstance). Returns INVALID_ARGUMENT if the target isn't a prefab instance. Gated by safetyMode (confirm/autopilot + allowPrefabWrites).",
  requires: ["unity_bridge"],
  write: true,
  writeTarget: "prefab",
  inputShape: ApplyInstanceShape,
  async run(args, ctx) {
    return bridgeCall<EditResult>(ctx.bridge, BRIDGE_METHODS.prefabApplyInstance, {
      instanceId: args.instanceId ?? 0,
      path: args.path,
    });
  },
};
