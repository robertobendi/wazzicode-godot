import { z } from "zod";
import { ToolDef } from "../registry.js";
import { BRIDGE_METHODS, bridgeCall } from "./_helpers.js";
import { EditResult } from "@uvibe/core";

/**
 * Animator tools — read live/asset state, drive parameters at runtime, and edit transitions in
 * the AnimatorController asset. get_state and set_parameter are runtime/ephemeral (not gated);
 * edit_transition mutates the controller asset and is gated (asset target).
 */

const GetStateShape = {
  instanceId: z.number().int().optional().describe("GameObject with an Animator, by instanceId."),
  path: z.string().optional().describe("GameObject by hierarchy path (or current selection)."),
  layer: z.number().int().optional().describe("Limit runtime state to a single animator layer index."),
};

export const unityGetAnimatorState: ToolDef<typeof GetStateShape, unknown> = {
  name: "unity_get_animator_state",
  description:
    "Reports an Animator's state. In play mode: per-layer current state, normalized time, speed, active clips, and parameter values. In edit mode: the AnimatorController graph — layers, states, parameters and transitions (with conditions). Use this before unity_animator_edit_transition to find exact state names.",
  requires: ["unity_bridge"],
  inputShape: GetStateShape,
  async run(args, ctx) {
    return bridgeCall(ctx.bridge, BRIDGE_METHODS.animatorGetState, {
      instanceId: args.instanceId ?? 0,
      path: args.path,
      layer: args.layer,
    });
  },
};

const SetParamShape = {
  instanceId: z.number().int().optional().describe("GameObject with an Animator, by instanceId."),
  path: z.string().optional().describe("GameObject by hierarchy path (or current selection)."),
  name: z.string().describe("Animator parameter name."),
  value: z
    .union([z.boolean(), z.number()])
    .optional()
    .describe("Value to set: boolean for Bool, number for Float/Int. Omit to fire a Trigger."),
  resetTrigger: z.boolean().optional().describe("If true (with no value), ResetTrigger instead of SetTrigger."),
};

export const unitySetAnimatorParameter: ToolDef<typeof SetParamShape, unknown> = {
  name: "unity_set_animator_parameter",
  description:
    "Sets an Animator parameter at runtime (Bool/Float/Int) or fires/resets a Trigger — the quickest way to drive the Crow/fish animation and watch the result. Requires play mode (PLAY_MODE_REQUIRED otherwise). The parameter type is detected automatically; mismatches return INVALID_ARGUMENT.",
  requires: ["unity_bridge"],
  inputShape: SetParamShape,
  async run(args, ctx) {
    return bridgeCall(ctx.bridge, BRIDGE_METHODS.animatorSetParameter, {
      instanceId: args.instanceId ?? 0,
      path: args.path,
      name: args.name,
      value: args.value,
      resetTrigger: args.resetTrigger ?? false,
    });
  },
};

const ConditionShape = z.object({
  parameter: z.string().describe("Parameter the condition tests."),
  mode: z
    .enum(["If", "IfNot", "Greater", "Less", "Equals", "NotEqual"])
    .describe("Condition mode (If/IfNot for bools/triggers; Greater/Less/Equals/NotEqual for numbers)."),
  threshold: z.number().optional().describe("Threshold for numeric modes. Ignored for If/IfNot."),
});

const EditTransitionShape = {
  controllerPath: z.string().optional().describe("AnimatorController asset path, e.g. 'Assets/Animation/Crow.controller'."),
  controllerGuid: z.string().optional().describe("Controller by GUID (alternative to controllerPath)."),
  fromState: z
    .string()
    .optional()
    .describe("Source state name. Omit and set fromAnyState:true for an Any-State transition."),
  fromAnyState: z.boolean().optional().describe("Edit the Any-State transition to toState instead of a state-to-state one."),
  toState: z.string().describe("Destination state name."),
  layer: z.number().int().optional().describe("Layer index that owns the states. Default 0."),
  create: z.boolean().optional().describe("Create the transition if it doesn't exist yet. Default false."),
  hasExitTime: z.boolean().optional().describe("Set hasExitTime."),
  exitTime: z.number().optional().describe("Set exitTime (normalized)."),
  duration: z.number().optional().describe("Set transitionDuration (seconds, or fraction if fixedDuration=false)."),
  offset: z.number().optional().describe("Set transition offset (normalized)."),
  conditions: z
    .array(ConditionShape)
    .optional()
    .describe("Replace the transition's conditions with this list."),
};

export const unityAnimatorEditTransition: ToolDef<typeof EditTransitionShape, EditResult> = {
  name: "unity_animator_edit_transition",
  description:
    "Edits (or creates) a transition between two AnimatorController states: hasExitTime, exitTime, duration, offset and the condition list. Saves the controller asset. Gated by safetyMode (confirm/autopilot; asset target). Use unity_get_animator_state first to confirm exact state/parameter names.",
  requires: ["unity_bridge"],
  write: true,
  writeTarget: "asset",
  inputShape: EditTransitionShape,
  async run(args, ctx) {
    return bridgeCall<EditResult>(ctx.bridge, BRIDGE_METHODS.animatorEditTransition, { ...args });
  },
};
