//! Which coding agent drives a run.
//!
//! The two backends are deliberately kept behind one enum rather than a trait:
//! the differences are narrow (binary name, argv, the JSON vocabulary on stdout)
//! and a trait would spread them across more indirection than they're worth.
//!
//! Everything downstream of the spawn — the chat store, the tool timeline, the
//! loop runner — is backend-agnostic, because both CLIs are normalized onto the
//! same `ExitInfo` in Rust and the same `StreamDraft` in the webview.

use serde::{Deserialize, Serialize};

/// The coding agent the user has selected. Persisted in `settings.json` as
/// `agentBackend: "claude" | "codex"`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Backend {
    /// Anthropic Claude Code — `claude -p --output-format stream-json`.
    #[default]
    Claude,
    /// OpenAI Codex CLI — `codex exec --json`.
    Codex,
}

impl Backend {
    /// The executable we spawn (resolved on PATH by `proc::command`).
    pub fn bin(self) -> &'static str {
        match self {
            Backend::Claude => "claude",
            Backend::Codex => "codex",
        }
    }

    /// Human name, used in user-facing error copy.
    pub fn label(self) -> &'static str {
        match self {
            Backend::Claude => "Claude",
            Backend::Codex => "Codex",
        }
    }

    /// Whether this backend reports a per-turn USD cost. Codex's `turn.completed`
    /// carries token counts but no price, so the auto-loop's cost cap is inert
    /// for it and the iteration cap is the effective guard. Callers surface this
    /// rather than silently pretending a $0 spend.
    pub fn reports_cost(self) -> bool {
        matches!(self, Backend::Claude)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn serializes_lowercase_and_defaults_to_claude() {
        assert_eq!(Backend::default(), Backend::Claude);
        assert_eq!(serde_json::to_string(&Backend::Codex).unwrap(), "\"codex\"");
        let b: Backend = serde_json::from_str("\"claude\"").unwrap();
        assert_eq!(b, Backend::Claude);
    }

    #[test]
    fn only_claude_reports_cost() {
        assert!(Backend::Claude.reports_cost());
        assert!(!Backend::Codex.reports_cost());
    }
}
