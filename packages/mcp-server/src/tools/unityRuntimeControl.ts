import { z } from "zod";
import { PlayModeStatus, RuntimeMutationResult } from "@uvibe/core";
import { ToolDef } from "../registry.js";
import { BRIDGE_METHODS, bridgeCall } from "./_helpers.js";

const ConfigureShape = {
  isPaused: z.boolean().optional().describe("Pause or resume the running game."),
  timeScale: z.number().min(0).max(100).optional().describe("Set UnityEngine.Time.timeScale."),
};

export const unityConfigurePlayMode: ToolDef<typeof ConfigureShape, PlayModeStatus> = {
  name: "unity_configure_play_mode",
  description:
    "Pauses/resumes a running game and changes Time.timeScale without editing project assets. Returns the observed play-mode status and effective time scale. Requires play mode.",
  requires: ["unity_bridge"],
  inputShape: ConfigureShape,
  async run(args, ctx) {
    return bridgeCall<PlayModeStatus>(ctx.bridge, BRIDGE_METHODS.playModeConfigure, {
      isPaused: args.isPaused,
      timeScale: args.timeScale,
    });
  },
};

const SetFieldShape = {
  instanceId: z.number().int().optional(),
  path: z.string().optional(),
  component: z.string().min(1).describe("Component type name or full name."),
  field: z.string().min(1).describe("Serialized field/property path, including nested paths."),
  value: z.unknown().describe("Temporary runtime value using the same JSON forms as unity_set_serialized_field."),
};

export const unitySetRuntimeField: ToolDef<typeof SetFieldShape, RuntimeMutationResult> = {
  name: "unity_set_runtime_field",
  description:
    "Temporarily overrides a serialized component field on a live GameObject by instanceId or hierarchy path. Requires play mode, creates no Undo entry, and is discarded when play mode exits. Inspect the object first to confirm the exact component and field names.",
  requires: ["unity_bridge"],
  inputShape: SetFieldShape,
  async run(args, ctx) {
    return bridgeCall<RuntimeMutationResult>(ctx.bridge, BRIDGE_METHODS.runtimeSetField, {
      instanceId: args.instanceId ?? 0,
      path: args.path,
      component: args.component,
      field: args.field,
      value: args.value,
    });
  },
};
