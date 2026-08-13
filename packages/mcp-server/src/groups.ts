export interface ToolGroupMeta { name: string; description: string; defaultActive: boolean }

export const TOOL_GROUPS: ToolGroupMeta[] = [
  { name: "core", description: "Orientation, scenes, nodes, resources, captures, project map, batching, and verification.", defaultActive: true },
  { name: "scripting", description: "Read, hash, search, create, and edit Godot text resources.", defaultActive: true },
  { name: "reflection", description: "Live ClassDB anti-hallucination queries.", defaultActive: true },
  { name: "runtime", description: "Run/stop the project and inspect play status.", defaultActive: true },
];
const GROUPS: Record<string, string> = {
  godot_read_script: "scripting", godot_get_script_sha: "scripting", godot_find_in_file: "scripting",
  godot_create_script: "scripting", godot_apply_text_edits: "scripting", godot_reflect: "reflection",
  godot_run_project: "runtime", godot_stop_project: "runtime", godot_get_play_status: "runtime",
};
export function groupOf(name: string): string { return GROUPS[name] ?? "core"; }
export function defaultActiveGroups(): Set<string> { return new Set(TOOL_GROUPS.filter((group) => group.defaultActive).map((group) => group.name)); }
export function isKnownGroup(name: string): boolean { return TOOL_GROUPS.some((group) => group.name === name); }
export interface ToolHandle { enable(): void; disable(): void }
export class ToolGroupController {
  private active: Set<string>; private handles = new Map<string, ToolHandle>(); private groups = new Map<string, string>();
  constructor(active: Set<string>) { this.active = active; }
  register(name: string, handle: ToolHandle): void { const group = groupOf(name); this.handles.set(name, handle); this.groups.set(name, group); if (group !== "core" && !this.active.has(group)) handle.disable(); }
  list() { return TOOL_GROUPS.map((group) => ({ ...group, active: group.name === "core" || this.active.has(group.name), toolCount: [...this.groups.values()].filter((value) => value === group.name).length })); }
  setActive(group: string, on: boolean) { if (group === "core") return { changed: false, affected: [] as string[] }; if (on) this.active.add(group); else this.active.delete(group); const affected: string[] = []; for (const [name, value] of this.groups) { if (value !== group) continue; const handle = this.handles.get(name); if (!handle) continue; on ? handle.enable() : handle.disable(); affected.push(name); } return { changed: affected.length > 0, affected }; }
  activeGroups(): string[] { return ["core", ...this.active].filter((value, index, all) => all.indexOf(value) === index); }
}
