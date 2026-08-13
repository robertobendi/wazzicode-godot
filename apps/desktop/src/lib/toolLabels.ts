const GODOT_PREFIX = "mcp__godot-vibe-os__godot_";
const GODOT_PREFIX_ALT = "mcp__godot-vibe-os__";

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

const GODOT_LABELS: Record<string, string> = {
  orient: "Getting oriented in Godot",
  diagnose_connection: "Diagnosing the Godot connection",
  verify: "Verifying imports and GDScript",
  batch: "Making several Godot changes",
  project_summary: "Reading project settings",
  generate_project_brain: "Mapping the Godot project",
  query_project_brain: "Consulting the project map",
  get_open_scenes: "Checking open scenes",
  get_scene_tree: "Reading the scene tree",
  inspect_selected: "Inspecting selected nodes",
  get_filesystem_status: "Checking Godot resources",
  refresh_filesystem: "Refreshing Godot resources",
  find_dependencies: "Tracing resource dependencies",
  reflect: "Checking the Godot API",
  capture_2d_view: "Capturing the 2D editor",
  capture_3d_view: "Capturing the 3D editor",
  open_scene: "Opening a Godot scene",
  save_scene: "Saving the Godot scene",
  set_property: "Changing a node property",
  create_node: "Creating a node",
  delete_node: "Deleting a node",
  reparent_node: "Reorganizing the scene tree",
  instantiate_scene: "Instantiating a scene",
  read_script: "Reading a Godot text resource",
  get_script_sha: "Checking a script revision",
  find_in_file: "Finding code in a file",
  create_script: "Writing a Godot script",
  apply_text_edits: "Editing a Godot script",
  run_project: "Running the Godot project",
  stop_project: "Stopping the Godot project",
  get_play_status: "Checking the running project",
};

const CODEX_ITEM_LABELS: Record<string, string> = {
  command_execution: "Running a command",
  file_change: "Editing game code",
  patch_apply: "Editing game code",
  web_search: "Searching the web",
  todo_list: "Planning steps",
};

export function codexItemLabel(itemType: string): string {
  return CODEX_ITEM_LABELS[itemType] ?? sentenceCase(itemType.replace(/_/g, " "));
}

export function codexMcpName(server: string, tool: string): string {
  const canonical = server === "godot_vibe_os" ? "godot-vibe-os" : server;
  return `mcp__${canonical}__${tool}`;
}

export function toolLabel(name: string): string {
  if (name in STANDARD_LABELS) return STANDARD_LABELS[name];
  if (name.startsWith(GODOT_PREFIX)) {
    const short = name.slice(GODOT_PREFIX.length);
    return GODOT_LABELS[short] ?? sentenceCase(short.replace(/_/g, " "));
  }
  if (name.startsWith(GODOT_PREFIX_ALT)) {
    return sentenceCase(name.slice(GODOT_PREFIX_ALT.length).replace(/_/g, " "));
  }
  return sentenceCase(name.replace(/^mcp__/, "").replace(/_/g, " "));
}

function sentenceCase(value: string): string {
  const text = value.replace(/\s+/g, " ").trim();
  return text ? text.charAt(0).toUpperCase() + text.slice(1) : "Working";
}
