// Friendly, non-technical labels for tool activity chips.
//
// Employees never see raw tool names like "mcp__unity-vibe-os__unity_verify".
// We map the common Claude Code tools and the important Unity tools to plain
// language; anything unmapped falls back to a sentence-cased, de-prefixed name.
//
// Codex names its MCP calls as a (server, tool) pair rather than one flat
// string, so `codexMcpName` re-joins them into the Claude-style name above and
// every Unity label below is reused as-is. Codex's *native* tools (shell, patch,
// web search) have no Claude equivalent and get their own map.

const UNITY_PREFIX = "mcp__unity-vibe-os__unity_";
const UNITY_PREFIX_ALT = "mcp__unity-vibe-os__"; // some tools may lack the unity_ segment

/** Standard Claude Code tools. */
const STANDARD_LABELS: Record<string, string> = {
  Read: "Reading a file",
  Edit: "Editing game code",
  Write: "Editing game code",
  MultiEdit: "Editing game code",
  Glob: "Searching the project",
  Grep: "Searching the project",
  TodoWrite: "Planning steps",
  WebFetch: "Looking something up",
  WebSearch: "Searching the web",
};

/** Unity tool short-names (after stripping the MCP prefix). */
const UNITY_LABELS: Record<string, string> = {
  orient: "Getting oriented in Unity",
  diagnose_connection: "Diagnosing the Unity connection",
  verify: "Checking everything compiles and tests pass",
  qa: "Running the full Unity QA gate",
  batch: "Making several changes",
  project_summary: "Looking over the project",
  generate_project_brain: "Studying the project",
  query_project_brain: "Consulting the project map",
  get_open_scenes: "Checking which scenes are open",
  get_scene_hierarchy: "Looking at the scene",
  inspect_selected: "Inspecting the selected object",
  get_console_logs: "Reading the Unity console",
  wait_for_compile: "Waiting for Unity to compile",
  refresh_assets: "Refreshing Unity assets",
  check_git_status: "Checking for changes",
  // Visual
  capture_game_view: "Taking a screenshot of the game",
  capture_scene_view: "Taking a screenshot of the scene",
  capture_selected: "Taking a screenshot of the selection",
  capture_editor_window: "Taking a screenshot of the Editor",
  get_performance_stats: "Checking performance",
  // Tests
  run_tests: "Running tests",
  get_build_settings: "Checking build readiness",
  smoke_test: "Smoke-testing the game",
  // Play mode + runtime
  enter_play_mode: "Pressing Play",
  exit_play_mode: "Stopping Play",
  step_frame: "Advancing a frame",
  get_play_mode_status: "Checking play mode",
  configure_play_mode: "Adjusting the running game",
  find_runtime_objects: "Finding objects in the running game",
  inspect_runtime_object: "Inspecting a running object",
  set_runtime_field: "Testing a runtime value",
  // Asset graph
  find_missing_scripts: "Looking for broken scripts",
  find_missing_references: "Looking for broken links",
  find_dependencies: "Tracing dependencies",
  find_references: "Finding what uses this",
  // Scripts (read)
  read_script: "Reading a script",
  get_script_sha: "Checking a script",
  find_in_file: "Finding code in a file",
  // Anti-hallucination
  reflect: "Checking the Unity API",
  docs: "Reading the Unity docs",
  // Navigation
  open_scene: "Opening a scene",
  load_scene_additive: "Loading another scene",
  open_prefab: "Opening a prefab",
  // Play-test + animation
  simulate_input: "Simulating input",
  get_animator_state: "Checking an animator",
  set_animator_parameter: "Driving an animator",
  animator_edit_transition: "Editing an animation transition",
  // Writes
  set_serialized_field: "Changing a component setting",
  set_transform: "Moving objects around",
  reparent: "Reorganizing the scene",
  add_component: "Adding a component",
  create_gameobject: "Creating a new object",
  save_scene: "Saving the scene",
  assign_reference: "Linking objects together",
  wire_ui_button: "Wiring up a button",
  instantiate_prefab: "Placing a prefab",
  paint_tilemap: "Painting the tilemap",
  delete_gameobject: "Deleting an object",
  remove_component: "Removing a component",
  // Scripts (write)
  create_script: "Writing new game code",
  apply_text_edits: "Editing game code",
  script_edit: "Editing game code",
  execute_code: "Running Editor automation",
  // Prefab / asset writes
  save_prefab: "Saving a prefab",
  apply_prefab_instance: "Applying prefab changes",
  create_scriptable_object: "Creating data",
  create_material: "Creating a material",
  create_prefab_variant: "Creating a prefab variant",
  import_asset: "Importing an asset",
  slice_sprite: "Slicing a sprite",
  delete_asset: "Deleting an asset",
  execute_menu_item: "Running an Editor command",
  clear_console: "Clearing the console",
  manage_tools: "Adjusting available tools",
};

/**
 * Codex's own tool items (`item.type` on the JSONL stream). These have no Claude
 * counterpart — Claude exposes a shell/patch as named tools, Codex as item types.
 */
const CODEX_ITEM_LABELS: Record<string, string> = {
  command_execution: "Running a command",
  file_change: "Editing game code",
  patch_apply: "Editing game code",
  web_search: "Searching the web",
  todo_list: "Planning steps",
};

/** Friendly label for one of Codex's native stream items. */
export function codexItemLabel(itemType: string): string {
  return (
    CODEX_ITEM_LABELS[itemType] ?? sentenceCase(itemType.replace(/_/g, " "))
  );
}

/**
 * Re-join a Codex MCP call's (server, tool) into the flat `mcp__<server>__<tool>`
 * name Claude uses, so both backends hit the same label table. Codex registers
 * our server as `unity_vibe_os` (a bare TOML key can't contain hyphens — see
 * `agent/codex.rs`), which we map back to the canonical hyphenated name.
 */
export function codexMcpName(server: string, tool: string): string {
  const canonical = server === "unity_vibe_os" ? "unity-vibe-os" : server;
  return `mcp__${canonical}__${tool}`;
}

/** Map a raw tool name to a friendly label. */
export function toolLabel(name: string): string {
  if (name in STANDARD_LABELS) return STANDARD_LABELS[name];

  if (name.startsWith(UNITY_PREFIX)) {
    const short = name.slice(UNITY_PREFIX.length);
    if (short in UNITY_LABELS) return UNITY_LABELS[short];
    return sentenceCase(short.replace(/_/g, " "));
  }
  if (name.startsWith(UNITY_PREFIX_ALT)) {
    const short = name.slice(UNITY_PREFIX_ALT.length);
    return sentenceCase(short.replace(/_/g, " "));
  }
  // Some other MCP server, or an unknown tool.
  return sentenceCase(name.replace(/^mcp__/, "").replace(/_/g, " "));
}

function sentenceCase(s: string): string {
  // Collapse runs of whitespace (e.g. from doubled `__` separators).
  const t = s.replace(/\s+/g, " ").trim();
  if (!t) return "Working";
  return t.charAt(0).toUpperCase() + t.slice(1);
}
