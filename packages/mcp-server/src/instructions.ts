/**
 * Claude Code truncates MCP server instructions at 2KB, so the primer stays under
 * MAX_INSTRUCTION_BYTES including the generated project map and points at resources
 * and tool descriptions for everything else.
 */
export const MAX_INSTRUCTION_BYTES = 2_000;

export const SERVER_INSTRUCTIONS = `Godot Vibe OS drives the OPEN Godot editor over an authenticated localhost bridge. Work from live scenes, NodePaths, ClassDB, and the source-backed project map.

1. Start with godot_orient({task:"the user's request"}): scenes, selection, import, play, git, and project-map matches in one call.
2. Never guess Godot APIs. Call godot_reflect with an exact className before writing unfamiliar ones.
3. Inspect before you mutate. Scene changes go through godot_get_scene_tree, godot_open_scene, godot_create_node, godot_set_property, godot_reparent_node, godot_instantiate_scene, godot_delete_node, godot_save_scene, which use editor UndoRedo. Do not hand-edit .tscn/.tres.
4. Read before editing text: godot_read_script returns sha256; pass it to godot_apply_text_edits.
5. Verify, then report the exact verdict. godot_verify is an import + GDScript syntax gate, not a test suite; tests stay not_configured unless godot_test_run really ran res://tests/run_tests.gd.
6. For runtime bugs call godot_debug_run; for how the running game moves over time call godot_capture_frames. Editor viewports come from godot_capture_2d_view/godot_capture_3d_view.

ERRORS: GODOT_NOT_CONNECTED means the project is not open with the addon enabled. GODOT_RELOADING is retryable. godot_diagnose_connection explains both.

Resources: godot://project-brain, godot://conventions, godot://action-log, godot://scene-tree.`;

/**
 * Join the static primer with the generated project map, dropping map lines that would push
 * the delivered instructions past the client's truncation limit.
 */
export function composeInstructions(projectKnowledgePrimer?: string): string {
  if (!projectKnowledgePrimer) return SERVER_INSTRUCTIONS;
  const lines = projectKnowledgePrimer.split("\n");
  while (lines.length > 0) {
    const candidate = `${SERVER_INSTRUCTIONS}\n\n${lines.join("\n")}`;
    if (Buffer.byteLength(candidate, "utf8") <= MAX_INSTRUCTION_BYTES) return candidate;
    lines.pop();
  }
  return SERVER_INSTRUCTIONS;
}
