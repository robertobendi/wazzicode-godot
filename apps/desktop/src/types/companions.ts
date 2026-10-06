// Mirrors `PyriteStatus` in src-tauri/src/commands/companions.rs.

/** Where the Pyrite launcher came from: linked in Settings, the `PYRITE_MCP`
 *  env var, or Pyrite's own registration file (`~/Pyrite/mcp-entry.json`). */
export type PyriteSource = "linked" | "env" | "discovered";

export interface PyriteStatus {
  enabled: boolean;
  found: boolean;
  source: PyriteSource | null;
  /** The `pyrite.mjs` bundle agent runs start. */
  script: string | null;
  version: string | null;
  linkedPath: string | null;
  /** Why it wasn't found, in words the user can act on. */
  problem: string | null;
  /** Pyrite's daemon answers right now (its editor or a job is live). */
  running: boolean;
}
