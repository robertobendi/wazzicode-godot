import { z } from "zod";
import { ToolDef } from "../registry.js";
import { BRIDGE_METHODS, bridgeCall } from "./_helpers.js";

/**
 * Play-mode input simulation so Claude can actually play-test: press keys, click, move axes and
 * confirm the resulting behaviour. Requires play mode (PLAY_MODE_REQUIRED otherwise). The Unity
 * side targets the Input System package reflectively (so the bridge compiles without it) by
 * queueing events on the virtual devices; it reports FEATURE_UNAVAILABLE if no usable backend is
 * present. Not a write tool — it mutates only ephemeral runtime input state.
 */

const SimulateInputShape = {
  control: z
    .string()
    .describe(
      "Input control path, e.g. '<Keyboard>/space', '<Mouse>/leftButton', '<Gamepad>/buttonSouth', or a leftStick axis '<Gamepad>/leftStick/x'. A bare key name like 'space' is treated as '<Keyboard>/space'."
    ),
  action: z
    .enum(["press", "down", "up"])
    .optional()
    .describe("press = down then up (a tap); down = hold; up = release. Default 'press'."),
  value: z
    .number()
    .optional()
    .describe("Analog value to write (0..1 for buttons, -1..1 for axes). Defaults to 1 for down/press, 0 for up."),
};

export const unitySimulateInput: ToolDef<typeof SimulateInputShape, unknown> = {
  name: "unity_simulate_input",
  description:
    "Simulates an input event in play mode (key/button press, mouse click, or axis value) by queueing it on the Input System's virtual devices, so Claude can fire the gun, navigate menus and confirm gameplay flow. Requires play mode (unity_enter_play_mode first). Reports FEATURE_UNAVAILABLE if the Input System package isn't present.",
  requires: ["unity_bridge"],
  inputShape: SimulateInputShape,
  async run(args, ctx) {
    return bridgeCall(ctx.bridge, BRIDGE_METHODS.inputSimulate, {
      control: args.control,
      action: args.action ?? "press",
      value: args.value,
    });
  },
};
