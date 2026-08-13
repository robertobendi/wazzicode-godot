/**
 * Stable error codes used across the bridge protocol and the MCP tool envelope.
 * Codes are stable identifiers; do not rename without bumping protocol version.
 */
export type ErrorCode =
  | "UNITY_NOT_CONNECTED"
  | "UNITY_COMPILING"
  | "UNITY_RELOADING"
  | "UNITY_EDITOR_STALLED"
  | "TEST_FRAMEWORK_MISSING"
  | "PLAY_MODE_REQUIRED"
  | "UNSAVED_CHANGES"
  | "MENU_ITEM_NOT_ALLOWED"
  | "PROJECT_IDENTITY_MISMATCH"
  | "FEATURE_UNAVAILABLE"
  | "OBJECT_NOT_FOUND"
  | "ASSET_NOT_FOUND"
  | "INVALID_ARGUMENT"
  | "SAFETY_MODE_BLOCKED"
  | "WRITE_REQUIRES_SNAPSHOT"
  | "UNSUPPORTED_UNITY_VERSION"
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

interface ErrorMeta {
  recoverable: boolean;
  suggestedAction: string;
  defaultMessage: string;
}

const ERROR_META: Record<ErrorCode, ErrorMeta> = {
  UNITY_NOT_CONNECTED: {
    recoverable: true,
    suggestedAction:
      "Open the Unity Editor with the UnityVibeOS package installed. The bridge auto-starts on editor load. Run `uvibe doctor` to confirm.",
    defaultMessage: "The Unity bridge is not reachable.",
  },
  UNITY_COMPILING: {
    recoverable: true,
    suggestedAction: "Wait for compilation to finish. Use `unity_wait_for_compile`.",
    defaultMessage: "Unity is compiling.",
  },
  UNITY_RELOADING: {
    recoverable: true,
    suggestedAction:
      "Unity is reloading the script domain (after a compile or on entering play mode). The bridge restarts automatically — retry the call shortly. `unity_wait_for_compile` rides through reloads. If this persists for more than a minute, Unity is likely paused in the background: ask the user to focus the Unity window and check Window ▸ Unity Vibe OS ▸ Keep Unity awake (background).",
    defaultMessage: "Unity is reloading the C# domain; the bridge is briefly unavailable.",
  },
  UNITY_EDITOR_STALLED: {
    recoverable: true,
    suggestedAction:
      "Unity's editor loop is frozen — it is unfocused/minimised and not processing anything, so retrying will NOT help. STOP retrying and ask the user to focus the Unity window, or enable Window ▸ Unity Vibe OS ▸ Keep Unity awake (background) (and update the UnityVibeOS package if that menu item is missing). `uvibe doctor` confirms the fix.",
    defaultMessage: "Unity's editor loop is not ticking; the Editor is stalled in the background.",
  },
  TEST_FRAMEWORK_MISSING: {
    recoverable: false,
    suggestedAction:
      "Install the Unity Test Framework (com.unity.test-framework) via the Package Manager. If UnityVibeOS was installed with `--mode=manifest`, rerun that install command so the package is added to `testables`.",
    defaultMessage: "Unity Test Framework is not installed in this project.",
  },
  PLAY_MODE_REQUIRED: {
    recoverable: true,
    suggestedAction:
      "Enter play mode first with `unity_enter_play_mode`. Runtime inspection and live profiler counters only produce data while the game is running.",
    defaultMessage: "This operation requires the Editor to be in play mode.",
  },
  UNSAVED_CHANGES: {
    recoverable: true,
    suggestedAction:
      "Save the open scene(s) first (unity_save_scene), or re-call with discardUnsavedChanges:true to abandon them. The details list which scenes are dirty.",
    defaultMessage: "There are unsaved scene changes that this operation would discard.",
  },
  MENU_ITEM_NOT_ALLOWED: {
    recoverable: true,
    suggestedAction:
      "Reopen the project in foundry-unity so project access is repaired, then retry the command.",
    defaultMessage: "Menu item is not in the configured allowlist.",
  },
  PROJECT_IDENTITY_MISMATCH: {
    recoverable: true,
    suggestedAction:
      "The Unity Editor that answered is for a different project than the one Claude is working in. Open the correct project, or set bridgePort in .unity-vibe/config.json to target the right Editor instance.",
    defaultMessage: "Connected Unity Editor is for a different project.",
  },
  FEATURE_UNAVAILABLE: {
    recoverable: false,
    suggestedAction:
      "This feature needs a newer Unity version or an optional package. Check the message for the specific requirement.",
    defaultMessage: "Feature unavailable in this Unity version/configuration.",
  },
  OBJECT_NOT_FOUND: {
    recoverable: true,
    suggestedAction: "Verify the object path/name exists in the active scene or any loaded scene.",
    defaultMessage: "GameObject not found.",
  },
  ASSET_NOT_FOUND: {
    recoverable: true,
    suggestedAction: "Confirm the asset path is correct and the asset exists in the AssetDatabase.",
    defaultMessage: "Asset not found.",
  },
  INVALID_ARGUMENT: {
    recoverable: true,
    suggestedAction: "Inspect the tool's input schema and correct the argument.",
    defaultMessage: "Invalid argument.",
  },
  SAFETY_MODE_BLOCKED: {
    recoverable: true,
    suggestedAction:
      "Update `.unity-vibe/config.json` to a less restrictive safety mode (suggest/confirm/autopilot) before retrying.",
    defaultMessage: "Operation blocked by safety mode.",
  },
  WRITE_REQUIRES_SNAPSHOT: {
    recoverable: true,
    suggestedAction:
      "Enable autoSnapshot in `.unity-vibe/config.json` or commit pending changes before retrying.",
    defaultMessage: "Write operation requires a snapshot but none was created.",
  },
  UNSUPPORTED_UNITY_VERSION: {
    recoverable: false,
    suggestedAction: "Upgrade Unity to a supported version (2021.3 LTS or newer is recommended).",
    defaultMessage: "Unity version is not supported.",
  },
  INTERNAL_ERROR: {
    recoverable: false,
    suggestedAction: "Inspect the message/details. File an issue with reproduction steps if persistent.",
    defaultMessage: "Internal error.",
  },
  MOCK_MODE_ACTIVE: {
    recoverable: true,
    suggestedAction: "This response was synthesized in mock mode. Disable UVIBE_MOCK to use the real bridge.",
    defaultMessage: "Running in mock mode.",
  },
  BRIDGE_TIMEOUT: {
    recoverable: true,
    suggestedAction: "Increase timeout, or check that Unity is responsive (it may be in a long compile or import).",
    defaultMessage: "Bridge request timed out.",
  },
  MALFORMED_BRIDGE_RESPONSE: {
    recoverable: false,
    suggestedAction: "Bridge returned a non-JSON or schema-invalid payload. Check Unity console for errors.",
    defaultMessage: "Malformed bridge response.",
  },
  TOOL_NOT_IMPLEMENTED: {
    recoverable: false,
    suggestedAction: "This tool is planned but not yet implemented in this build.",
    defaultMessage: "Tool not implemented.",
  },
  PROJECT_NOT_FOUND: {
    recoverable: true,
    suggestedAction:
      "Point the CLI at a Unity project directory (the one containing Assets/, Packages/, ProjectSettings/) using --project or UVIBE_PROJECT.",
    defaultMessage: "No Unity project found at the given path.",
  },
  GIT_NOT_AVAILABLE: {
    recoverable: true,
    suggestedAction: "Install git, or run from a directory inside a git repository.",
    defaultMessage: "git is unavailable or this directory is not a git repository.",
  },
};

export function isErrorCode(value: string): value is ErrorCode {
  return Object.prototype.hasOwnProperty.call(ERROR_META, value);
}

export function makeError(
  code: ErrorCode,
  message?: string,
  details?: Record<string, unknown>
): ErrorDetail {
  const meta = ERROR_META[code];
  return {
    code,
    message: message ?? meta.defaultMessage,
    recoverable: meta.recoverable,
    suggestedAction: meta.suggestedAction,
    ...(details !== undefined ? { details } : {}),
  };
}

export class UVibeError extends Error {
  readonly detail: ErrorDetail;
  constructor(code: ErrorCode, message?: string, details?: Record<string, unknown>) {
    const detail = makeError(code, message, details);
    super(detail.message);
    this.name = "UVibeError";
    this.detail = detail;
  }
}
