// Mirrors the Rust `Settings` struct in
// src-tauri/src/store/settings.rs (serde camelCase). Keep the two in sync.

import type { AgentBackend } from "./agent";

export type {
  AgentBackend,
  AgentModelOption,
  AgentRunOptions,
} from "./agent";

export type ThemeChoice = "system" | "light" | "dark";

export interface Settings {
  schemaVersion: number;
  recentProjects: string[];
  currentProject: string | null;
  /** Which CLI runs the work: Claude Code or the Codex CLI. */
  agentBackend: AgentBackend;
  /** Preferred Claude model id, or null to let the CLI decide. */
  model: string | null;
  /** Preferred Codex model id, or null to let the CLI decide. Separate from
   *  `model` so switching backends can't hand a Claude model id to Codex. */
  codexModel: string | null;
  /** Preferred Claude reasoning effort, or null to let the CLI decide. */
  effort: string | null;
  /** Preferred Codex reasoning effort, kept separate because its supported
   *  values are model-specific. */
  codexEffort: string | null;
  /** Internal provenance for defaults that track installed CLI catalogs. */
  modelFollowsCatalog?: boolean;
  effortFollowsModel?: boolean;
  codexModelFollowsCatalog?: boolean;
  codexEffortFollowsModel?: boolean;
  /** Color scheme for the UI; "system" follows the OS. */
  theme: ThemeChoice;
  /** Show the raw stream / debug drawer in the UI. */
  debugDrawer: boolean;
  /** Set true after the first successful Claude pair/verify (skips the gate). */
  pairedOk: boolean;
  /** Set true once the onboarding wizard completes ("Redo setup" clears it). */
  onboarded: boolean;
}

/** Per-backend presentation + capabilities. One place, so copy stays consistent
 *  and "does this backend report cost?" is never re-derived ad hoc in the UI. */
export const BACKENDS: Record<
  AgentBackend,
  { label: string; blurb: string; cli: string; reportsCost: boolean }
> = {
  claude: {
    label: "Claude Code",
    blurb:
      "Anthropic. Streams its answer as it writes, and reports the cost of each turn.",
    cli: "claude",
    reportsCost: true,
  },
  codex: {
    label: "ChatGPT Codex",
    blurb:
      "OpenAI. Uses your ChatGPT plan — never API credits. Reports tokens rather than cost.",
    cli: "codex",
    reportsCost: false,
  },
};
