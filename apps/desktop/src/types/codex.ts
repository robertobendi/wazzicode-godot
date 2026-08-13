// Mirrors the Rust types in src-tauri/src/codexauth.rs (serde camelCase).
//
// Credentials live with the Codex CLI (`~/.codex/auth.json`); the app never sees
// or stores a token — it only asks the CLI whether it's signed in, and drives
// `codex login` when it isn't.

export interface CodexAuthStatus {
  /** Is the `codex` binary on PATH at all? */
  installed: boolean;
  loggedIn: boolean;
  /** CLI status or an actionable explanation for an incompatible login mode. */
  detail: string | null;
}

export type CodexLoginPhase =
  | "starting"
  | "awaiting_browser"
  | "success"
  | "failed"
  | "cancelled";

/** Payload of the `codex:login` event. */
export interface CodexLoginUpdate {
  phase: CodexLoginPhase;
  /** The ChatGPT sign-in URL, once the CLI prints it. */
  url: string | null;
  error: string | null;
}
