import { z } from "zod";
import { ToolDef } from "../registry.js";
import { BRIDGE_METHODS, bridgeCall } from "./_helpers.js";
import { EditResult } from "@uvibe/core";

/**
 * Layout/positioning writes on scene GameObjects. Undo-wrapped on the Unity side and gated by
 * safetyMode (scene target). This is the real "move/rotate/scale/reparent" work that turns
 * inspection into actual level/layout editing.
 */

const Vec3 = z.object({ x: z.number(), y: z.number(), z: z.number() });

const SetTransformShape = {
  instanceId: z.number().int().optional().describe("Target GameObject by instanceId (preferred)."),
  path: z.string().optional().describe("Target by hierarchy path; falls back to current selection if neither given."),
  position: Vec3.optional().describe("New position {x,y,z}. Omit to leave unchanged."),
  rotation: Vec3.optional().describe("New rotation as Euler angles in degrees {x,y,z}. Omit to leave unchanged."),
  scale: Vec3.optional().describe("New local scale {x,y,z}. Omit to leave unchanged. (Scale is always local.)"),
  space: z
    .enum(["local", "world"])
    .optional()
    .describe("Interpret position/rotation in local or world space. Default 'local'."),
};

export const unitySetTransform: ToolDef<typeof SetTransformShape, EditResult> = {
  name: "unity_set_transform",
  description:
    "Sets a scene GameObject's position, rotation (Euler degrees) and/or local scale, in local or world space. Only the provided fields change. Undo-wrapped; gated by safetyMode (confirm/autopilot + allowSceneWrites). Marks the scene dirty.",
  requires: ["unity_bridge"],
  write: true,
  writeTarget: "scene",
  inputShape: SetTransformShape,
  async run(args, ctx) {
    return bridgeCall<EditResult>(ctx.bridge, BRIDGE_METHODS.editSetTransform, {
      instanceId: args.instanceId ?? 0,
      path: args.path,
      position: args.position,
      rotation: args.rotation,
      scale: args.scale,
      space: args.space ?? "local",
    });
  },
};

const ReparentShape = {
  instanceId: z.number().int().optional().describe("Child GameObject to move, by instanceId."),
  path: z.string().optional().describe("Child by hierarchy path (or current selection)."),
  newParentInstanceId: z.number().int().optional().describe("New parent by instanceId."),
  newParentPath: z
    .string()
    .optional()
    .describe("New parent by hierarchy path. Omit both parent fields to move the object to the scene root."),
  worldPositionStays: z
    .boolean()
    .optional()
    .describe("Keep the child's world position/rotation/scale when reparenting. Default true."),
  siblingIndex: z.number().int().optional().describe("Optional index among the new parent's children."),
};

export const unityReparent: ToolDef<typeof ReparentShape, EditResult> = {
  name: "unity_reparent",
  description:
    "Reparents a scene GameObject under a new parent (or to the scene root when no parent is given), optionally preserving world transform and setting a sibling index. Undo-wrapped; gated by safetyMode (confirm/autopilot + allowSceneWrites).",
  requires: ["unity_bridge"],
  write: true,
  writeTarget: "scene",
  inputShape: ReparentShape,
  async run(args, ctx) {
    return bridgeCall<EditResult>(ctx.bridge, BRIDGE_METHODS.editReparent, {
      instanceId: args.instanceId ?? 0,
      path: args.path,
      newParentInstanceId: args.newParentInstanceId ?? 0,
      newParentPath: args.newParentPath,
      worldPositionStays: args.worldPositionStays ?? true,
      siblingIndex: args.siblingIndex,
    });
  },
};
