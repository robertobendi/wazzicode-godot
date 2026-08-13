import type { AnyToolDef } from "./registry.js";
export interface ToolAnnotations { title?: string; readOnlyHint?: boolean; destructiveHint?: boolean; idempotentHint?: boolean; openWorldHint?: boolean }
const MUTATING = new Set(["godot_batch", "godot_generate_project_brain", "godot_capture_2d_view", "godot_capture_3d_view", "godot_open_scene", "godot_verify"]);
const DESTRUCTIVE = new Set(["godot_create_script", "godot_apply_text_edits", "godot_save_scene", "godot_delete_node"]);
const IDEMPOTENT = new Set(["godot_set_property", "godot_save_scene", "godot_reparent_node", "godot_refresh_filesystem"]);
export function toolAnnotations(tool: AnyToolDef): ToolAnnotations { const mutates = tool.write === true || MUTATING.has(tool.name); return { title: tool.name.replace(/^godot_/, "").split("_").map((word) => word[0].toUpperCase() + word.slice(1)).join(" "), readOnlyHint: !mutates, ...(mutates ? { destructiveHint: DESTRUCTIVE.has(tool.name), ...(IDEMPOTENT.has(tool.name) ? { idempotentHint: true } : {}) } : {}) }; }
