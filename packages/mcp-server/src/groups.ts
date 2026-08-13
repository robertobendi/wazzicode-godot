/**
 * Tool groups. The surface is large; grouping lets a session expose only what it needs so the
 * tool list (and the model's attention) stays focused. Most groups are active by default — the
 * mechanism mainly lets the agent trim groups it isn't using. Tools with no explicit group are
 * "core" and always active.
 */

export interface ToolGroupMeta {
  name: string;
  description: string;
  defaultActive: boolean;
}

export const TOOL_GROUPS: ToolGroupMeta[] = [
  { name: "core", description: "Orientation, scene/selection/console inspection, captures, scene/prefab/asset edits, navigation, batch/verify.", defaultActive: true },
  { name: "scripting", description: "Read and edit C# source: read/find/sha + create/apply_text_edits/script_edit.", defaultActive: true },
  { name: "reflection", description: "Anti-hallucination: unity_reflect (live type system) and unity_docs.", defaultActive: true },
  { name: "runtime", description: "Play mode control, runtime inspection/overrides, input simulation, animator, performance stats.", defaultActive: true },
  { name: "testing", description: "Verification, build readiness, smoke tests, and the Unity Test Runner.", defaultActive: true },
  { name: "codegen", description: "In-Editor C# automation for operations without a dedicated tool.", defaultActive: true },
];

/** Tools not listed here are "core". Keep names in sync with the tool defs. */
const TOOL_GROUP_BY_NAME: Record<string, string> = {
  // scripting
  unity_read_script: "scripting",
  unity_get_script_sha: "scripting",
  unity_find_in_file: "scripting",
  unity_create_script: "scripting",
  unity_apply_text_edits: "scripting",
  unity_script_edit: "scripting",
  // reflection
  unity_reflect: "reflection",
  unity_docs: "reflection",
  // runtime
  unity_enter_play_mode: "runtime",
  unity_exit_play_mode: "runtime",
  unity_step_frame: "runtime",
  unity_get_play_mode_status: "runtime",
  unity_configure_play_mode: "runtime",
  unity_find_runtime_objects: "runtime",
  unity_inspect_runtime_object: "runtime",
  unity_set_runtime_field: "runtime",
  unity_simulate_input: "runtime",
  unity_get_animator_state: "runtime",
  unity_set_animator_parameter: "runtime",
  unity_animator_edit_transition: "runtime",
  unity_get_performance_stats: "runtime",
  // testing
  unity_run_tests: "testing",
  unity_get_build_settings: "testing",
  unity_smoke_test: "testing",
  unity_qa: "testing",
  // codegen
  unity_execute_code: "codegen",
};

export function groupOf(toolName: string): string {
  return TOOL_GROUP_BY_NAME[toolName] ?? "core";
}

export function defaultActiveGroups(): Set<string> {
  return new Set(TOOL_GROUPS.filter((g) => g.defaultActive).map((g) => g.name));
}

export function isKnownGroup(name: string): boolean {
  return TOOL_GROUPS.some((g) => g.name === name);
}

/**
 * Live controller over the registered MCP tool handles. createServer builds one and hands it to
 * the request context; unity_manage_tools drives it. enable()/disable() on a RegisteredTool sends
 * tools/list_changed automatically, so the client's tool list updates without a reconnect.
 */
export interface ToolHandle {
  enable(): void;
  disable(): void;
}

export class ToolGroupController {
  private active: Set<string>;
  private handles = new Map<string, ToolHandle>();
  private toolGroup = new Map<string, string>();

  constructor(active: Set<string>) {
    this.active = active;
  }

  register(toolName: string, handle: ToolHandle): void {
    const group = groupOf(toolName);
    this.handles.set(toolName, handle);
    this.toolGroup.set(toolName, group);
    // "core" is never disablable; everything else follows its group's active state.
    if (group !== "core" && !this.active.has(group)) handle.disable();
  }

  list(): Array<{ name: string; description: string; active: boolean; toolCount: number }> {
    const counts = new Map<string, number>();
    for (const g of this.toolGroup.values()) counts.set(g, (counts.get(g) ?? 0) + 1);
    return TOOL_GROUPS.map((g) => ({
      name: g.name,
      description: g.description,
      active: g.name === "core" || this.active.has(g.name),
      toolCount: counts.get(g.name) ?? 0,
    }));
  }

  setActive(group: string, on: boolean): { changed: boolean; affected: string[] } {
    if (group === "core") return { changed: false, affected: [] };
    const affected: string[] = [];
    if (on) this.active.add(group);
    else this.active.delete(group);
    for (const [name, g] of this.toolGroup) {
      if (g !== group) continue;
      const h = this.handles.get(name);
      if (!h) continue;
      if (on) h.enable();
      else h.disable();
      affected.push(name);
    }
    return { changed: affected.length > 0, affected };
  }

  activeGroups(): string[] {
    return ["core", ...this.active];
  }
}
