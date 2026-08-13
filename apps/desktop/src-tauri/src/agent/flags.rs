//! Build the argument vector for a headless agent run.
//!
//! [`build_args`] dispatches on the selected [`Backend`]: the Claude builder
//! lives here (verified against Claude Code CLI 2.1.209), the Codex one in
//! [`crate::agent::codex`]. Neither passes the prompt as an argument — it's
//! written to the child's stdin (see `spawn.rs`).

use crate::agent::AgentRunOptions;
use crate::agent::Backend;
use crate::mcpconfig::McpEntry;
use crate::store::settings::Settings;
use std::path::Path;

/// Per-run inputs, distinct from the persisted `Settings`. Carries the MCP
/// server in both renderings because the backends consume it differently:
/// Claude reads the JSON file, Codex takes TOML `-c` overrides built from the
/// entry. Both describe the same server (see `mcpconfig`).
pub struct FlagInput<'a> {
    /// App-managed `--mcp-config` file (Claude).
    pub mcp_config_path: &'a Path,
    /// The same server as a backend-neutral entry (Codex).
    pub mcp_entry: &'a McpEntry,
    /// Continue an existing agent session (multi-turn chat) when set.
    pub resume_session_id: Option<&'a str>,
    /// Cap on agent turns for this run — the auto-loop sets it, chat doesn't.
    /// Claude enforces it with `--max-turns`; Codex has no equivalent flag and
    /// ignores it (its runs are bounded by the loop's iteration cap instead).
    pub max_turns: Option<u32>,
    /// Explicit per-task controls. `Some` wins over persisted defaults, even
    /// when its model/effort is Automatic (`None`).
    pub run_options: Option<&'a AgentRunOptions>,
    /// Answer-only run (the project map's Ask box): the agent may read the
    /// project but must not change it. Enforced by the CLI, not by asking
    /// nicely — Claude gets a read-only `--allowedTools` list, Codex gets an
    /// OS-level read-only sandbox and no MCP server.
    pub read_only: bool,
}

/// Tools we hand Claude. `--allowedTools` is variadic (`<tools...>`), so each
/// entry is pushed as its own argv element after the flag. `mcp__unity-vibe-os`
/// (no `__tool` suffix) whitelists every tool exposed by that MCP server, so
/// Claude can drive Unity without us enumerating all 60-odd `unity_*` tools.
/// Studio runs these tools non-interactively; checkpoints and project-level
/// guards provide recovery without leaving a hidden approval prompt behind.
const ALLOWED_TOOLS: &[&str] = &[
    "Bash",
    "Read",
    "Glob",
    "Grep",
    "Edit",
    "Write",
    "MultiEdit",
    "TodoWrite",
    "WebFetch",
    "WebSearch",
    "mcp__unity-vibe-os",
];

/// Tools for an answer-only run. Every one of these reads; none of them writes,
/// runs a shell, or reaches the Unity bridge. Whitelisting is the enforcement —
/// a tool absent from `--allowedTools` cannot be called at all, so the question
/// box physically cannot edit the project even if the model decides to try.
const READ_ONLY_TOOLS: &[&str] = &["Read", "Glob", "Grep"];

/// Assemble the full argv (everything after the program name) for `backend`.
pub fn build_args(backend: Backend, settings: &Settings, input: &FlagInput) -> Vec<String> {
    match backend {
        Backend::Claude => build_claude_args(settings, input),
        Backend::Codex => crate::agent::codex::build_args(settings, input),
    }
}

fn build_claude_args(settings: &Settings, input: &FlagInput) -> Vec<String> {
    let mut args: Vec<String> = vec![
        "-p".into(),
        "--output-format".into(),
        "stream-json".into(),
        "--verbose".into(),
        "--include-partial-messages".into(),
    ];

    // Studio is a task-running application, not an approval console. Its own
    // checkpoint/Undo/action-log safety remains active, while the headless CLI
    // runs without interactive permission prompts that cannot be answered from
    // the app UI.
    args.push("--permission-mode".into());
    args.push("bypassPermissions".into());

    // Variadic: flag once, then one arg per tool. The next token is a `--`
    // flag, which stops the collection.
    args.push("--allowedTools".into());
    let tools = if input.read_only {
        READ_ONLY_TOOLS
    } else {
        ALLOWED_TOOLS
    };
    for tool in tools {
        args.push((*tool).to_string());
    }

    // App-managed MCP config, and *only* that config — `--strict-mcp-config`
    // ignores any project `.mcp.json`, so machine-specific paths never leak
    // into the game repo and no interactive server-approval is needed. An
    // answer-only run gets no MCP server at all: nothing in its tool list could
    // call one, and leaving it out means the Unity bridge is never touched.
    if !input.read_only {
        args.push("--mcp-config".into());
        args.push(input.mcp_config_path.to_string_lossy().into_owned());
        args.push("--strict-mcp-config".into());
    }

    if let Some(model) = effective_model(settings, input, Backend::Claude) {
        args.push("--model".into());
        args.push(model.to_string());
    }

    if let Some(effort) = effective_effort(settings, input, Backend::Claude) {
        args.push("--effort".into());
        args.push(effort.to_string());
    }

    if let Some(sid) = input.resume_session_id.filter(|s| !s.is_empty()) {
        args.push("--resume".into());
        args.push(sid.to_string());
    }

    if let Some(max) = input.max_turns {
        args.push("--max-turns".into());
        args.push(max.to_string());
    }

    args
}

pub(crate) fn effective_model<'a>(
    settings: &'a Settings,
    input: &'a FlagInput<'a>,
    backend: Backend,
) -> Option<&'a str> {
    match input.run_options {
        Some(options) => options.model(),
        None => settings.model_for(backend),
    }
}

pub(crate) fn effective_effort<'a>(
    settings: &'a Settings,
    input: &'a FlagInput<'a>,
    backend: Backend,
) -> Option<&'a str> {
    match input.run_options {
        Some(options) => options.effort(),
        None => settings.effort_for(backend),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn entry() -> McpEntry {
        McpEntry {
            command: "node".into(),
            args: vec!["/opt/uvibe.cjs".into(), "serve".into()],
            project: "/Users/x/Game".into(),
        }
    }

    fn claude_args(
        settings: &Settings,
        resume: Option<&str>,
        max_turns: Option<u32>,
    ) -> Vec<String> {
        let cfg = PathBuf::from("/tmp/mcp.json");
        build_args(
            Backend::Claude,
            settings,
            &FlagInput {
                mcp_config_path: &cfg,
                mcp_entry: &entry(),
                resume_session_id: resume,
                max_turns,
                run_options: None,
                read_only: false,
            },
        )
    }

    #[test]
    fn includes_core_flags_and_variadic_tools() {
        let args = claude_args(&Settings::default(), None, None);
        assert!(args.contains(&"stream-json".to_string()));
        assert!(args.contains(&"--include-partial-messages".to_string()));
        assert!(args.contains(&"--strict-mcp-config".to_string()));
        // Variadic tools each present as their own arg.
        assert!(args.contains(&"mcp__unity-vibe-os".to_string()));
        assert!(args.contains(&"Read".to_string()));
        // App-managed runs never stop for an invisible permission prompt.
        let i = args.iter().position(|a| a == "--permission-mode").unwrap();
        assert_eq!(args[i + 1], "bypassPermissions");
        let model = args.iter().position(|a| a == "--model").unwrap();
        assert_eq!(args[model + 1], "opus");
        let effort = args.iter().position(|a| a == "--effort").unwrap();
        assert_eq!(args[effort + 1], "max");
        // No resume / turn cap when unset.
        assert!(!args.contains(&"--resume".to_string()));
        assert!(!args.contains(&"--max-turns".to_string()));
    }

    #[test]
    fn an_answer_only_claude_run_cannot_reach_a_write_tool() {
        let cfg = PathBuf::from("/tmp/mcp.json");
        let args = build_args(
            Backend::Claude,
            &Settings::default(),
            &FlagInput {
                mcp_config_path: &cfg,
                mcp_entry: &entry(),
                resume_session_id: None,
                max_turns: Some(12),
                run_options: None,
                read_only: true,
            },
        );
        assert!(args.contains(&"Read".to_string()));
        assert!(args.contains(&"Grep".to_string()));
        for forbidden in ["Edit", "Write", "MultiEdit", "Bash", "mcp__unity-vibe-os"] {
            assert!(
                !args.contains(&forbidden.to_string()),
                "{forbidden} must not be reachable from an answer-only run"
            );
        }
        // No MCP server either, so the Unity bridge is never touched.
        assert!(!args.contains(&"--mcp-config".to_string()));
        assert!(!args.contains(&"--strict-mcp-config".to_string()));
    }

    #[test]
    fn resumed_runs_keep_non_interactive_permissions() {
        let args = claude_args(&Settings::default(), Some("sess-123"), None);
        let i = args.iter().position(|a| a == "--permission-mode").unwrap();
        assert_eq!(args[i + 1], "bypassPermissions");
        let r = args.iter().position(|a| a == "--resume").unwrap();
        assert_eq!(args[r + 1], "sess-123");
    }

    #[test]
    fn model_appended_when_set() {
        let s = Settings {
            model: Some("claude-opus-4-8".into()),
            ..Settings::default()
        };
        let args = claude_args(&s, None, None);
        let m = args.iter().position(|a| a == "--model").unwrap();
        assert_eq!(args[m + 1], "claude-opus-4-8");
    }

    #[test]
    fn max_turns_caps_loop_runs() {
        let args = claude_args(&Settings::default(), None, Some(60));
        let i = args.iter().position(|a| a == "--max-turns").unwrap();
        assert_eq!(args[i + 1], "60");
    }

    #[test]
    fn dispatches_to_codex_when_selected() {
        let s = Settings {
            agent_backend: Backend::Codex,
            ..Settings::default()
        };
        let cfg = PathBuf::from("/tmp/mcp.json");
        let args = build_args(
            Backend::Codex,
            &s,
            &FlagInput {
                mcp_config_path: &cfg,
                mcp_entry: &entry(),
                resume_session_id: None,
                max_turns: Some(60),
                run_options: None,
                read_only: false,
            },
        );
        assert_eq!(args[0], "exec");
        assert!(args.contains(&"--json".to_string()));
        // Claude-only flags must never reach Codex.
        assert!(!args.contains(&"--mcp-config".to_string()));
        assert!(!args.contains(&"--max-turns".to_string()));
    }

    #[test]
    fn per_task_model_and_effort_override_defaults() {
        let settings = Settings {
            model: Some("opus".into()),
            effort: Some("low".into()),
            ..Settings::default()
        };
        let run = AgentRunOptions {
            backend: Backend::Claude,
            model: Some("sonnet".into()),
            effort: Some("high".into()),
        };
        let cfg = PathBuf::from("/tmp/mcp.json");
        let args = build_args(
            Backend::Claude,
            &settings,
            &FlagInput {
                mcp_config_path: &cfg,
                mcp_entry: &entry(),
                resume_session_id: Some("session-1"),
                max_turns: None,
                run_options: Some(&run),
                read_only: false,
            },
        );
        let model = args.iter().position(|a| a == "--model").unwrap();
        let effort = args.iter().position(|a| a == "--effort").unwrap();
        assert_eq!(args[model + 1], "sonnet");
        assert_eq!(args[effort + 1], "high");
    }

    #[test]
    fn every_documented_claude_effort_is_emitted_verbatim() {
        let cfg = PathBuf::from("/tmp/mcp.json");
        for effort in ["low", "medium", "high", "xhigh", "max"] {
            let run = AgentRunOptions {
                backend: Backend::Claude,
                model: Some("opus".into()),
                effort: Some(effort.into()),
            };
            let args = build_args(
                Backend::Claude,
                &Settings::default(),
                &FlagInput {
                    mcp_config_path: &cfg,
                    mcp_entry: &entry(),
                    resume_session_id: Some("session-1"),
                    max_turns: None,
                    run_options: Some(&run),
                    read_only: false,
                },
            );
            let index = args.iter().position(|arg| arg == "--effort").unwrap();
            assert_eq!(args[index + 1], effort);
        }
    }

    #[test]
    fn explicit_automatic_ignores_persisted_defaults() {
        let settings = Settings {
            model: Some("opus".into()),
            effort: Some("max".into()),
            ..Settings::default()
        };
        let run = AgentRunOptions {
            backend: Backend::Claude,
            model: None,
            effort: None,
        };
        let cfg = PathBuf::from("/tmp/mcp.json");
        let args = build_args(
            Backend::Claude,
            &settings,
            &FlagInput {
                mcp_config_path: &cfg,
                mcp_entry: &entry(),
                resume_session_id: None,
                max_turns: None,
                run_options: Some(&run),
                read_only: false,
            },
        );
        assert!(!args.iter().any(|a| a == "--model" || a == "--effort"));
    }
}
