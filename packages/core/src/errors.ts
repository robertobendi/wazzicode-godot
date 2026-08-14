export type ErrorCode =
  | "GODOT_NOT_CONNECTED"
  | "GODOT_RELOADING"
  | "PLAY_MODE_REQUIRED"
  | "TEST_RUNNER_NOT_CONFIGURED"
  | "UNSAVED_CHANGES"
  | "PROJECT_IDENTITY_MISMATCH"
  | "FEATURE_UNAVAILABLE"
  | "OBJECT_NOT_FOUND"
  | "NODE_NOT_FOUND"
  | "SCENE_NOT_OPEN"
  | "METHOD_NOT_FOUND"
  | "CLASS_NOT_FOUND"
  | "PROPERTY_NOT_FOUND"
  | "INVALID_NODE_TYPE"
  | "UNSUPPORTED_VALUE"
  | "CAPTURE_UNAVAILABLE"
  | "FILE_WRITE_FAILED"
  | "SCENE_SAVE_FAILED"
  | "INVALID_REQUEST"
  | "PROTOCOL_VERSION_MISMATCH"
  | "RESOURCE_NOT_FOUND"
  | "INVALID_ARGUMENT"
  | "SAFETY_MODE_BLOCKED"
  | "WRITE_REQUIRES_SNAPSHOT"
  | "PROJECT_BUSY"
  | "RUN_CHANGED"
  | "UNSUPPORTED_GODOT_VERSION"
  | "INTERNAL_ERROR"
  | "MOCK_MODE_ACTIVE"
  | "BRIDGE_TIMEOUT"
  | "MALFORMED_BRIDGE_RESPONSE"
  | "TOOL_NOT_IMPLEMENTED"
  | "PROJECT_NOT_FOUND"
  | "GIT_NOT_AVAILABLE";

export interface ErrorDetail {
  code: ErrorCode;
  message: string;
  recoverable: boolean;
  suggestedAction: string;
  details?: Record<string, unknown>;
}

const ERROR_META: Record<ErrorCode, Omit<ErrorDetail, "code" | "message" | "details"> & { defaultMessage: string }> = {
  GODOT_NOT_CONNECTED: { recoverable: true, suggestedAction: "Open the project in Godot with the Godot Vibe OS addon enabled, then run `gvibe doctor`.", defaultMessage: "The Godot bridge is not reachable." },
  GODOT_RELOADING: { recoverable: true, suggestedAction: "Wait for the editor addon to reload, then retry.", defaultMessage: "The Godot editor addon is reloading." },
  PLAY_MODE_REQUIRED: { recoverable: true, suggestedAction: "Run the project first with `godot_run_project`.", defaultMessage: "This operation requires the project to be running." },
  TEST_RUNNER_NOT_CONFIGURED: { recoverable: false, suggestedAction: "Install and configure a supported Godot test addon. Import/script validation is not a test suite.", defaultMessage: "No supported project test runner is configured." },
  UNSAVED_CHANGES: { recoverable: true, suggestedAction: "Save the edited scene or explicitly discard the changes.", defaultMessage: "The operation would discard unsaved scene changes." },
  PROJECT_IDENTITY_MISMATCH: { recoverable: true, suggestedAction: "Open the expected project or point GVIBE_PROJECT at the project served by the editor.", defaultMessage: "The connected Godot editor is serving a different project." },
  FEATURE_UNAVAILABLE: { recoverable: false, suggestedAction: "Check the tool result for the exact editor, renderer, or addon requirement.", defaultMessage: "This feature is unavailable in the current Godot configuration." },
  OBJECT_NOT_FOUND: { recoverable: true, suggestedAction: "Inspect the active scene tree and use an exact NodePath.", defaultMessage: "Node not found." },
  NODE_NOT_FOUND: { recoverable: true, suggestedAction: "Inspect the edited scene tree and use an exact NodePath relative to its root.", defaultMessage: "Node not found." },
  SCENE_NOT_OPEN: { recoverable: true, suggestedAction: "Open the target .tscn in Godot before editing it.", defaultMessage: "No editable scene is open." },
  METHOD_NOT_FOUND: { recoverable: false, suggestedAction: "Update the Godot addon and MCP server together.", defaultMessage: "Bridge method not found." },
  CLASS_NOT_FOUND: { recoverable: true, suggestedAction: "Use godot_reflect to find the exact ClassDB name.", defaultMessage: "Godot class not found." },
  PROPERTY_NOT_FOUND: { recoverable: true, suggestedAction: "Inspect the node or reflect its class to confirm the exact property name.", defaultMessage: "Godot property not found." },
  INVALID_NODE_TYPE: { recoverable: true, suggestedAction: "Choose an instantiable ClassDB type that inherits Node.", defaultMessage: "The requested type is not a Node." },
  UNSUPPORTED_VALUE: { recoverable: true, suggestedAction: "Use the tagged JSON-safe Variant shape described by the tool error.", defaultMessage: "The value cannot be converted to the target Godot Variant type." },
  CAPTURE_UNAVAILABLE: { recoverable: true, suggestedAction: "Run the editor with a display server and retry the matching viewport capture.", defaultMessage: "Editor viewport capture is unavailable." },
  FILE_WRITE_FAILED: { recoverable: true, suggestedAction: "Check the project path and filesystem permissions, then retry.", defaultMessage: "Godot could not write the requested file." },
  SCENE_SAVE_FAILED: { recoverable: true, suggestedAction: "Resolve the scene save error in Godot and retry with an explicit res:// path if the scene is new.", defaultMessage: "Godot could not save the scene." },
  INVALID_REQUEST: { recoverable: false, suggestedAction: "Update the MCP server and editor addon together.", defaultMessage: "The bridge request is malformed." },
  PROTOCOL_VERSION_MISMATCH: { recoverable: false, suggestedAction: "Update the MCP server and editor addon together.", defaultMessage: "Bridge protocol versions do not match." },
  RESOURCE_NOT_FOUND: { recoverable: true, suggestedAction: "Confirm the res:// path exists and has been imported.", defaultMessage: "Resource not found." },
  INVALID_ARGUMENT: { recoverable: true, suggestedAction: "Inspect the tool input schema and correct the argument.", defaultMessage: "Invalid argument." },
  SAFETY_MODE_BLOCKED: { recoverable: true, suggestedAction: "Adjust `.godot-vibe/config.json` only if the project owner intends to allow this write.", defaultMessage: "Operation blocked by safety mode." },
  WRITE_REQUIRES_SNAPSHOT: { recoverable: true, suggestedAction: "Enable autoSnapshot or commit pending work before retrying.", defaultMessage: "Write operation requires a snapshot." },
  PROJECT_BUSY: { recoverable: true, suggestedAction: "Wait for the active Godot Vibe write to finish, then retry.", defaultMessage: "Another process is writing to this project." },
  RUN_CHANGED: { recoverable: true, suggestedAction: "Inspect the current play state; the replacement run was intentionally left running.", defaultMessage: "The active game changed before the guarded operation completed." },
  UNSUPPORTED_GODOT_VERSION: { recoverable: false, suggestedAction: "Use the source-audited Godot 4.7.1 release.", defaultMessage: "Godot version is unsupported." },
  INTERNAL_ERROR: { recoverable: false, suggestedAction: "Inspect the details and Godot Output panel.", defaultMessage: "Internal error." },
  MOCK_MODE_ACTIVE: { recoverable: true, suggestedAction: "Disable GVIBE_MOCK to use the real bridge.", defaultMessage: "Running in mock mode." },
  BRIDGE_TIMEOUT: { recoverable: true, suggestedAction: "Check whether Godot is responsive and retry once.", defaultMessage: "Bridge request timed out." },
  MALFORMED_BRIDGE_RESPONSE: { recoverable: false, suggestedAction: "Inspect the Godot Output panel for addon errors.", defaultMessage: "Malformed bridge response." },
  TOOL_NOT_IMPLEMENTED: { recoverable: false, suggestedAction: "Use a supported Godot-native tool.", defaultMessage: "Tool not implemented." },
  PROJECT_NOT_FOUND: { recoverable: true, suggestedAction: "Point --project or GVIBE_PROJECT at a directory containing project.godot.", defaultMessage: "No Godot project found." },
  GIT_NOT_AVAILABLE: { recoverable: true, suggestedAction: "Install git or run from a git worktree.", defaultMessage: "git is unavailable." },
};

export function isErrorCode(value: string): value is ErrorCode {
  return Object.prototype.hasOwnProperty.call(ERROR_META, value);
}

export function makeError(code: ErrorCode, message?: string, details?: Record<string, unknown>): ErrorDetail {
  const meta = ERROR_META[code];
  return { code, message: message ?? meta.defaultMessage, recoverable: meta.recoverable, suggestedAction: meta.suggestedAction, ...(details === undefined ? {} : { details }) };
}

export class GVibeError extends Error {
  readonly detail: ErrorDetail;
  constructor(code: ErrorCode, message?: string, details?: Record<string, unknown>) {
    const detail = makeError(code, message, details);
    super(detail.message);
    this.name = "GVibeError";
    this.detail = detail;
  }
}
