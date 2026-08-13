// Thin re-export layer: bridgeCall/isUnknownMethodError moved to @uvibe/bridge-client so
// external apps (e.g. the desktop app) can drive the Unity bridge without the MCP SDK.
// Tool files keep importing from "./_helpers.js" — do not add logic here.
export { bridgeCall, isUnknownMethodError, probeEditorStall } from "@uvibe/bridge-client";
export { BRIDGE_METHODS, ok, err, timed } from "@uvibe/core";
