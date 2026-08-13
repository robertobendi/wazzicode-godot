import { describe, it, expect } from "vitest";
import { toolLabel } from "./toolLabels";

describe("toolLabel", () => {
  it("labels standard Claude Code tools", () => {
    expect(toolLabel("Read")).toBe("Reading a file");
    expect(toolLabel("Edit")).toBe("Editing game code");
    expect(toolLabel("Grep")).toBe("Searching the project");
    expect(toolLabel("TodoWrite")).toBe("Planning steps");
  });

  it("labels known unity tools", () => {
    expect(toolLabel("mcp__unity-vibe-os__unity_orient")).toBe(
      "Getting oriented in Unity",
    );
    expect(toolLabel("mcp__unity-vibe-os__unity_verify")).toBe(
      "Checking everything compiles and tests pass",
    );
    expect(toolLabel("mcp__unity-vibe-os__unity_diagnose_connection")).toBe(
      "Diagnosing the Unity connection",
    );
    expect(toolLabel("mcp__unity-vibe-os__unity_capture_game_view")).toBe(
      "Taking a screenshot of the game",
    );
    expect(toolLabel("mcp__unity-vibe-os__unity_create_gameobject")).toBe(
      "Creating a new object",
    );
  });

  it("falls back to a sentence-cased, de-prefixed label for unknown unity tools", () => {
    expect(toolLabel("mcp__unity-vibe-os__unity_some_new_tool")).toBe(
      "Some new tool",
    );
  });

  it("falls back for unity tools without the unity_ segment", () => {
    expect(toolLabel("mcp__unity-vibe-os__future_thing")).toBe("Future thing");
  });

  it("falls back for wholly unknown tool names", () => {
    expect(toolLabel("mcp__other-server__do_stuff")).toBe(
      "Other-server do stuff",
    );
    expect(toolLabel("MysteryTool")).toBe("MysteryTool");
  });

  // Every Unity MCP tool must have an explicit, hand-written label — none may
  // fall through to the auto-generated sentence-case of its raw name. This list
  // is the `unity_*` name set exported from
  // packages/mcp-server/src/tools/index.ts (kept in sync manually).
  const UNITY_TOOL_NAMES = [
    "unity_add_component",
    "unity_animator_edit_transition",
    "unity_apply_prefab_instance",
    "unity_apply_text_edits",
    "unity_assign_reference",
    "unity_batch",
    "unity_capture_editor_window",
    "unity_capture_game_view",
    "unity_capture_scene_view",
    "unity_capture_selected",
    "unity_check_git_status",
    "unity_clear_console",
    "unity_configure_play_mode",
    "unity_create_gameobject",
    "unity_create_material",
    "unity_create_prefab_variant",
    "unity_create_script",
    "unity_create_scriptable_object",
    "unity_delete_asset",
    "unity_delete_gameobject",
    "unity_diagnose_connection",
    "unity_docs",
    "unity_enter_play_mode",
    "unity_execute_code",
    "unity_execute_menu_item",
    "unity_exit_play_mode",
    "unity_find_dependencies",
    "unity_find_in_file",
    "unity_find_missing_references",
    "unity_find_missing_scripts",
    "unity_find_references",
    "unity_find_runtime_objects",
    "unity_generate_project_brain",
    "unity_get_animator_state",
    "unity_get_build_settings",
    "unity_get_console_logs",
    "unity_get_open_scenes",
    "unity_get_performance_stats",
    "unity_get_play_mode_status",
    "unity_get_scene_hierarchy",
    "unity_get_script_sha",
    "unity_import_asset",
    "unity_inspect_runtime_object",
    "unity_inspect_selected",
    "unity_instantiate_prefab",
    "unity_load_scene_additive",
    "unity_manage_tools",
    "unity_open_prefab",
    "unity_open_scene",
    "unity_orient",
    "unity_paint_tilemap",
    "unity_project_summary",
    "unity_qa",
    "unity_query_project_brain",
    "unity_read_script",
    "unity_reflect",
    "unity_refresh_assets",
    "unity_remove_component",
    "unity_reparent",
    "unity_run_tests",
    "unity_save_prefab",
    "unity_save_scene",
    "unity_script_edit",
    "unity_set_animator_parameter",
    "unity_set_runtime_field",
    "unity_set_serialized_field",
    "unity_set_transform",
    "unity_simulate_input",
    "unity_slice_sprite",
    "unity_smoke_test",
    "unity_step_frame",
    "unity_verify",
    "unity_wait_for_compile",
    "unity_wire_ui_button",
  ];

  // The generic fallback the labeler would produce for an unmapped unity_ tool.
  function genericFallback(shortName: string): string {
    const t = shortName.replace(/_/g, " ").trim();
    return t.charAt(0).toUpperCase() + t.slice(1);
  }

  it("has an explicit label for every unity_* tool (no generic fallthrough)", () => {
    const missing: string[] = [];
    for (const short of UNITY_TOOL_NAMES) {
      const full = `mcp__unity-vibe-os__${short}`;
      const label = toolLabel(full);
      const fallback = genericFallback(short.replace(/^unity_/, ""));
      if (!label || label === fallback) missing.push(short);
    }
    expect(missing).toEqual([]);
  });

  it("covers the expected number of unity tools", () => {
    expect(UNITY_TOOL_NAMES).toHaveLength(74);
  });
});
