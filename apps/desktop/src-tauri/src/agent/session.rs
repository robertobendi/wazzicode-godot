//! Headless agent session manager (chat turns).
//!
//! Spawns the selected backend (`claude -p …` or `codex exec --json …`) per chat
//! turn via the shared [`spawn_streaming`](crate::agent::spawn) core, which
//! streams stdout (one JSON object per line) to the webview as
//! `agent:stream:<runId>`. On exit this manager emits either `agent:done:<runId>`
//! (a terminal result was seen) or `agent:error:<runId>` (crash / never produced
//! a result, or user cancellation). Stream *parsing* into chat messages happens
//! in the webview (`src/lib/streamMapper.ts`, which reduces both vocabularies);
//! Rust stays a thin, dumb pipe.
//!
//! Concurrency: at most one active run per project. Cancellation kills the
//! whole process group, then the reader task produces an `ExitInfo` with
//! `cancelled: true` so there's a single exit-emit code path.

use crate::agent::spawn::{friendly_spawn_error, spawn_streaming, ChildHandle, ExitInfo};
use crate::agent::Backend;
use crate::error::{AppError, AppResult};
use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter};

/// One live chat run: the cancellation handle plus the project it targets.
struct RunHandle {
    handle: ChildHandle,
    project: PathBuf,
    _permit: crate::execution::ProjectPermit,
}

/// Tracks active runs. Cheap to clone (shared `Arc` map). Held in `AppState`.
#[derive(Clone, Default)]
pub struct SessionManager {
    runs: Arc<Mutex<HashMap<String, RunHandle>>>,
    terminal: Arc<Mutex<TerminalMailbox>>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", content = "payload", rename_all = "snake_case")]
pub enum TerminalEvent {
    Done(serde_json::Value),
    Error(serde_json::Value),
}

#[derive(Default)]
struct TerminalMailbox {
    completed: HashMap<String, TerminalEvent>,
    subscribed: HashSet<String>,
}

impl TerminalMailbox {
    fn subscribe(&mut self, run_id: &str) -> Option<TerminalEvent> {
        if let Some(event) = self.completed.remove(run_id) {
            return Some(event);
        }
        self.subscribed.insert(run_id.to_string());
        None
    }

    fn publish(&mut self, run_id: &str, event: TerminalEvent) {
        if !self.subscribed.remove(run_id) {
            self.completed.insert(run_id.to_string(), event);
        }
    }
}

impl SessionManager {
    /// Spawn an agent run. Returns the `runId` used in the event names.
    /// Errors with `"busy"` if a run for `project` is already active.
    pub async fn start_run(
        &self,
        app: AppHandle,
        backend: Backend,
        project: PathBuf,
        prompt: String,
        args: Vec<String>,
        permit: crate::execution::ProjectPermit,
    ) -> AppResult<String> {
        // One active run per project.
        if self.has_run_for(&project) {
            return Err(AppError::Other("busy".into()));
        }

        let run_id = nanoid::nanoid!();
        // Spawning is synchronous and can block for seconds before the child
        // even exists: Claude's pre-flight `auth status` is itself a subprocess
        // we wait on. Off the async workers, so one slow send can't stall
        // everything else the runtime is driving.
        let (handle, join) = {
            let app = app.clone();
            let project = project.clone();
            let run_id = run_id.clone();
            tokio::task::spawn_blocking(move || {
                spawn_streaming(app, backend, run_id, &project, args, prompt)
            })
            .await
            .map_err(|e| AppError::Other(format!("could not start the agent: {e}")))??
        };
        self.runs.lock().unwrap().insert(
            run_id.clone(),
            RunHandle {
                handle,
                project,
                _permit: permit,
            },
        );

        let runs_map = self.runs.clone();
        let terminal = self.terminal.clone();
        let run_id_task = run_id.clone();
        tokio::spawn(async move {
            let info = join.await.unwrap_or_default();
            runs_map.lock().unwrap().remove(&run_id_task);
            let event = terminal_event(backend, &info);
            terminal
                .lock()
                .unwrap()
                .publish(&run_id_task, event.clone());
            emit_terminal(&app, &run_id_task, &event);
        });

        Ok(run_id)
    }

    /// Stop a run: kills the process group. The reader then reports the run as
    /// cancelled, so `emit_terminal` emits "Stopped". No-op if already done.
    pub async fn cancel(&self, run_id: &str) {
        let handle = self
            .runs
            .lock()
            .unwrap()
            .get(run_id)
            .map(|h| h.handle.clone());
        if let Some(h) = handle {
            h.cancel().await;
        }
    }

    /// True if any chat run is active for `project`. Used for cross-exclusion
    /// with the auto-loop (loop_start refuses while a chat is in flight).
    pub fn has_run_for(&self, project: &Path) -> bool {
        self.runs
            .lock()
            .unwrap()
            .values()
            .any(|h| h.project == project)
    }

    /// Mark the webview listeners ready and replay a terminal event if this run
    /// completed before the frontend received its id.
    pub fn subscribe(&self, run_id: &str) -> Option<TerminalEvent> {
        self.terminal.lock().unwrap().subscribe(run_id)
    }
}

fn terminal_event(backend: Backend, info: &ExitInfo) -> TerminalEvent {
    if info.cancelled {
        TerminalEvent::Error(
            serde_json::json!({ "friendly": "Stopped.", "raw": "Run cancelled by user." }),
        )
    } else if info.result_seen {
        let result_text = if info.is_error {
            info.error_text.as_ref().or(info.result_text.as_ref())
        } else {
            info.result_text.as_ref()
        };
        TerminalEvent::Done(serde_json::json!({
            "sessionId": info.session_id,
            "costUsd": info.cost_usd,
            "tokens": info.tokens,
            "isError": info.is_error,
            "resultText": result_text,
            "numTurns": info.num_turns,
        }))
    } else {
        // The startup watchdog knows exactly what went wrong; nothing can be
        // inferred from the stderr of a child that never wrote any.
        let friendly = info
            .startup_failure
            .clone()
            .unwrap_or_else(|| friendly_spawn_error(backend, &info.stderr_tail, info.exit_code));
        TerminalEvent::Error(serde_json::json!({
            "friendly": friendly,
            "raw": format!("{}\n(exit code: {:?})", info.stderr_tail, info.exit_code),
        }))
    }
}

/// Emit the terminal `agent:done`/`agent:error` event for a finished run.
fn emit_terminal(app: &AppHandle, run_id: &str, event: &TerminalEvent) {
    match event {
        TerminalEvent::Done(payload) => {
            let _ = app.emit(&format!("agent:done:{run_id}"), payload);
        }
        TerminalEvent::Error(payload) => {
            let _ = app.emit(&format!("agent:error:{run_id}"), payload);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn event() -> TerminalEvent {
        TerminalEvent::Done(serde_json::json!({"sessionId": "s1"}))
    }

    #[test]
    fn caches_a_terminal_event_until_late_listeners_subscribe() {
        let mut mailbox = TerminalMailbox::default();
        mailbox.publish("run-1", event());
        assert!(matches!(
            mailbox.subscribe("run-1"),
            Some(TerminalEvent::Done(_))
        ));
        assert!(mailbox.completed.is_empty());
    }

    #[test]
    fn an_early_subscription_uses_the_live_event_without_caching() {
        let mut mailbox = TerminalMailbox::default();
        assert!(mailbox.subscribe("run-1").is_none());
        mailbox.publish("run-1", event());
        assert!(mailbox.completed.is_empty());
        assert!(mailbox.subscribed.is_empty());
    }

    #[test]
    fn terminal_event_shape_matches_the_webview_union() {
        let value = serde_json::to_value(event()).unwrap();
        assert_eq!(value["kind"], "done");
        assert_eq!(value["payload"]["sessionId"], "s1");
    }
}
