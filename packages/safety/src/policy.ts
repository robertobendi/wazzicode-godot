import { ErrorCode, WriteTarget } from "@gvibe/core";
import { GVibeConfig, SafetyMode } from "./config.js";

export type { WriteTarget };

/**
 * Write tools are classified by exact name rather than by a brittle substring.
 */
export const WRITE_TOOLS: Record<string, WriteTarget> = {
  godot_set_property: "scene",
  godot_create_node: "scene",
  godot_delete_node: "scene",
  godot_reparent_node: "scene",
  godot_instantiate_scene: "scene",
  godot_save_scene: "scene",
  godot_open_scene: "editor",
  godot_create_script: "script",
  godot_apply_text_edits: "script",
  godot_refresh_filesystem: "editor",
  godot_run_project: "editor",
  godot_stop_project: "editor",
};

export interface ToolGateDecision {
  allowed: boolean;
  reason?: string;
  errorCode?: ErrorCode;
}

export function isWriteTool(toolName: string): boolean {
  return Object.prototype.hasOwnProperty.call(WRITE_TOOLS, toolName);
}

export function writeTargetOf(toolName: string): WriteTarget | undefined {
  return WRITE_TOOLS[toolName];
}

/**
 * Gate a tool call. `target` may be supplied by the tool definition (preferred); otherwise it
 * is looked up from the WRITE_TOOLS table. Non-write tools are always allowed.
 */
export function gateTool(config: GVibeConfig, toolName: string, target?: WriteTarget): ToolGateDecision {
  const t = target ?? writeTargetOf(toolName);
  if (!t) return { allowed: true };
  return gateWrite(config, toolName, t);
}

export function gateWrite(config: GVibeConfig, toolName: string, target: WriteTarget): ToolGateDecision {
  switch (config.safetyMode as SafetyMode) {
    case "read_only":
      return {
        allowed: false,
        errorCode: "SAFETY_MODE_BLOCKED",
        reason: `Project access is locked, so '${toolName}' could not run. Change .godot-vibe/config.json only if the project owner intends to allow writes.`,
      };
    case "suggest":
      return {
        allowed: false,
        errorCode: "SAFETY_MODE_BLOCKED",
        reason: `Project access is in preview-only mode, so '${toolName}' could not change ${target} state.`,
      };
    case "confirm":
      return {
        allowed: false,
        errorCode: "SAFETY_MODE_BLOCKED",
        reason: `Confirmation mode blocked '${toolName}' because this MCP session has no trusted approval signal. The project owner must explicitly choose a write-enabled mode before unattended changes can run.`,
      };
    case "autopilot": {
      if (target === "scene" && !config.allowSceneWrites) {
        return {
          allowed: false,
          errorCode: "SAFETY_MODE_BLOCKED",
          reason: `Scene writes are disabled (allowSceneWrites=false in .godot-vibe/config.json).`,
        };
      }
      if (target === "resource" && !config.allowResourceWrites) {
        return {
          allowed: false,
          errorCode: "SAFETY_MODE_BLOCKED",
          reason: `Resource writes are disabled (allowResourceWrites=false in .godot-vibe/config.json).`,
        };
      }
      if (target === "script" && !config.allowScriptWrites) {
        return {
          allowed: false,
          errorCode: "SAFETY_MODE_BLOCKED",
          reason: `Script writes are disabled (allowScriptWrites=false in .godot-vibe/config.json).`,
        };
      }
      if (target === "project_settings" && !config.allowProjectSettingsWrites) {
        return {
          allowed: false,
          errorCode: "SAFETY_MODE_BLOCKED",
          reason: `Project settings writes are disabled (allowProjectSettingsWrites=false in .godot-vibe/config.json).`,
        };
      }
      if (target === "editor" && !config.allowEditorControl) {
        return {
          allowed: false,
          errorCode: "SAFETY_MODE_BLOCKED",
          reason: "Editor control is disabled (allowEditorControl=false in .godot-vibe/config.json).",
        };
      }
      return { allowed: true };
    }
  }
}
