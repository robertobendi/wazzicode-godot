import { AnyToolDef } from "./registry.js";

/**
 * MCP tool annotations, tuned for Claude Code (the only client). Claude Code uses these hints to
 * decide what to surface and what it can run without a permission prompt:
 *   - readOnlyHint: this tool only observes — safe to auto-run.
 *   - destructiveHint: this write is hard to undo (overwrites a file, runs code, clears state).
 *   - idempotentHint: repeating it with the same args changes nothing further.
 *   - openWorldHint: it touches the network / outside world.
 * We derive them from each tool's write/writeTarget plus a few explicit overrides, so adding a tool
 * gets sensible defaults for free.
 */
export interface ToolAnnotations {
  title?: string;
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

// Tools that aren't flagged `write` (they don't mutate the *project*) but still change runtime,
// session, or filesystem state — so they are NOT read-only and shouldn't be auto-run silently.
const MUTATING_NON_WRITE = new Set<string>([
  "unity_batch", // can perform any sub-op, including writes
  "unity_generate_project_brain", // writes .unity-vibe/*
  "unity_manage_tools", // changes which tools are exposed this session
  "unity_refresh_assets", // imports externally changed files into the AssetDatabase
  "unity_verify", // refreshes assets and may start compilation/tests
  "unity_capture_game_view", // saves under .unity-vibe/screenshots by default
  "unity_capture_scene_view",
  "unity_capture_selected",
  "unity_capture_editor_window",
  "unity_run_tests", // changes Test Runner session state
  "unity_open_scene", // changes open Editor content
  "unity_load_scene_additive",
  "unity_open_prefab",
  "unity_simulate_input", // drives runtime input
  "unity_set_animator_parameter", // drives runtime animator
  "unity_enter_play_mode",
  "unity_exit_play_mode",
  "unity_step_frame",
  "unity_configure_play_mode",
  "unity_set_runtime_field",
  "unity_smoke_test",
  "unity_qa",
]);

// Writes that overwrite/erase or run code — hard to undo (no Unity Undo entry). Scene/prefab edits
// are Undo-wrapped and additive, so they are NOT marked destructive — except deletes, which erase
// existing state and warrant an approval prompt even though they're Undo-wrapped.
const DESTRUCTIVE = new Set<string>([
  "unity_create_script",
  "unity_apply_text_edits",
  "unity_script_edit",
  "unity_execute_code",
  "unity_execute_menu_item",
  "unity_clear_console",
  "unity_save_scene",
  "unity_save_prefab",
  "unity_apply_prefab_instance",
  "unity_animator_edit_transition",
  "unity_delete_gameobject",
  "unity_remove_component",
  "unity_delete_asset",
]);

// Repeating with the same args lands on the same state (vs. create/instantiate which add each time).
const IDEMPOTENT = new Set<string>([
  "unity_set_serialized_field",
  "unity_set_transform",
  "unity_assign_reference",
  "unity_save_scene",
  "unity_save_prefab",
  "unity_clear_console",
  "unity_reparent",
]);

const OPEN_WORLD = new Set<string>(["unity_docs"]);

function titleOf(name: string): string {
  return name
    .replace(/^unity_/, "")
    .split("_")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

export function toolAnnotations(tool: AnyToolDef): ToolAnnotations {
  const name = tool.name;
  const mutates = tool.write === true || MUTATING_NON_WRITE.has(name);
  const a: ToolAnnotations = {
    title: titleOf(name),
    readOnlyHint: !mutates,
  };
  if (OPEN_WORLD.has(name)) a.openWorldHint = true;
  if (!mutates) return a;
  // Mutating tools: classify how risky / repeatable the change is.
  a.destructiveHint = DESTRUCTIVE.has(name);
  if (IDEMPOTENT.has(name)) a.idempotentHint = true;
  return a;
}
