//! Build the argument vector for a headless `opencode run`, plus the capture
//! rules for its JSON event stream.
//!
//! Shape (verified against opencode 1.14.46 — every flag below was checked
//! against the real binary, not the docs):
//!
//! ```text
//! opencode run \
//!            --format json [--pure] \
//!            [-m provider/model] [--variant <effort>] [-s <SESSION_ID>] \
//!            [--agent <agent-id> | --dangerously-skip-permissions]
//! ```
//!
//! (the prompt arrives on stdin — `opencode run` reads piped stdin when no
//! positional message is given)
//!
//! Four things are load-bearing and easy to get wrong:
//!
//! 1. **The prompt is stdin, not argv.** `run [message..]` defaults to `[]` and
//!    when no positional is present OpenCode reads the piped stdin as the
//!    message — the same trick the Claude and Codex paths use to keep huge,
//!    quote-laden prompts off the command line.
//!
//! 2. **The MCP server and the read-only agent live in a config file, not the
//!    argv.** `run` has no `--mcp-config`/`--config` flag (verified in `--help`),
//!    so the app's `opencode.json` is handed to the child via `OPENCODE_CONFIG`
//!    in the spawn environment (see `spawn.rs`) and OpenCode merges it over the
//!    user's own config. The Godot MCP server is registered there (`mcp`
//!    block), and answer-only runs select the `godot-reader` agent defined in
//!    the same file — a tool set with no `write`/`edit` and `deny` permissions
//!    for shell/network, so the Ask box physically cannot change the project.
//!
//! 3. **Non-interactive by design.** Without `--dangerously-skip-permissions`
//!    an unhandled permission request in a non-TTY run is *auto-rejected*, not
//!    prompted (verified in the CLI source: `run` replies `reject` to every
//!    `permission.asked` when not in auto mode). Studio has its own
//!    checkpoints/Undo recovery, so full runs pass the flag; read-only runs
//!    omit it and let the deny rules + auto-reject stand between the agent and
//!    anything destructive.
//!
//! 4. **`--variant` is the reasoning-effort flag** (provider-specific, e.g.
//!    `high`, `max`, `minimal`); `-s` resumes an existing session. There is no
//!    per-run turn cap, so `max_turns` is ignored for this backend (same as
//!    Codex — the loop's iteration cap is the guard).

use crate::agent::flags::FlagInput;
use crate::store::settings::Settings;

/// Name of the read-only agent defined in the app's `opencode.json`. Answer-only
/// runs (`ask_project_map`) select it with `--agent`; full runs use OpenCode's
/// default agent with the Godot MCP server attached.
pub const READ_ONLY_AGENT: &str = "godot-reader";

/// Assemble the full argv (everything after the `opencode` program name).
pub fn build_args(settings: &Settings, input: &FlagInput) -> Vec<String> {
    let mut args: Vec<String> = vec!["run".into(), "--format".into(), "json".into()];

    // External plugins can inject tools/behavior into our headless runs; OpenCode
    // disables them with `--pure`.
    args.push("--pure".into());

    if input.read_only {
        // The ask agent strips write/edit and denies bash/web/webfetch/question.
        // No `--dangerously-skip-permissions`: whatever the deny rules miss is
        // auto-rejected non-interactively rather than prompted.
        args.push("--agent".into());
        args.push(READ_ONLY_AGENT.into());
    } else {
        // A headless approval prompt has no usable UI and would look like a
        // frozen task. Studio owns recovery through checkpoints, Godot Undo,
        // snapshots and the action log, so runs are non-interactive.
        args.push("--dangerously-skip-permissions".into());
    }

    if let Some(model) =
        crate::agent::flags::effective_model(settings, input, crate::agent::Backend::Opencode)
    {
        args.push("-m".into());
        args.push(model.to_string());
    }

    if let Some(effort) =
        crate::agent::flags::effective_effort(settings, input, crate::agent::Backend::Opencode)
    {
        args.push("--variant".into());
        args.push(effort.to_string());
    }

    if let Some(sid) = input.resume_session_id.filter(|s| !s.is_empty()) {
        args.push("-s".into());
        args.push(sid.to_string());
    }

    args
}

/// Pull the fields we need off one OpenCode stream line into the shared capture.
///
/// OpenCode's vocabulary, normalized onto the same [`ExitInfo`](crate::agent::ExitInfo)
/// the other backends produce:
///   - any event's top-level `sessionID` → the session id we pass back to `-s`
///   - `text` → the turn's running answer (`>>>` changed to `>>` because text
///     events arrive as finished-part-sized chunks and must be appended, not
///     replaced)
///   - `step_finish` → the run produced a real result (+ USD cost + tokens)
///   - `error` → the run failed (message at `error.data.message` or `error.name`)
pub fn capture(c: &mut super::spawn::Captured, v: &serde_json::Value) {
    if let Some(sid) = v.get("sessionID").and_then(|s| s.as_str()) {
        if !sid.is_empty() {
            c.session_id = Some(sid.to_string());
        }
    }

    match v.get("type").and_then(|t| t.as_str()) {
        Some("text") => {
            if let Some(text) = v
                .get("part")
                .and_then(|p| p.get("text"))
                .and_then(|t| t.as_str())
            {
                let current = c.result_text.take();
                let mut next = current.unwrap_or_default();
                next.push_str(text);
                c.result_text = Some(next);
            }
        }
        Some("step_finish") => {
            c.result_seen = true;
            if let Some(cost) = v
                .get("part")
                .and_then(|p| p.get("cost"))
                .and_then(|c| c.as_f64())
            {
                // One `step_finish` per step, including tool-call steps, so the
                // turn's spend is the sum — not just the last step's.
                // Some(0.0) stays an honestly free turn (free tier models);
                // only an absent cost means "we can't price this".
                c.cost_usd = Some(c.cost_usd.unwrap_or(0.0) + cost);
            }
            if let Some(tokens) = v
                .get("part")
                .and_then(|p| p.get("tokens"))
                .and_then(|t| t.as_object())
            {
                let get = |k: &str| tokens.get(k).and_then(|n| n.as_u64()).unwrap_or(0);
                let mut total = 0u64;
                for key in ["input", "output", "reasoning"] {
                    total = total.saturating_add(get(key));
                }
                if let Some(cache) = tokens.get("cache").and_then(|t| t.as_object()) {
                    for key in ["read", "write"] {
                        total = total.saturating_add(cache.get(key).and_then(|n| n.as_u64()).unwrap_or(0));
                    }
                }
                if total > 0 {
                    c.tokens = Some(c.tokens.unwrap_or(0) + total);
                }
            }
        }
        Some("error") => {
            c.is_error = true;
            let message = v
                .get("error")
                .and_then(|e| e.get("data"))
                .and_then(|d| d.get("message"))
                .and_then(|m| m.as_str())
                .or_else(|| v.get("error").and_then(|e| e.get("name")).and_then(|n| n.as_str()))
                .or_else(|| v.get("message").and_then(|m| m.as_str()));
            if let Some(message) = message {
                let message = message.to_string();
                c.result_text = Some(message.clone());
                c.error_text = Some(message);
            }
        }
        _ => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent::spawn::Captured;
    use crate::agent::Backend;

    fn entry() -> &'static crate::mcpconfig::McpEntry {
        static ENTRY: std::sync::OnceLock<crate::mcpconfig::McpEntry> = std::sync::OnceLock::new();
        ENTRY.get_or_init(|| crate::mcpconfig::McpEntry {
            command: "/usr/local/bin/node".into(),
            args: vec!["/opt/gvibe.cjs".into(), "serve".into()],
            project: "/Users/x/Game".into(),
        })
    }

    fn settings(model: Option<&str>) -> Settings {
        let mut s = Settings {
            agent_backend: Backend::Opencode,
            ..Settings::default()
        };
        s.opencode_model = model.map(str::to_string);
        s
    }

    fn args_for(model: Option<&str>, resume: Option<&str>) -> Vec<String> {
        build_args(
            &settings(model),
            &FlagInput {
                mcp_config_path: std::path::Path::new("/unused.json"),
                mcp_entry: entry(),
                resume_session_id: resume,
                max_turns: Some(60),
                run_options: None,
                read_only: false,
            },
        )
    }

    fn base() -> FlagInput<'static> {
        FlagInput {
            mcp_config_path: std::path::Path::new("/unused.json"),
            mcp_entry: entry(),
            resume_session_id: None,
            max_turns: None,
            run_options: None,
            read_only: false,
        }
    }

    #[test]
    fn a_full_run_is_json_non_interactive_and_pure() {
        let args = args_for(None, None);
        assert_eq!(args[0], "run");
        assert!(args.contains(&"--format".to_string()));
        assert!(args.contains(&"json".to_string()));
        assert!(args.contains(&"--pure".to_string()));
        assert!(args
            .iter()
            .any(|a| a == "--dangerously-skip-permissions"));
        assert!(!args.iter().any(|a| a == "--agent"));
        // The prompt comes from stdin — nothing else arrives on the command line.
        assert!(!args.iter().any(|a| a.contains('\n')));
    }

    #[test]
    fn an_answer_only_run_selects_the_read_only_agent() {
        let args = build_args(
            &settings(None),
            &FlagInput {
                read_only: true,
                ..base()
            },
        );
        let agent = args.iter().position(|a| a == "--agent").unwrap();
        assert_eq!(args[agent + 1], "godot-reader");
        // No blanket skip: deny rules + non-interactive auto-reject are the gate.
        assert!(!args.iter().any(|a| a == "--dangerously-skip-permissions"));
    }

    #[test]
    fn model_effort_and_resume_are_emitted_when_set() {
        let mut s = settings(Some("opencode/big-pickle"));
        s.opencode_effort = Some("high".into());

        let args = build_args(
            &s,
            &FlagInput {
                resume_session_id: Some("ses_abc"),
                run_options: None,
                ..base()
            },
        );
        let m = args.iter().position(|a| a == "-m").unwrap();
        assert_eq!(args[m + 1], "opencode/big-pickle");
        let v = args.iter().position(|a| a == "--variant").unwrap();
        assert_eq!(args[v + 1], "high");
        let s = args.iter().position(|a| a == "-s").unwrap();
        assert_eq!(args[s + 1], "ses_abc");

        // A Claude model set for the other backend must not leak in.
        let args = args_for(None, None);
        assert!(!args.iter().any(|a| a == "-m"));
    }

    #[test]
    fn max_turns_is_not_a_run_flag_for_opencode() {
        let args = build_args(
            &settings(None),
            &FlagInput {
                max_turns: Some(12),
                ..base()
            },
        );
        assert!(!args.iter().any(|a| a == "--max-turns"));
    }

    #[test]
    fn captures_session_id_text_cost_and_errors() {
        let mut c = Captured::default();

        capture(
            &mut c,
            &serde_json::json!({
                "type": "step_start", "sessionID": "ses_1",
                "part": {"type": "step-start"}
            }),
        );
        assert_eq!(c.session_id.as_deref(), Some("ses_1"));

        capture(
            &mut c,
            &serde_json::json!({
                "type": "text", "sessionID": "ses_1",
                "part": {"type": "text", "text": "Hello"}
            }),
        );
        capture(
            &mut c,
            &serde_json::json!({
                "type": "text", "sessionID": "ses_1",
                "part": {"type": "text", "text": ", world"}
            }),
        );
        assert_eq!(c.result_text.as_deref(), Some("Hello, world"));

        capture(
            &mut c,
            &serde_json::json!({
                "type": "step_finish", "sessionID": "ses_1",
                "part": {
                    "type": "step-finish", "reason": "stop", "cost": 0.42,
                    "tokens": {"input": 10, "output": 5, "reasoning": 2,
                               "cache": {"read": 3, "write": 1}}
                }
            }),
        );
        assert!(c.result_seen);
        assert!(!c.is_error);
        assert_eq!(c.cost_usd, Some(0.42));
        assert_eq!(c.tokens, Some(21));

        let mut f = Captured::default();
        capture(
            &mut f,
            &serde_json::json!({
                "type": "error",
                "sessionID": "ses_1",
                "error": {"name": "UserError", "data": {"message": "boom"}}
            }),
        );
        assert!(f.is_error);
        assert_eq!(f.result_text.as_deref(), Some("boom"));
        assert_eq!(f.error_text.as_deref(), Some("boom"));

        let mut name_only = Captured::default();
        capture(
            &mut name_only,
            &serde_json::json!({
                "type": "error", "error": {"name": "ProviderError"}
            }),
        );
        assert!(name_only.is_error);
        assert_eq!(name_only.error_text.as_deref(), Some("ProviderError"));
    }

    #[test]
    fn cost_and_tokens_accumulate_across_steps() {
        let mut c = Captured::default();
        capture(
            &mut c,
            &serde_json::json!({
                "type": "step_finish",
                "part": {"cost": 0.1, "tokens": {"input": 10, "output": 1}}
            }),
        );
        capture(
            &mut c,
            &serde_json::json!({
                "type": "step_finish",
                "part": {"cost": 0.2, "tokens": {"input": 20, "output": 2}}
            }),
        );
        let cost = c.cost_usd.expect("cost");
        assert!((cost - 0.3).abs() < 1e-9, "{cost}");
        assert_eq!(c.tokens, Some(33));
    }

    #[test]
    fn cost_zero_is_recorded_so_the_loop_cap_is_not_silently_defeated() {
        let mut c = Captured::default();
        capture(
            &mut c,
            &serde_json::json!({
                "type": "step_finish",
                "part": {"type": "step-finish", "reason": "stop", "cost": 0.0}
            }),
        );
        assert_eq!(c.cost_usd, Some(0.0));
    }
}