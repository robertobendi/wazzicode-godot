//! Shared headless-agent spawn + stream core.
//!
//! Both the chat session manager (`session.rs`) and the auto-loop runner
//! (`looprunner`) spawn a headless coding agent — `claude -p --output-format
//! stream-json …` or `codex exec --json …` — stream each parsed JSON line to the
//! webview as `agent:stream:<runId>`, and need the same cancellation semantics
//! (kill the whole process *group*: the agent spawns the MCP server as a child,
//! so a plain SIGKILL on the parent would orphan it). This module is that single
//! implementation.
//!
//! The backend only changes two things here: which binary we spawn, and which
//! JSON vocabulary we read off stdout. Everything else — process-group kill,
//! stdin prompt, stderr tail, the [`ExitInfo`] contract — is shared, and the
//! webview receives whichever raw lines the CLI produced (its reducer handles
//! both shapes).
//!
//! `spawn_streaming` returns a [`ChildHandle`] (for cancellation) plus a
//! `JoinHandle<ExitInfo>` the caller can either **await** (the loop drives
//! turns sequentially and consumes the `ExitInfo`) or **detach** (chat fires
//! its terminal `agent:done`/`agent:error` events off the reader task). The
//! core itself only emits the streaming events; terminal events are the
//! caller's concern.

use crate::agent::Backend;
use crate::error::{AppError, AppResult};
use std::path::Path;
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::sync::Mutex as AsyncMutex;
use tokio::task::JoinHandle;

/// Fields captured off a run's stream, returned when it exits.
#[derive(Debug, Default, Clone)]
pub struct ExitInfo {
    pub session_id: Option<String>,
    /// Turn cost in USD. `None` for backends that don't price a turn (Codex
    /// reports tokens instead) — distinct from `Some(0.0)`, which would mean a
    /// genuinely free turn and would silently defeat the loop's cost cap.
    pub cost_usd: Option<f64>,
    /// Total tokens for the run, when the backend reports them (Codex).
    pub tokens: Option<u64>,
    pub is_error: bool,
    pub result_text: Option<String>,
    /// Explicit error payload from the agent protocol, kept separate from the
    /// last assistant message so a partial result is never shown as the cause.
    pub error_text: Option<String>,
    pub num_turns: Option<u64>,
    /// A terminal "the run produced an answer" line was seen.
    pub result_seen: bool,
    /// The run was cancelled via its [`ChildHandle`] (killed process tree).
    pub cancelled: bool,
    pub exit_code: Option<i32>,
    /// Last ~4 KiB of stderr, for crash diagnostics.
    pub stderr_tail: String,
    /// Why the startup watchdog killed the run. Set only when the agent never
    /// wrote a line, which is also the case where there is no stderr and no
    /// meaningful exit code to explain the failure from.
    pub startup_failure: Option<String>,
}

/// Handle to a live child, enough to cancel it. Cheap to clone.
#[derive(Clone)]
pub struct ChildHandle {
    child: Arc<AsyncMutex<tokio::process::Child>>,
    cancelled: Arc<AtomicBool>,
    /// Process-group leader pid (== child pid; we spawn it in its own group).
    pid: Option<u32>,
}

impl ChildHandle {
    /// Mark cancelled (so the reader reports `cancelled: true`) and kill the
    /// whole process tree. No-op if the child already exited.
    pub async fn cancel(&self) {
        self.cancelled.store(true, Ordering::SeqCst);
        kill_tree(self.pid, self.child.clone()).await;
    }
}

/// Spawn a headless `backend` run for `project` with `args` (everything after
/// the program name; the prompt is fed via stdin, not argv). Each parsed JSON
/// line is emitted as `agent:stream:<run_id>`; non-JSON lines go to `debug:raw`.
///
/// Returns the cancellation handle and the reader task's join handle, which
/// resolves to the captured [`ExitInfo`] once the child exits.
pub fn spawn_streaming(
    app: AppHandle,
    backend: Backend,
    run_id: String,
    project: &Path,
    args: Vec<String>,
    prompt: String,
) -> AppResult<(ChildHandle, JoinHandle<ExitInfo>)> {
    let mut child = {
        // Reuse proc's PATH augmentation + no-window handling, then override
        // the stdio it nulls (we write the prompt and read the stream).
        let mut std_cmd = crate::proc::command(backend.bin())?;
        std_cmd
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .current_dir(project)
            .args(&args);
        // Use each CLI's own stored login rather than provider keys inherited
        // from the app's launch environment. A stray key could silently switch
        // the account and billing path for a non-interactive run. The guard's
        // scope deliberately ends immediately after spawn.
        let _credential_guard = match backend {
            Backend::Claude => {
                let guard = crate::claudeauth::configure_child(&mut std_cmd)?;
                if args.iter().any(|arg| arg == "--effort") {
                    crate::claudeauth::prefer_cli_effort(&mut std_cmd);
                }
                Some(guard)
            }
            Backend::Codex => {
                crate::codexauth::isolate_child_environment(&mut std_cmd);
                None
            }
        };
        // Own process group so cancellation can kill the whole tree (the agent
        // + its MCP server child) with a single group signal.
        #[cfg(unix)]
        {
            use std::os::unix::process::CommandExt;
            std_cmd.process_group(0);
        }

        let mut cmd = tokio::process::Command::from(std_cmd);
        cmd.kill_on_drop(true);
        cmd.spawn()
            .map_err(|e| AppError::Other(format!("could not start {}: {e}", backend.label())))
    }?;

    let pid = child.id();
    let child_stdin = child.stdin.take();
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();

    // Prompt → stdin, then EOF so the agent starts working.
    if let Some(mut sin) = child_stdin {
        tokio::spawn(async move {
            let _ = sin.write_all(prompt.as_bytes()).await;
            let _ = sin.shutdown().await;
        });
    }

    let child = Arc::new(AsyncMutex::new(child));
    let cancelled = Arc::new(AtomicBool::new(false));
    let handle = ChildHandle {
        child: child.clone(),
        cancelled: cancelled.clone(),
        pid,
    };

    let join = tokio::spawn(async move {
        let mut captured = Captured::default();
        let mut startup_failure = None;
        // Drain stderr concurrently. Reading it only after stdout reaches EOF
        // can deadlock when a CLI fills the stderr pipe while stdout stays open.
        let stderr_task = tokio::spawn(async move {
            match stderr {
                Some(err) => read_tail(err).await,
                None => String::new(),
            }
        });

        if let Some(out) = stdout {
            let mut lines = BufReader::new(out).lines();
            let mut pending = match first_line(&mut lines, backend, startup_timeout(backend)).await
            {
                Ok(line) => line,
                Err(reason) => {
                    // Kill the group, not just the child: the agent's MCP server
                    // is the thing most likely to be wedged, and it is a child.
                    kill_tree(pid, child.clone()).await;
                    startup_failure = Some(reason);
                    None
                }
            };
            while let Some(line) = pending {
                if !line.trim().is_empty() {
                    match serde_json::from_str::<serde_json::Value>(&line) {
                        Ok(value) => {
                            capture(backend, &mut captured, &value);
                            let _ = app.emit(&format!("agent:stream:{run_id}"), &value);
                        }
                        Err(_) => {
                            // Non-JSON line — surface only to the debug drawer.
                            let _ = app.emit(
                                "debug:raw",
                                serde_json::json!({ "runId": run_id, "line": line }),
                            );
                        }
                    }
                }
                pending = lines.next_line().await.ok().flatten();
            }
        }

        let stderr_tail = stderr_task.await.unwrap_or_default();
        let status = child.lock().await.wait().await;
        let exit_code = status.ok().and_then(|s| s.code());

        ExitInfo {
            session_id: captured.session_id,
            cost_usd: captured.cost_usd,
            tokens: captured.tokens,
            is_error: captured.is_error,
            result_text: captured.result_text,
            error_text: captured.error_text,
            num_turns: captured.num_turns,
            result_seen: captured.result_seen,
            cancelled: cancelled.load(Ordering::SeqCst),
            exit_code,
            stderr_tail,
            startup_failure,
        }
    });

    Ok((handle, join))
}

/// Escalating group kill: SIGTERM the group, then SIGKILL after 3s (unix);
/// `taskkill /T /F` the tree on Windows. Falls back to killing just the child
/// if we somehow don't have a pid.
async fn kill_tree(pid: Option<u32>, child: Arc<AsyncMutex<tokio::process::Child>>) {
    #[cfg(unix)]
    if let Some(pid) = pid {
        // Negative pid targets the whole process group.
        unsafe {
            libc::kill(-(pid as i32), libc::SIGTERM);
        }
        let child2 = child.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_secs(3)).await;
            unsafe {
                libc::kill(-(pid as i32), libc::SIGKILL);
            }
            let _ = child2.lock().await.start_kill();
        });
        return;
    }
    #[cfg(windows)]
    if let Some(pid) = pid {
        let mut cmd = std::process::Command::new("taskkill");
        cmd.args(["/T", "/F", "/PID", &pid.to_string()]);
        crate::proc::no_window(&mut cmd);
        let _ = cmd.spawn();
        return;
    }
    let _ = pid;
    let _ = child.lock().await.start_kill();
}

/// How long a backend may stay completely silent before we call the run dead.
/// Codex gets no deadline of its own: it already enforces `startup_timeout_sec`
/// on its MCP servers and reports that failure itself.
fn startup_timeout(backend: Backend) -> Option<Duration> {
    match backend {
        Backend::Claude => Some(Duration::from_secs(60)),
        Backend::Codex => None,
    }
}

/// Wait for the run's first stream line, on a clock.
///
/// A CLI that starts but never speaks — a wedged MCP server handshake is the
/// usual cause — leaves this reader parked on `next_line` indefinitely, and the
/// UI showing "Thinking…" for as long as the user is willing to watch. Only the
/// *first* line is timed: once the agent is talking, a long silence is just a
/// long tool call and killing it would be wrong.
async fn first_line<R>(
    lines: &mut tokio::io::Lines<R>,
    backend: Backend,
    limit: Option<Duration>,
) -> Result<Option<String>, String>
where
    R: tokio::io::AsyncBufRead + Unpin,
{
    let Some(limit) = limit else {
        return Ok(lines.next_line().await.ok().flatten());
    };
    match tokio::time::timeout(limit, lines.next_line()).await {
        Ok(line) => Ok(line.ok().flatten()),
        Err(_) => Err(format!(
            "{} produced no output for {}s — it may be stuck starting an MCP server; \
             check that the project's MCP config is valid.",
            backend.label(),
            limit.as_secs()
        )),
    }
}

/// Fields pulled off the stream for the `ExitInfo` / terminal events. Written by
/// whichever backend's `capture` is driving; shared so both normalize onto one
/// shape.
#[derive(Default)]
pub struct Captured {
    pub session_id: Option<String>,
    pub cost_usd: Option<f64>,
    pub tokens: Option<u64>,
    pub is_error: bool,
    pub result_text: Option<String>,
    pub error_text: Option<String>,
    pub num_turns: Option<u64>,
    pub result_seen: bool,
}

/// Pull the fields we need off each stream line, per the backend's vocabulary.
fn capture(backend: Backend, c: &mut Captured, v: &serde_json::Value) {
    match backend {
        Backend::Claude => capture_claude(c, v),
        Backend::Codex => crate::agent::codex::capture(c, v),
    }
}

fn capture_claude(c: &mut Captured, v: &serde_json::Value) {
    match v.get("type").and_then(|t| t.as_str()) {
        Some("system") if v.get("subtype").and_then(|s| s.as_str()) == Some("init") => {
            if let Some(sid) = v.get("session_id").and_then(|s| s.as_str()) {
                c.session_id = Some(sid.to_string());
            }
        }
        Some("result") => {
            c.result_seen = true;
            if let Some(sid) = v.get("session_id").and_then(|s| s.as_str()) {
                c.session_id = Some(sid.to_string());
            }
            if let Some(cost) = v.get("total_cost_usd").and_then(|n| n.as_f64()) {
                c.cost_usd = Some(cost);
            }
            c.is_error = v.get("is_error").and_then(|b| b.as_bool()).unwrap_or(false);
            if let Some(r) = v.get("result").and_then(|s| s.as_str()) {
                c.result_text = Some(r.to_string());
                if c.is_error {
                    c.error_text = Some(r.to_string());
                }
            }
            if let Some(n) = v.get("num_turns").and_then(|n| n.as_u64()) {
                c.num_turns = Some(n);
            }
        }
        _ => {}
    }
}

/// Keep the last ~4KiB of a child's stderr for the crash-diagnostics payload.
async fn read_tail<R: tokio::io::AsyncRead + Unpin>(mut r: R) -> String {
    const CAP: usize = 4096;
    let mut buf: Vec<u8> = Vec::new();
    let mut chunk = [0u8; 8192];
    loop {
        match r.read(&mut chunk).await {
            Ok(0) | Err(_) => break,
            Ok(n) => {
                buf.extend_from_slice(&chunk[..n]);
                if buf.len() > CAP {
                    let drop = buf.len() - CAP;
                    buf.drain(..drop);
                }
            }
        }
    }
    String::from_utf8_lossy(&buf).into_owned()
}

/// Best-effort human message when the agent dies without producing a result. The
/// webview's `errorMessages.ts` refines this further from the raw tail.
pub fn friendly_spawn_error(backend: Backend, stderr_tail: &str, exit_code: Option<i32>) -> String {
    let lower = stderr_tail.to_lowercase();
    if lower.contains("not logged in")
        || lower.contains("api key")
        || lower.contains("oauth")
        || lower.contains("401")
        || lower.contains("unauthorized")
        || lower.contains("authentication")
    {
        return match backend {
            Backend::Claude => "Your connection expired — go to Settings → Re-pair account.".into(),
            Backend::Codex => "Codex isn't signed in — go to Settings → Sign in to Codex.".into(),
        };
    }
    if lower.contains("enoent") || lower.contains("not found") {
        return format!(
            "The {} CLI couldn't start. It may not be installed.",
            backend.label()
        );
    }
    // A Windows startup failure exits with an NTSTATUS and writes nothing, so
    // the raw code is all we'd otherwise have to show.
    if let Some(reason) =
        exit_code.and_then(|code| crate::proc::launch_failure(backend.label(), code as u32))
    {
        return reason;
    }
    match exit_code {
        Some(code) => format!(
            "{} stopped unexpectedly (exit code {code}).",
            backend.label()
        ),
        None => format!("{} stopped unexpectedly.", backend.label()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn auth_failures_point_at_the_right_sign_in() {
        let claude = friendly_spawn_error(Backend::Claude, "Error: not logged in", Some(1));
        assert!(claude.contains("Re-pair"));
        let codex = friendly_spawn_error(Backend::Codex, "401 Unauthorized", Some(1));
        assert!(codex.contains("Sign in to Codex"));
    }

    #[test]
    fn a_windows_startup_failure_is_explained_not_printed_as_a_negative_code() {
        // 0xC0000142 (STATUS_DLL_INIT_FAILED) as std's signed exit code.
        let msg = friendly_spawn_error(Backend::Claude, "", Some(-1_073_741_502));
        assert!(msg.contains("0xC0000142"), "{msg}");
        assert!(!msg.contains("-1073741502"), "{msg}");
    }

    #[test]
    fn missing_binary_names_the_selected_backend() {
        let msg = friendly_spawn_error(Backend::Codex, "ENOENT", None);
        assert!(msg.contains("Codex CLI"));
    }

    #[tokio::test]
    async fn a_run_that_never_says_anything_is_reported_not_waited_on() {
        // The write half stays alive and silent, so the reader would otherwise
        // block here forever.
        let (silent, _writer) = tokio::io::duplex(64);
        let mut lines = BufReader::new(silent).lines();

        let reason = first_line(&mut lines, Backend::Claude, Some(Duration::from_millis(20)))
            .await
            .expect_err("a silent start must not hang the reader");

        assert!(reason.contains("MCP"), "{reason}");
        assert!(reason.starts_with("Claude produced no output"), "{reason}");
    }

    #[tokio::test]
    async fn the_first_line_is_returned_when_it_arrives_in_time() {
        let (reader, mut writer) = tokio::io::duplex(64);
        writer.write_all(b"{\"type\":\"system\"}\n").await.unwrap();
        let mut lines = BufReader::new(reader).lines();

        let first = first_line(&mut lines, Backend::Claude, Some(Duration::from_secs(5)))
            .await
            .expect("a talking child is not a failure");

        assert_eq!(first.as_deref(), Some("{\"type\":\"system\"}"));
    }

    #[test]
    fn only_claude_gets_our_own_startup_deadline() {
        assert_eq!(
            startup_timeout(Backend::Claude),
            Some(Duration::from_secs(60))
        );
        assert_eq!(startup_timeout(Backend::Codex), None);
    }

    #[test]
    fn claude_capture_reads_result_line() {
        let mut c = Captured::default();
        capture(
            Backend::Claude,
            &mut c,
            &serde_json::json!({"type":"system","subtype":"init","session_id":"s1"}),
        );
        capture(
            Backend::Claude,
            &mut c,
            &serde_json::json!({"type":"result","total_cost_usd":0.42,"is_error":false,
                "result":"ok","num_turns":3,"session_id":"s1"}),
        );
        assert_eq!(c.session_id.as_deref(), Some("s1"));
        assert_eq!(c.cost_usd, Some(0.42));
        assert!(c.result_seen);
        assert_eq!(c.num_turns, Some(3));
    }
}
