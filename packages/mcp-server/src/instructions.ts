/**
 * Server instructions. The MCP protocol delivers this string to the client (Claude Code) on
 * connect, so it is the one place that teaches the agent the toolset and the right workflows
 * *inside the user's Unity project* — where there is no wazzicode CLAUDE.md. Keep it tight: it is
 * sent every session. It is the reason the user can "just write prompts" and trust the agent knows
 * which tools exist and how to chain them.
 */
export const SERVER_INSTRUCTIONS = `Unity Vibe OS — a Unity-aware operating layer. The unity_* tools read and edit the user's OPEN Unity Editor live over a local bridge, so work from real project state, not from guessing at .unity/.prefab YAML.

GOLDEN RULES
1. Start any task with \`unity_orient({ task: "<the user's current request>" })\` — one call returns live Unity state, git status, project-map freshness, and bounded knowledge matches for the task. Don't gather those separately.
2. Before writing C# against a Unity/package API, verify it exists with \`unity_reflect\` (it reads the project's actually-loaded assemblies — ground truth over memory). \`unity_docs\` adds prose/usage.
3. After ANY C# change, run \`unity_verify\` (asset refresh → compile → console → tests → one pass/fail verdict). Never claim a change works until it passes.
4. When the user says "this" / "the selected object", call \`unity_inspect_selected\` first.
5. Inspect first, act second, verify after. Prefer a concrete target (named GameObject, file path, instanceId) over guessing.

EDIT C#: \`unity_read_script\` (returns a sha256) → \`unity_create_script\` for new files, \`unity_apply_text_edits\` for exact 1-based line/col ranges, or \`unity_script_edit\` for whole-method/anchor ops. Pass the sha back as preconditionSha256; use preview:true for a diff. Writes recompile — follow with unity_verify.

BUILD SCENES: unity_create_gameobject, unity_add_component, unity_set_serialized_field, unity_assign_reference, unity_set_transform, unity_reparent, unity_instantiate_prefab, unity_save_scene. Every scene/prefab edit is Undo-wrapped (Ctrl+Z). Bundle a known multi-step plan into ONE \`unity_batch\` call.

PLAY-TEST: prefer \`unity_smoke_test\` for a guarded enter → settle → runtime errors/performance/screenshot → cleanup pass with one verdict. For deeper debugging use unity_enter_play_mode → unity_find_runtime_objects / unity_inspect_runtime_object / unity_configure_play_mode / unity_set_runtime_field / unity_simulate_input → unity_exit_play_mode. Runtime field overrides are temporary and discarded on exit. unity_capture_game_view, unity_capture_scene_view, and unity_capture_selected return real images — use them to SEE what you built; pass format:"jpg" when capturing repeatedly (≈10x smaller). On macOS, never call unity_capture_editor_window: Unity's framebuffer API can terminate the Editor, so the tool intentionally returns FEATURE_UNAVAILABLE. unity_step_frame steps N frames in one call.

QA: \`unity_qa\` is the full gate: truthful compile/console/tests, missing-script/reference scans, build readiness, then a guarded smoke test. \`unity_get_build_settings\` checks enabled scenes and platform support without starting a build.

DIAGNOSE: \`unity_diagnose_connection\` explains missing/reloading/stalled/wrong-project bridges and MCP/package version drift in one call. Use unity_get_console_logs query:"..." for focused log searches. Use unity_find_missing_scripts, unity_find_missing_references, unity_find_references / unity_find_dependencies before any rename/delete.

ACCESS: Studio manages project and agent permissions automatically. Use the tools you need without asking the user to run setup or permission commands. Scene/prefab changes remain Unity Undo-wrapped; file tasks have a pre-run git checkpoint; all MCP writes are action-logged. If a tool is unavailable, use the closest dedicated tool and report the concrete operation that failed.

TOOL GROUPS: all groups are active. \`unity_manage_tools\` can trim unused groups. Big scenes: unity_get_scene_hierarchy is capped (maxNodes) and flags truncated — narrow with scenePath/maxDepth instead of dumping everything.

PROJECT KNOWLEDGE: the per-project map under \`.unity-vibe/knowledge/\` is refreshed when an MCP session starts and invalidated after persistent writes. Use \`unity_query_project_brain\` for project-specific architecture, ownership, dependency, or "what handles this?" questions; it returns bounded, provenance-bearing matches instead of injecting the whole database into context. Treat heuristic facts as heuristic and respect scan coverage/truncation. Use \`unity_generate_project_brain\` for an explicit full rebuild.

BRIDGE STATE: UNITY_RELOADING means the Editor is mid script-reload — recoverable, auto-retries, just proceed. UNITY_NOT_CONNECTED means no Editor with this project is open (ask the user to open Unity, then \`uvibe doctor\`). UNITY_EDITOR_STALLED means Unity is frozen in the background (unfocused, keep-awake off) — retrying is USELESS; stop and ask the user to focus the Unity window or enable Window ▸ Unity Vibe OS ▸ Keep Unity awake (background). Never retry the same stalled/timed-out call more than twice — surface the error to the user instead.

Slash commands (/mcp__unity-vibe-os__*): orient, diagnose_scene, analyze_scene, verify, new_script, play_test, qa. Resources: unity://project-brain, unity://conventions, unity://action-log, unity://scene-hierarchy, unity://console.`;
