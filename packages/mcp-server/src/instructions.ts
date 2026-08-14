export const SERVER_INSTRUCTIONS = `Godot Vibe OS is a Godot-native operating layer. Its godot_* tools read and edit the OPEN Godot editor over an authenticated localhost bridge. Work from live scenes, NodePaths, ClassDB, project resources, and source-backed project knowledge.

1. Begin with godot_orient({task:"the user's request"}). It returns edited/open scenes, selection, import state, play state, git, and relevant project-map matches in one call.
2. Never guess Godot APIs. Call godot_reflect with an exact className (or search query) before writing unfamiliar GDScript APIs.
3. When the user says “this” or “selected”, call godot_inspect_selected first. Use exact NodePaths relative to the edited root.
4. Inspect, edit, then verify. After text changes call godot_refresh_filesystem and godot_verify. godot_verify is an honest import + GDScript syntax gate; it reports tests as not_configured unless a real project runner is later integrated.
5. Read before editing. godot_read_script returns sha256; pass it to godot_apply_text_edits so concurrent changes cannot be overwritten.
6. For runtime bugs, use godot_debug_run instead of manually chaining run/status/capture. It launches or safely attaches, observes bounded logs and performance, returns one game screenshot, and only stops runs it started.

SCENES: use godot_get_scene_tree, godot_open_scene, godot_create_node, godot_set_property, godot_reparent_node, godot_instantiate_scene, godot_delete_node, then godot_save_scene. Editor scene mutations use Godot UndoRedo and persistent nodes receive the correct owner. Bundle known multi-step plans with godot_batch; each operation remains safety-gated and logged.

RESOURCES: use godot_find_dependencies before moving or deleting resources. Use res:// paths. Do not edit .tscn/.tres by hand when a dedicated live editor tool can make the change safely.

VISUALS: godot_capture_2d_view and godot_capture_3d_view return actual editor viewport images so inspect the result instead of inferring appearance.

DEBUGGING: godot_debug_run returns deterministic, grouped errors and warnings plus FPS, frame/physics time, memory, node/orphan counts, draw calls, lifecycle, runtime identity, and optional image evidence. A clean verdict means no issues were observed in that bounded window; it is not proof that none exist.

PROJECT MAP: .godot-vibe/brain stores a bounded index of project settings, addons, scenes, resources, GDScript classes/signals/exports/functions, shaders, and relationships. Use godot_query_project_brain for focused architecture/ownership/dependency questions.

CONNECTION: godot_diagnose_connection checks addon install/enablement, token-authenticated discovery, protocol, health, RPC, and project identity. GODOT_RELOADING is retryable. GODOT_NOT_CONNECTED means the expected project is not open with the addon enabled.

Resources: godot://project-brain, godot://conventions, godot://action-log, godot://scene-tree.`;
