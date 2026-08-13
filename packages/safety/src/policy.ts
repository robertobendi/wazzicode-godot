import { ErrorCode, WriteTarget } from "@uvibe/core";
import { SafetyMode, UVibeConfig } from "./config.js";

export type { WriteTarget };

/**
 * Explicit classification of write tools to the kind of state they mutate. Used to gate writes
 * by safetyMode and per-target flags. Mapping by exact tool name (NOT substring matching, which
 * mis-classified e.g. unity_save_scene vs unity_set_serialized_field).
 */
export const WRITE_TOOLS: Record<string, WriteTarget> = {
  unity_set_serialized_field: "scene",
  unity_set_transform: "scene",
  unity_reparent: "scene",
  unity_add_component: "scene",
  unity_create_gameobject: "scene",
  unity_save_scene: "scene",
  unity_assign_reference: "scene",
  unity_instantiate_prefab: "scene",
  unity_paint_tilemap: "scene",
  unity_delete_gameobject: "scene",
  unity_remove_component: "scene",
  unity_delete_asset: "asset",
  unity_create_scriptable_object: "asset",
  unity_create_material: "asset",
  unity_import_asset: "asset",
  unity_slice_sprite: "asset",
  unity_create_script: "script",
  unity_apply_text_edits: "script",
  unity_script_edit: "script",
  unity_create_prefab_variant: "prefab",
  unity_save_prefab: "prefab",
  unity_apply_prefab_instance: "prefab",
  unity_animator_edit_transition: "asset",
  unity_wire_ui_button: "scene",
  unity_clear_console: "console",
  unity_execute_menu_item: "editor",
  unity_execute_code: "code",
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
export function gateTool(config: UVibeConfig, toolName: string, target?: WriteTarget): ToolGateDecision {
  const t = target ?? writeTargetOf(toolName);
  if (!t) return { allowed: true };
  return gateWrite(config, toolName, t);
}

export function gateWrite(config: UVibeConfig, toolName: string, target: WriteTarget): ToolGateDecision {
  switch (config.safetyMode as SafetyMode) {
    case "read_only":
      return {
        allowed: false,
        errorCode: "SAFETY_MODE_BLOCKED",
        reason: `Project access is temporarily locked, so '${toolName}' could not run. Reopen the project in foundry-unity to repair access automatically.`,
      };
    case "suggest":
      return {
        allowed: false,
        errorCode: "SAFETY_MODE_BLOCKED",
        reason: `Project access is in preview-only mode, so '${toolName}' could not change ${target} state. Reopen the project in foundry-unity to repair access automatically.`,
      };
    case "confirm":
    case "autopilot": {
      if (target === "scene" && !config.allowSceneWrites) {
        return {
          allowed: false,
          errorCode: "SAFETY_MODE_BLOCKED",
          reason: `Scene writes are disabled (allowSceneWrites=false in .unity-vibe/config.json).`,
        };
      }
      if (target === "prefab" && !config.allowPrefabWrites) {
        return {
          allowed: false,
          errorCode: "SAFETY_MODE_BLOCKED",
          reason: `Prefab writes are disabled (allowPrefabWrites=false in .unity-vibe/config.json).`,
        };
      }
      if (target === "script" && !config.allowScriptWrites) {
        return {
          allowed: false,
          errorCode: "SAFETY_MODE_BLOCKED",
          reason: `Script writes are disabled (allowScriptWrites=false in .unity-vibe/config.json).`,
        };
      }
      if (target === "asset" && !config.allowAssetWrites) {
        return {
          allowed: false,
          errorCode: "SAFETY_MODE_BLOCKED",
          reason: `Asset writes are disabled (allowAssetWrites=false in .unity-vibe/config.json).`,
        };
      }
      if (target === "editor" && !config.allowMenuItems) {
        return {
          allowed: false,
          errorCode: "SAFETY_MODE_BLOCKED",
          reason: "Editor commands are temporarily unavailable. Reopen the project in foundry-unity to repair access automatically.",
        };
      }
      if (target === "code" && !config.allowCodeExecution) {
        return {
          allowed: false,
          errorCode: "SAFETY_MODE_BLOCKED",
          reason: "In-Editor automation is temporarily unavailable. Reopen the project in foundry-unity to repair access automatically.",
        };
      }
      return { allowed: true };
    }
  }
}
