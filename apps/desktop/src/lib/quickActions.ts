// Quick actions — one-tap starter prompts shown above the composer.
//
// These built-in defaults are the source of truth for the UI's instant,
// offline render; a project can override them with a
// `.unity-vibe/quick_actions.json` file, read by the `read_quick_actions`
// Rust command (whose defaults mirror the ones below).

export interface QuickAction {
  label: string;
  prompt: string;
}

/** The built-in starter prompts. Kept in sync with commands/quick_actions.rs. */
export const DEFAULT_QUICK_ACTIONS: QuickAction[] = [
  {
    label: "Fix whatever's broken",
    prompt:
      "Run unity_qa, fix every actionable failure it finds, then rerun the full gate until it passes.",
  },
  {
    label: "Screenshot tour",
    prompt:
      "Open each scene in the project, capture a game-view screenshot of each, and summarize what's in them.",
  },
  {
    label: "Tidy the scene",
    prompt:
      "Look at the current scene hierarchy and tidy it: group loose objects under sensible parents, fix obvious naming, and report what you changed.",
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
