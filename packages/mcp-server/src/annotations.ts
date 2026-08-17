import type { AnyToolDef } from "./registry.js";
export interface ToolAnnotations { title?: string; readOnlyHint?: boolean; destructiveHint?: boolean; idempotentHint?: boolean; openWorldHint?: boolean }
// Capture tools stay read-only: they only save into ignored scratch dirs, and
// a permission prompt per capture would defeat liberal use while play-testing.
const MUTATING = new Set(["godot_batch", "godot_generate_project_brain", "godot_open_scene", "godot_verify", "godot_test_run"]);
const DESTRUCTIVE = new Set(["godot_create_script", "godot_apply_text_edits", "godot_save_scene", "godot_delete_node"]);
const IDEMPOTENT = new Set(["godot_set_property", "godot_save_scene", "godot_reparent_node", "godot_refresh_filesystem"]);
export function toolAnnotations(tool: AnyToolDef): ToolAnnotations { const mutates = tool.write === true || MUTATING.has(tool.name); return { title: tool.name.replace(/^godot_/, "").split("_").map((word) => word[0].toUpperCase() + word.slice(1)).join(" "), readOnlyHint: !mutates, ...(mutates ? { destructiveHint: DESTRUCTIVE.has(tool.name), ...(IDEMPOTENT.has(tool.name) ? { idempotentHint: true } : {}) } : {}) }; }

/**
 * Tools whose bounded-but-large results (deep node trees, ClassDB dumps, project-map answers,
 * runtime log packets, frame sequences) would otherwise be clipped by a client's default cap.
 */
export const LARGE_RESULT_TOOLS = new Set([
  "godot_get_scene_tree",
  "godot_reflect",
  "godot_query_project_brain",
  "godot_debug_run",
  "godot_capture_frames",
]);
const MAX_RESULT_SIZE_CHARS = 200_000;

/** `_meta` published with the tool in tools/list. Undefined when the tool needs no hints. */
export function toolMeta(tool: AnyToolDef): Record<string, unknown> | undefined {
  if (!LARGE_RESULT_TOOLS.has(tool.name)) return undefined;
  return { "anthropic/maxResultSizeChars": MAX_RESULT_SIZE_CHARS };
}
