// Quick actions — one-tap starter prompts shown above the composer.
//
// These built-in defaults are the source of truth for the UI's instant,
// offline render; a project can override them with a
// `.godot-vibe/quick_actions.json` file, read by the `read_quick_actions`
// Rust command (whose defaults mirror the ones below).

export interface QuickAction {
  label: string;
  prompt: string;
}

/** The built-in starter prompts. Kept in sync with commands/quick_actions.rs. */
export const DEFAULT_QUICK_ACTIONS: QuickAction[] = [
  {
    label: "Verify the project",
    prompt:
      "Run godot_verify and fix every import or GDScript failure. If res://tests/run_tests.gd exists, run godot_test_run too and report its independent result. Never present import/syntax success as passing tests.",
  },
  {
    label: "Map the active scene",
    prompt:
      "Inspect the open scenes and active scene tree, then explain the important node branches, attached scripts, and resource dependencies.",
  },
  {
    label: "Improve what I selected",
    prompt:
      "Inspect the selected Godot node and the relevant 2D or 3D viewport. Improve the selection for clarity and maintainability, preserve intentional behavior, save the scene, and show what changed.",
  },
];

/**
 * Coerce an untrusted value (a parsed override file, or a backend response)
 * into a usable action list: keep only well-formed `{label, prompt}` entries
 * with non-empty text, and fall back to the defaults when nothing valid
 * remains. Never throws — a bad override quietly yields the defaults.
 */
export function coerceQuickActions(value: unknown): QuickAction[] {
  if (!Array.isArray(value)) return DEFAULT_QUICK_ACTIONS;
  const cleaned: QuickAction[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const { label, prompt } = item as Record<string, unknown>;
    if (typeof label !== "string" || typeof prompt !== "string") continue;
    if (!label.trim() || !prompt.trim()) continue;
    cleaned.push({ label, prompt });
  }
  return cleaned.length > 0 ? cleaned : DEFAULT_QUICK_ACTIONS;
}
