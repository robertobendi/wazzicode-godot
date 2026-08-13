/** Which coding agent drives runs. Mirrors Rust's `agent::Backend`. */
export type AgentBackend = "claude" | "codex";

/** Backend controls captured when a chat or Auto-mode task starts. */
export interface AgentRunOptions {
  backend: AgentBackend;
  /** null delegates model selection to the CLI. */
  model: string | null;
  /** null delegates reasoning effort to the CLI. */
  effort: string | null;
}

/** One model reported by the selected CLI's model catalog. */
export interface AgentModelOption {
  id: string;
  label: string;
  description: string | null;
  defaultEffort: string | null;
  efforts: string[];
}
