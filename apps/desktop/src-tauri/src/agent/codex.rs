//! Build the argument vector for a headless `codex exec` run, plus the capture
//! rules for its JSONL event stream.
//!
//! Shape (verified against codex-cli 0.145.0 — every flag below was checked
//! against the real binary, not the docs):
//!
//! ```text
//! codex exec [resume <SESSION_ID>] \
//!            --ignore-user-config --json --skip-git-repo-check \
//!            --dangerously-bypass-approvals-and-sandbox \
//!            -c mcp_servers.unity_vibe_os.command='…' … \
//!            [--model M] -
//! ```
//!
//! Three things are load-bearing and easy to get wrong:
//!
//! 1. **Flags go AFTER `resume`.** `resume` is a
//!    subcommand of `exec` that *re-declares* `--json`, `--skip-git-repo-check`,
//!    `-m` and `-c` — so those are not clap-global, and copies placed before the
//!    word `resume` would bind to `exec` and be ignored by the resuming code
//!    path. That failure is nasty: a resumed turn would emit no JSONL at all, and
//!    since every chat turn after the first resumes, the whole conversation would
//!    go blank. Emitting each flag in the position the subcommand declares it
//!    sidesteps the question. The non-interactive bypass flag is accepted in this
//!    position by both fresh and resumed runs.
//!
//! 2. **The trailing `-`.** Codex reads the prompt from stdin when the PROMPT
//!    positional is `-`, which is how we avoid putting a (potentially huge,
//!    quote-laden) prompt on the command line — same as the Claude path.
//!
//! 3. **TOML, not JSON.** Codex has no `--mcp-config`; MCP servers come from
//!    `config.toml` or `-c key=value` overrides, where the value is parsed as
//!    TOML. Windows paths (`C:\Users\…`) are therefore a live hazard: in a TOML
//!    *basic* string `\U` is an invalid escape. Verified against the real binary:
//!    `args=["C:\Users\x\uvibe.cjs"]` dies with `invalid type: string, expected a
//!    sequence`, because Codex falls back to treating an unparseable value as a
//!    raw string. We emit *literal* (single-quoted) strings, which have no escape
//!    sequences at all. See [`toml_string`].
//!
//! We use `-c` overrides rather than `codex mcp add` so the user's global
//! `~/.codex/config.toml` is never touched. `--ignore-user-config` prevents a
//! custom provider in that file from redirecting the user's stored OAuth
//! credential; the CLI still reads auth from `CODEX_HOME`. We do not point
//! `CODEX_HOME` at an app-managed dir because that would relocate `auth.json`
//! and lose the user's login.

use crate::agent::flags::FlagInput;
use crate::mcpconfig::McpEntry;
use crate::store::settings::Settings;

/// MCP server name as Codex sees it. Underscores, not the `unity-vibe-os` used
/// in Claude's JSON config: this name becomes a bare key in a dotted `-c` path
/// (`mcp_servers.unity_vibe_os.command`), and a hyphen there would have to be
/// quoted. The webview keys Unity-tool detection off the same constant.
pub const MCP_SERVER_NAME: &str = "unity_vibe_os";

/// Unity work is slow — `unity_verify` waits on a domain reload, a recompile and
/// a test run. Codex's default per-tool MCP timeout is far too tight for that, so
/// we raise it well past the worst realistic call.
const TOOL_TIMEOUT_SECS: u32 = 900;
/// Node + the bundled `uvibe.cjs` cold-start.
const STARTUP_TIMEOUT_SECS: u32 = 30;

/// Assemble the full argv (everything after the `codex` program name).
pub fn build_args(settings: &Settings, input: &FlagInput) -> Vec<String> {
    let mut args: Vec<String> = vec!["exec".into()];

    // Subcommand FIRST: every flag below is declared by BOTH `exec` and `resume`,
    // so emitting them after the subcommand binds them to whichever one is
    // actually running (see module docs — putting them first silently disables
    // `--json` on resumed turns).
    if let Some(sid) = input.resume_session_id.filter(|s| !s.is_empty()) {
        args.push("resume".into());
        args.push(sid.to_string());
    }

    args.push("--ignore-user-config".into());
    args.push("--json".into());
    // Unity projects aren't necessarily git repos; Codex otherwise refuses to run.
    args.push("--skip-git-repo-check".into());

    // Ignore-user-config removes custom providers; these explicit overrides
    // also pin the built-in OpenAI provider to its ChatGPT subscription route.
    // They are emitted after `resume`, so both command forms receive them.
    for value in crate::codexauth::SUBSCRIPTION_CONFIG_OVERRIDES {
        args.push("-c".into());
        args.push((*value).into());
    }

    if input.read_only {
        // Answer-only run: the OS-level sandbox denies every write, so the
        // question box cannot change the project no matter what the model
        // decides to do. `exec` is non-interactive, so a denied write comes
        // back as a failed command rather than a hidden approval prompt.
        args.push("--sandbox".into());
        args.push("read-only".into());
    } else {
        // A headless approval prompt has no usable UI and would look like a
        // frozen task. Studio owns recovery through checkpoints, Unity Undo,
        // snapshots and the action log, so both fresh and resumed runs are
        // non-interactive.
        args.push("--dangerously-bypass-approvals-and-sandbox".into());
    }

    // The MCP server, as TOML overrides — the Codex analogue of Claude's
    // `--mcp-config` + `--strict-mcp-config`. An answer-only run gets none:
    // the sandbox governs shell commands, not MCP calls, so the Unity write
    // tools have to be withheld rather than merely sandboxed.
    if !input.read_only {
        for kv in mcp_overrides(input.mcp_entry) {
            args.push("-c".into());
            args.push(kv);
        }
    }

    if let Some(model) =
        crate::agent::flags::effective_model(settings, input, crate::agent::Backend::Codex)
    {
        args.push("--model".into());
        args.push(model.to_string());
    }

    if let Some(effort) =
        crate::agent::flags::effective_effort(settings, input, crate::agent::Backend::Codex)
    {
        args.push("-c".into());
        args.push(format!("model_reasoning_effort={}", toml_string(effort)));
    }

    // Prompt arrives on stdin.
    args.push("-".into());

    args
}

/// The `-c` values that register the uvibe MCP server for this run.
fn mcp_overrides(entry: &McpEntry) -> Vec<String> {
    let p = format!("mcp_servers.{MCP_SERVER_NAME}");
    let args_toml = entry
        .args
        .iter()
        .map(|a| toml_string(a))
        .collect::<Vec<_>>()
        .join(", ");
    vec![
        format!("{p}.command={}", toml_string(&entry.command)),
        format!("{p}.args=[{args_toml}]"),
        format!("{p}.env.UVIBE_PROJECT={}", toml_string(&entry.project)),
        format!("{p}.startup_timeout_sec={STARTUP_TIMEOUT_SECS}"),
        format!("{p}.tool_timeout_sec={TOOL_TIMEOUT_SECS}"),
    ]
}

/// Render `s` as a TOML string value.
///
/// Prefers a **literal** string (`'…'`), which has no escape sequences — the only
/// safe way to express a Windows path, since `'C:\Users\x'` is exactly those
/// bytes whereas `"C:\Users\x"` is a parse error (`\U` is not a valid escape).
/// Falls back to a basic string, properly escaped, when the value itself contains
/// a single quote (a literal string cannot express one).
fn toml_string(s: &str) -> String {
    if !s.contains('\'') && !s.contains('\n') && !s.contains('\r') {
        return format!("'{s}'");
    }
    let mut out = String::with_capacity(s.len() + 2);
    out.push('"');
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

/// Pull the fields we need off one Codex stream line into the shared capture.
///
/// Codex's vocabulary, normalized onto the same [`ExitInfo`](crate::agent::ExitInfo)
/// the Claude path produces:
///   - `thread.started`   → the session id we pass back to `resume`
///   - `item.completed` (`agent_message`) → the turn's visible answer
///   - `turn.completed`   → the run produced a real result (+ token usage)
///   - `turn.failed` / `error` → the run failed
pub fn capture(c: &mut super::spawn::Captured, v: &serde_json::Value) {
    let Some(ty) = v.get("type").and_then(|t| t.as_str()) else {
        return;
    };
    match ty {
        "thread.started" => {
            // Field name has drifted across Codex builds; accept the known spellings.
            for key in ["thread_id", "session_id", "id"] {
                if let Some(sid) = v.get(key).and_then(|s| s.as_str()) {
                    c.session_id = Some(sid.to_string());
                    break;
                }
            }
        }
        "item.completed" => {
            let item = v.get("item");
            let item_type = item.and_then(|i| i.get("type")).and_then(|t| t.as_str());
            if item_type == Some("agent_message") {
                if let Some(text) = item.and_then(|i| i.get("text")).and_then(|t| t.as_str()) {
                    c.result_text = Some(text.to_string());
                }
            }
        }
        "turn.completed" => {
            c.result_seen = true;
            // Codex reports tokens, not dollars — leave `cost_usd` unset rather
            // than inventing a price. `Backend::reports_cost` tells the UI/loop.
            if let Some(u) = v.get("usage") {
                let get = |k: &str| u.get(k).and_then(|n| n.as_u64()).unwrap_or(0);
                let total = get("input_tokens") + get("output_tokens");
                if total > 0 {
                    c.tokens = Some(c.tokens.unwrap_or(0) + total);
                }
            }
        }
        "turn.failed" => {
            c.result_seen = true;
            c.is_error = true;
            if let Some(msg) = v
                .get("error")
                .and_then(|e| e.get("message"))
                .and_then(|m| m.as_str())
            {
                let message = msg.to_string();
                c.result_text = Some(message.clone());
                c.error_text = Some(message);
            }
        }
        "error" => {
            c.is_error = true;
            if let Some(msg) = v.get("message").and_then(|m| m.as_str()) {
                let message = msg.to_string();
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

    fn entry() -> McpEntry {
        McpEntry {
            command: r"C:\Program Files\studio\node.exe".into(),
            args: vec![r"C:\Program Files\studio\uvibe.cjs".into(), "serve".into()],
            project: r"C:\Users\dev\Unity\MyGame".into(),
        }
    }

    fn settings(model: Option<&str>) -> Settings {
        let mut s = Settings {
            agent_backend: Backend::Codex,
            ..Settings::default()
        };
        s.codex_model = model.map(str::to_string);
        s
    }

    fn args_for(model: Option<&str>, resume: Option<&str>) -> Vec<String> {
        build_args(
            &settings(model),
            &FlagInput {
                mcp_config_path: std::path::Path::new("/unused.json"),
                mcp_entry: &entry(),
                resume_session_id: resume,
                max_turns: Some(60),
                run_options: None,
                read_only: false,
            },
        )
    }

    #[test]
    fn an_answer_only_codex_run_is_sandboxed_and_has_no_mcp_server() {
        let args = build_args(
            &settings(None),
            &FlagInput {
                mcp_config_path: std::path::Path::new("/unused.json"),
                mcp_entry: &entry(),
                resume_session_id: None,
                max_turns: Some(12),
                run_options: None,
                read_only: true,
            },
        );
        let sandbox = args.iter().position(|a| a == "--sandbox").unwrap();
        assert_eq!(args[sandbox + 1], "read-only");
        assert!(!args
            .iter()
            .any(|a| a == "--dangerously-bypass-approvals-and-sandbox"));
        // The sandbox governs shell commands, not MCP — so the Unity tools are
        // withheld outright.
        assert!(!args.iter().any(|a| a.starts_with("mcp_servers.")));
    }

    #[test]
    fn windows_paths_use_literal_toml_strings() {
        // The whole point: a basic string would make `\U` an invalid escape and
        // Codex would fail to parse the override.
        let args = args_for(None, None);
        let cmd = args
            .iter()
            .find(|a| a.starts_with("mcp_servers.unity_vibe_os.command="))
            .expect("command override present");
        assert_eq!(
            cmd,
            r"mcp_servers.unity_vibe_os.command='C:\Program Files\studio\node.exe'"
        );
        assert!(!cmd.contains("\\\\"), "must not escape backslashes: {cmd}");

        let arr = args
            .iter()
            .find(|a| a.starts_with("mcp_servers.unity_vibe_os.args="))
            .unwrap();
        assert_eq!(
            arr,
            r"mcp_servers.unity_vibe_os.args=['C:\Program Files\studio\uvibe.cjs', 'serve']"
        );

        let env = args
            .iter()
            .find(|a| a.starts_with("mcp_servers.unity_vibe_os.env.UVIBE_PROJECT="))
            .unwrap();
        assert_eq!(
            env,
            r"mcp_servers.unity_vibe_os.env.UVIBE_PROJECT='C:\Users\dev\Unity\MyGame'"
        );
    }

    #[test]
    fn value_with_a_quote_falls_back_to_escaped_basic_string() {
        assert_eq!(toml_string("plain"), "'plain'");
        assert_eq!(toml_string(r"C:\a\b"), r"'C:\a\b'");
        // A literal string cannot contain `'`, so we must switch modes.
        assert_eq!(toml_string(r"it's\here"), r#""it's\\here""#);
    }

    #[test]
    fn prompt_is_stdin_and_flags_follow_the_resume_subcommand() {
        let args = args_for(None, Some("thread-abc"));
        assert_eq!(args.last().unwrap(), "-", "prompt must come from stdin");
        assert_eq!(args[0], "exec");
        assert_eq!(args[1], "resume");
        assert_eq!(args[2], "thread-abc");

        // `resume` re-declares these, so a copy placed BEFORE it binds to `exec`
        // and is ignored — which would silently turn off JSONL on every resumed
        // turn (i.e. every chat turn after the first). They must come after.
        let resume_at = args.iter().position(|a| a == "resume").unwrap();
        for flag in [
            "--ignore-user-config",
            "--json",
            "--skip-git-repo-check",
            "--model",
            "-c",
        ] {
            if let Some(at) = args.iter().position(|a| a == flag) {
                assert!(at > resume_at, "{flag} must follow `resume`");
            }
        }

        // `--sandbox` is not accepted by `resume`; Studio uses the bypass flag
        // shared by fresh and resumed runs instead.
        assert!(!args.iter().any(|a| a == "--sandbox" || a == "-s"));
        assert!(args
            .iter()
            .any(|a| a == "--dangerously-bypass-approvals-and-sandbox"));
    }

    #[test]
    fn user_config_is_ignored_for_fresh_and_resumed_runs() {
        for resume in [None, Some("thread-abc")] {
            let args = args_for(None, resume);
            assert_eq!(
                args.iter()
                    .filter(|arg| arg.as_str() == "--ignore-user-config")
                    .count(),
                1
            );
            for value in crate::codexauth::SUBSCRIPTION_CONFIG_OVERRIDES {
                assert!(args.iter().any(|arg| arg == value), "missing {value}");
            }
            if resume.is_some() {
                let resume_at = args.iter().position(|arg| arg == "resume").unwrap();
                let ignore_at = args
                    .iter()
                    .position(|arg| arg == "--ignore-user-config")
                    .unwrap();
                assert!(ignore_at > resume_at);
            }
        }
    }

    #[test]
    fn runs_are_always_non_interactive() {
        // Fresh tasks never stop at an approval gate.
        let args = args_for(None, None);
        assert!(!args.iter().any(|a| a == "sandbox_mode='workspace-write'"));
        assert!(args
            .iter()
            .any(|a| a == "--dangerously-bypass-approvals-and-sandbox"));
    }

    #[test]
    fn model_is_the_codex_model_not_the_claude_one() {
        let args = args_for(Some("gpt-5-codex"), None);
        let m = args.iter().position(|a| a == "--model").unwrap();
        assert_eq!(args[m + 1], "gpt-5-codex");

        // A Claude model id set for the other backend must not leak in.
        let mut s = settings(None);
        s.model = Some("claude-opus-4-8".into());
        let args = build_args(
            &s,
            &FlagInput {
                mcp_config_path: std::path::Path::new("/unused.json"),
                mcp_entry: &entry(),
                resume_session_id: None,
                max_turns: None,
                run_options: None,
                read_only: false,
            },
        );
        assert!(!args.iter().any(|a| a == "--model"));
    }

    #[test]
    fn task_effort_is_a_toml_override_after_resume() {
        let settings = settings(None);
        let run = crate::agent::AgentRunOptions {
            backend: Backend::Codex,
            model: Some("gpt-5.6-sol".into()),
            effort: Some("xhigh".into()),
        };
        let args = build_args(
            &settings,
            &FlagInput {
                mcp_config_path: std::path::Path::new("/unused.json"),
                mcp_entry: &entry(),
                resume_session_id: Some("thread-abc"),
                max_turns: None,
                run_options: Some(&run),
                read_only: false,
            },
        );
        let effort = args
            .iter()
            .position(|a| a == "model_reasoning_effort='xhigh'")
            .unwrap();
        let resume = args.iter().position(|a| a == "resume").unwrap();
        assert!(effort > resume);
        assert_eq!(args[effort - 1], "-c");
        assert_eq!(args.last().map(String::as_str), Some("-"));
    }

    #[test]
    fn captures_session_result_and_failure() {
        let mut c = Captured::default();
        capture(
            &mut c,
            &serde_json::json!({"type":"thread.started","thread_id":"t_1"}),
        );
        assert_eq!(c.session_id.as_deref(), Some("t_1"));

        capture(
            &mut c,
            &serde_json::json!({"type":"item.completed",
                "item":{"id":"i1","type":"agent_message","text":"Done."}}),
        );
        assert_eq!(c.result_text.as_deref(), Some("Done."));

        capture(
            &mut c,
            &serde_json::json!({"type":"turn.completed",
                "usage":{"input_tokens":10,"output_tokens":5}}),
        );
        assert!(c.result_seen);
        assert!(!c.is_error);
        assert_eq!(c.tokens, Some(15));
        assert_eq!(c.cost_usd, None, "Codex reports no USD cost");

        let mut f = Captured::default();
        capture(
            &mut f,
            &serde_json::json!({"type":"turn.failed","error":{"message":"boom"}}),
        );
        assert!(f.is_error);
        assert!(f.result_seen);
        assert_eq!(f.result_text.as_deref(), Some("boom"));
        assert_eq!(f.error_text.as_deref(), Some("boom"));

        let mut partial = Captured::default();
        capture(
            &mut partial,
            &serde_json::json!({"type":"item.completed",
                "item":{"type":"agent_message","text":"```json\n{\"status\":\"continue\"}\n```"}}),
        );
        capture(&mut partial, &serde_json::json!({"type":"error"}));
        assert!(partial.is_error);
        assert!(partial.error_text.is_none());
        assert!(partial
            .result_text
            .as_deref()
            .unwrap()
            .starts_with("```json"));
    }
}
