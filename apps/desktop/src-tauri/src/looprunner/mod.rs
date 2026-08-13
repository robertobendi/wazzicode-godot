//! Auto mode: the simplified autonomous dev loop.
//!
//! One goal → repeated builder turns until the goal is reached, the budget runs
//! out, the loop gets stuck, or the user hits Stop. Two roles, no more:
//!
//!   1. **Builder** — a resumed agent session (Claude or Codex, whichever the
//!      user selected) told to implement the next small increment, run
//!      `unity_verify`, screenshot, and end with a fenced JSON verdict
//!      (`done` / `continue` / `blocked`).
//!   2. **QA critic** — a *cold* (unresumed) harsh reviewer that only runs when
//!      the builder claims `done` (and `qaEvery > 0`); a fail feeds its notes
//!      back into the next builder turn. The critic must run `unity_qa` and
//!      report its verdict as a `gate`: the loop finishes only when that gate
//!      passed *and* the reviewer is satisfied, so no amount of confident prose
//!      or a good-looking screenshot can end the loop over a red build. A gate
//!      that cannot run counts as unproven — the caps (strikes, cost, max
//!      iterations) remain the only terminators in that case.
//!
//! Between the two, a **deterministic reflector** (pure fns in [`reflect`]) —
//! not an LLM — parses the verdict and makes every stop/continue decision; each
//! iteration is git-checkpointed and screenshotted. All spawning reuses the
//! shared [`crate::agent::spawn_streaming`] core, so loop turns stream to the
//! webview under `agent:stream:loop:<loopId>:<i>:<builder|qa>` just like chat.
//!
//! Backends differ in one way that matters here: Claude prices each turn, Codex
//! doesn't (it reports tokens). The USD budget cap is therefore inert on Codex,
//! and rather than pretend every turn cost $0 — which would look like a working
//! budget that never trips — the loop disables the cap explicitly and warns.
//!
//! Exactly one loop runs per app. State is persisted to
//! `<project>/.unity-vibe/loop/<loopId>/state.json` and mirrored to the webview
//! via a single `loop:update` event (payload = the full [`LoopState`]) on every
//! transition.

pub mod reflect;

use crate::agent::flags::{build_args, FlagInput};
use crate::agent::{spawn_streaming, AgentRunOptions, Backend, ChildHandle, ExitInfo};
use crate::error::{AppError, AppResult};
use crate::mcpconfig::McpEntry;
use crate::store::settings::Settings;
use base64::Engine;
use reflect::Step;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter};
use tokio::sync::Mutex as AsyncMutex;
use tokio::task::JoinHandle;

/// Caller-supplied loop parameters (mirrors the TS `LoopOptions`).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LoopOptions {
    pub max_iterations: u32,
    pub max_cost_usd: f64,
    /// `0` disables the QA critic (builder's `done` is final); `>0` runs QA on
    /// every builder `done`.
    pub qa_every: u32,
    #[serde(default)]
    pub reference_images: Vec<String>,
    #[serde(default)]
    pub agent: AgentRunOptions,
    #[serde(default)]
    pub continuation_context: Option<String>,
}

/// Overall loop status.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LoopStatus {
    Running,
    Stopping,
    Done,
    Stopped,
    Blocked,
    MaxIterations,
    CostCapped,
    Failed,
}

impl LoopStatus {
    fn is_active(self) -> bool {
        matches!(self, LoopStatus::Running | LoopStatus::Stopping)
    }
}

/// QA critic verdict attached to the iteration that triggered it.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QaResult {
    pub pass: bool,
    pub score: Option<f64>,
    pub notes: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LoopFeedback {
    pub id: String,
    pub text: String,
    pub created_at_ms: u64,
    pub applied_at_iteration: Option<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LoopFailure {
    pub message: String,
    pub phase: String,
    pub iteration: u32,
}

/// One recorded iteration.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LoopIteration {
    pub index: u32,
    /// The reflector verdict: "done" | "continue" | "blocked" | "unknown".
    pub verdict: String,
    pub summary: String,
    pub cost_usd: f64,
    /// App-captured screenshot for this iteration (falls back to the builder's
    /// reported path when the live capture fails).
    pub screenshot_path: Option<String>,
    pub commit_sha: Option<String>,
    pub qa: Option<QaResult>,
}

/// The full persisted + broadcast loop state.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LoopState {
    pub loop_id: String,
    pub goal: String,
    pub reference_images: Vec<String>,
    pub status: LoopStatus,
    pub iterations: Vec<LoopIteration>,
    pub total_cost_usd: f64,
    pub options: LoopOptions,
    /// One-time non-fatal warnings (e.g. git checkpointing unavailable).
    pub warnings: Vec<String>,
    /// User guidance history. A null appliedAtIteration means it is queued for
    /// the next builder boundary.
    #[serde(default)]
    pub feedback: Vec<LoopFeedback>,
    #[serde(default)]
    pub failure: Option<LoopFailure>,
    /// The currently-streaming sub-run id, for the live "now doing" line.
    pub current_run_id: Option<String>,
}

/// Shared, cloneable slice of a running loop — everything `loop_stop` /
/// `loop_state` need without touching the driver's `JoinHandle`.
struct LoopShared {
    loop_id: String,
    project: PathBuf,
    dir: PathBuf,
    stop: AtomicBool,
    /// The child of the currently-running builder/QA turn, if any.
    child: AsyncMutex<Option<ChildHandle>>,
    state: AsyncMutex<LoopState>,
}

struct ActiveLoop {
    shared: Arc<LoopShared>,
    _task: JoinHandle<()>,
}

/// Manages the single active loop for the app. Held in `AppState`.
#[derive(Default)]
pub struct LoopManager {
    active: Arc<AsyncMutex<Option<ActiveLoop>>>,
}

impl LoopManager {
    /// Start a loop. Errors `"busy"` if one is already active. Spawns a single
    /// tokio task driving the iteration state machine.
    #[allow(clippy::too_many_arguments)]
    pub async fn start(
        &self,
        app: AppHandle,
        project: PathBuf,
        goal: String,
        options: LoopOptions,
        settings: Settings,
        mcp_config: PathBuf,
        mcp_entry: McpEntry,
        permit: crate::execution::ProjectPermit,
    ) -> AppResult<String> {
        let mut guard = self.active.lock().await;
        if let Some(existing) = guard.as_ref() {
            if existing.shared.state.lock().await.status.is_active() {
                return Err(AppError::Other("busy".into()));
            }
        }

        let loop_id = nanoid::nanoid!();
        let dir = project.join(".unity-vibe").join("loop").join(&loop_id);
        std::fs::create_dir_all(&dir)?;
        // A human-readable goal file next to the machine state.
        let _ = std::fs::write(dir.join("goal.md"), &goal);

        let state = LoopState {
            loop_id: loop_id.clone(),
            goal: goal.clone(),
            reference_images: options.reference_images.clone(),
            status: LoopStatus::Running,
            iterations: Vec::new(),
            total_cost_usd: 0.0,
            options: options.clone(),
            warnings: Vec::new(),
            feedback: Vec::new(),
            failure: None,
            current_run_id: None,
        };

        let shared = Arc::new(LoopShared {
            loop_id: loop_id.clone(),
            project,
            dir,
            stop: AtomicBool::new(false),
            child: AsyncMutex::new(None),
            state: AsyncMutex::new(state),
        });

        persist_and_emit(&app, &shared).await;

        let driver = Driver {
            app,
            shared: shared.clone(),
            settings,
            mcp_config,
            mcp_entry,
            goal,
            options,
            _permit: permit,
        };
        let task = tokio::spawn(async move { driver.run().await });

        *guard = Some(ActiveLoop {
            shared,
            _task: task,
        });
        Ok(loop_id)
    }

    /// Request a stop: set the flag, mark `stopping`, and kill the active child
    /// immediately (the plan's "big Stop = immediate"). The driver observes the
    /// flag and finishes as `stopped`.
    pub async fn stop(&self) {
        let shared = {
            let guard = self.active.lock().await;
            guard.as_ref().map(|a| a.shared.clone())
        };
        let Some(shared) = shared else { return };

        shared.stop.store(true, Ordering::SeqCst);
        {
            let mut st = shared.state.lock().await;
            if st.status == LoopStatus::Running {
                st.status = LoopStatus::Stopping;
            }
        }
        let child = shared.child.lock().await.clone();
        if let Some(child) = child {
            child.cancel().await;
        }
    }

    /// Queue guidance while an agent turn is active. The driver drains it only
    /// after that turn completes, before making the next plan.
    pub async fn add_feedback(&self, app: &AppHandle, text: String) -> AppResult<()> {
        let text = normalize_feedback(&text).map_err(AppError::Other)?;
        let shared = {
            let guard = self.active.lock().await;
            guard.as_ref().map(|active| active.shared.clone())
        }
        .ok_or_else(|| AppError::Other("No Auto mode loop is running.".into()))?;

        {
            let mut state = shared.state.lock().await;
            if state.status != LoopStatus::Running {
                return Err(AppError::Other(
                    "This Auto mode loop is stopping or has already finished.".into(),
                ));
            }
            if feedback_target_iteration(&state) >= state.options.max_iterations {
                return Err(AppError::Other(
                    "The loop is on its final allowed step, so there is no next step for feedback."
                        .into(),
                ));
            }
            state.feedback.push(LoopFeedback {
                id: nanoid::nanoid!(),
                text,
                created_at_ms: now_ms(),
                applied_at_iteration: None,
            });
        }
        persist_and_emit(app, &shared).await;
        Ok(())
    }

    /// Current in-memory state for `project`, or its most recently persisted
    /// run after Studio restarts.
    pub async fn state(&self, project: &Path) -> Option<LoopState> {
        let project = std::fs::canonicalize(project).unwrap_or_else(|_| project.to_path_buf());
        let guard = self.active.lock().await;
        match guard.as_ref() {
            Some(active) if active.shared.project == project => {
                Some(active.shared.state.lock().await.clone())
            }
            _ => load_latest_state(&project),
        }
    }

    /// True while a non-terminal loop targets `project` — used so `chat_send`
    /// can refuse with "auto mode is running".
    pub async fn is_running_for(&self, project: &Path) -> bool {
        let guard = self.active.lock().await;
        match guard.as_ref() {
            Some(a) if a.shared.project == project => {
                a.shared.state.lock().await.status.is_active()
            }
            _ => false,
        }
    }
}

/// Drives one loop to completion. Owns everything the iteration needs.
struct Driver {
    app: AppHandle,
    shared: Arc<LoopShared>,
    settings: Settings,
    mcp_config: PathBuf,
    mcp_entry: McpEntry,
    goal: String,
    options: LoopOptions,
    _permit: crate::execution::ProjectPermit,
}

impl Driver {
    async fn run(self) {
        // Codex reports tokens, not dollars, so `cost_usd` is never populated and
        // the running total would sit at $0 forever — a budget cap that silently
        // never fires. Disable it outright and say so; `max_iterations` is then
        // the real bound.
        let max_cost = if self.backend().reports_cost() {
            self.options.max_cost_usd
        } else {
            if self.options.max_cost_usd > 0.0 {
                self.warn_once(
                    "Budget cap: Codex doesn't report per-turn cost, so the $ cap is \
                     inactive — this loop is bounded by the iteration cap instead.",
                )
                .await;
            }
            f64::INFINITY
        };
        let max_iter = self.options.max_iterations;
        let qa_enabled = self.options.qa_every > 0;

        let mut strikes: u32 = 0;
        let mut prev_summary = String::new();
        let mut qa_feedback: Option<String> = None;
        let mut user_feedback: Vec<String> = Vec::new();
        let mut builder_session: Option<String> = None;
        let mut total_cost = 0.0f64;
        let mut i: u32 = 0;

        loop {
            if self.stopped() {
                self.finish(LoopStatus::Stopped).await;
                return;
            }

            // ---- Builder turn ----
            let run_id = format!("loop:{}:{}:builder", self.shared.loop_id, i);
            self.set_current_run(Some(run_id.clone())).await;
            let prompt = builder_prompt(
                i,
                &self.goal,
                &self.options.reference_images,
                &prev_summary,
                qa_feedback.as_deref(),
                &user_feedback,
                self.options.continuation_context.as_deref(),
            );
            user_feedback.clear();
            let args = self.turn_args(builder_session.as_deref(), 60);
            let info = self.run_turn(run_id, args, prompt).await;
            self.set_current_run(None).await;

            if self.stopped() {
                self.finish(LoopStatus::Stopped).await;
                return;
            }
            let info = match info {
                Ok(info) => info,
                Err(error) => {
                    self.fail_turn(&error, "builder", i).await;
                    return;
                }
            };

            total_cost = reflect::add_cost(total_cost, info.cost_usd);
            if let Some(sid) = info.session_id.clone() {
                builder_session = Some(sid);
            }

            let reflection = reflect::reflect_builder(info.result_text.as_deref().unwrap_or(""));
            strikes = reflect::next_strikes(reflection.verdict, strikes);
            prev_summary = reflection.summary.clone();

            // Prefer our own capture; fall back to the (possibly stale) path the
            // builder reported.
            let screenshot = self
                .capture_iter(i)
                .await
                .or_else(|| reflection.screenshot_path.clone());
            let commit = self.git_checkpoint(i, &reflection.summary).await;

            self.push_iteration(
                LoopIteration {
                    index: i,
                    verdict: reflection.verdict.as_str().to_string(),
                    summary: reflection.summary.clone(),
                    cost_usd: info.cost_usd.unwrap_or(0.0),
                    screenshot_path: screenshot,
                    commit_sha: commit,
                    qa: None,
                },
                total_cost,
            )
            .await;

            let step = reflect::feedback_step(
                self.stopped(),
                total_cost,
                max_cost,
                self.has_pending_feedback().await,
            )
            .unwrap_or_else(|| {
                reflect::decide_after_builder(
                    self.stopped(),
                    total_cost,
                    max_cost,
                    reflection.verdict,
                    strikes,
                    qa_enabled,
                )
            });

            match step {
                Step::Stopped => return self.finish(LoopStatus::Stopped).await,
                Step::CostCapped => return self.finish(LoopStatus::CostCapped).await,
                Step::Blocked => return self.finish(LoopStatus::Blocked).await,
                Step::Done => return self.finish(LoopStatus::Done).await,
                Step::MaxIterations => return self.finish(LoopStatus::MaxIterations).await,
                Step::RunQa => {
                    // ---- QA critic (cold: no --resume) ----
                    let qa_run_id = format!("loop:{}:{}:qa", self.shared.loop_id, i);
                    self.set_current_run(Some(qa_run_id.clone())).await;
                    let qa_prompt = qa_prompt(&self.goal, &self.options.reference_images);
                    let qa_args = self.turn_args(None, 40);
                    let qa_info = self.run_turn(qa_run_id, qa_args, qa_prompt).await;
                    self.set_current_run(None).await;

                    if self.stopped() {
                        return self.finish(LoopStatus::Stopped).await;
                    }
                    let qa_info = match qa_info {
                        Ok(info) => info,
                        Err(error) => {
                            self.fail_turn(&error, "qa", i).await;
                            return;
                        }
                    };
                    total_cost = reflect::add_cost(total_cost, qa_info.cost_usd);
                    let qa = reflect::parse_qa(qa_info.result_text.as_deref().unwrap_or(""));
                    // Record the *effective* verdict, so a review the gate
                    // rejected never shows up in the UI as a pass.
                    let qa_result = qa.as_ref().map(|q| QaResult {
                        pass: q.accepted(),
                        score: q.score,
                        notes: q.feedback(),
                    });
                    self.set_iteration_qa(i, qa_result, total_cost).await;

                    let qa_step = reflect::decide_after_qa(
                        self.stopped(),
                        total_cost,
                        max_cost,
                        qa.as_ref().map(|q| q.accepted()),
                    );
                    let step2 = reflect::feedback_step(
                        self.stopped(),
                        total_cost,
                        max_cost,
                        self.has_pending_feedback().await,
                    )
                    .unwrap_or(qa_step);
                    match step2 {
                        Step::Done => return self.finish(LoopStatus::Done).await,
                        Step::Stopped => return self.finish(LoopStatus::Stopped).await,
                        Step::CostCapped => return self.finish(LoopStatus::CostCapped).await,
                        _ => {
                            // QA failed → carry its notes into the next builder.
                            qa_feedback =
                                qa.map(|q| q.feedback()).filter(|n| !n.trim().is_empty());
                            if reflect::gate_iterations(i + 1, max_iter) == Step::MaxIterations {
                                return self.finish(LoopStatus::MaxIterations).await;
                            }
                            user_feedback = self.take_pending_feedback(i + 1).await;
                            i += 1;
                        }
                    }
                }
                Step::Continue => {
                    qa_feedback = None;
                    if reflect::gate_iterations(i + 1, max_iter) == Step::MaxIterations {
                        return self.finish(LoopStatus::MaxIterations).await;
                    }
                    user_feedback = self.take_pending_feedback(i + 1).await;
                    i += 1;
                }
            }
        }
    }

    fn stopped(&self) -> bool {
        self.shared.stop.load(Ordering::SeqCst)
    }

    /// The agent backend this loop was started with. Snapshotted in `settings`
    /// at `loop_start`, so flipping the picker mid-loop can't swap the CLI
    /// underneath a resumed session.
    fn backend(&self) -> Backend {
        self.options.agent.backend
    }

    /// Build the argv for one turn: the shared chat flags + resume (builder only)
    /// + a per-run turn cap (Claude enforces it; Codex ignores it).
    fn turn_args(&self, resume: Option<&str>, max_turns: u32) -> Vec<String> {
        build_args(
            self.backend(),
            &self.settings,
            &FlagInput {
                mcp_config_path: &self.mcp_config,
                mcp_entry: &self.mcp_entry,
                resume_session_id: resume,
                max_turns: Some(max_turns),
                run_options: Some(&self.options.agent),
                read_only: false,
            },
        )
    }

    /// Spawn one turn, register its child for cancellation, await the result.
    async fn run_turn(
        &self,
        run_id: String,
        args: Vec<String>,
        prompt: String,
    ) -> Result<ExitInfo, String> {
        match spawn_streaming(
            self.app.clone(),
            self.backend(),
            run_id,
            &self.shared.project,
            args,
            prompt,
        ) {
            Ok((handle, join)) => {
                *self.shared.child.lock().await = Some(handle);
                let joined = join.await;
                *self.shared.child.lock().await = None;
                let info = joined.map_err(|error| format!("agent stream task failed: {error}"))?;
                if let Some(error) = turn_failure(self.backend(), &info) {
                    Err(error)
                } else {
                    Ok(info)
                }
            }
            Err(error) => Err(error.to_string()),
        }
    }

    async fn fail_turn(&self, error: &str, phase: &str, iteration: u32) {
        let message = first_meaningful_line(error);
        {
            let mut state = self.shared.state.lock().await;
            state.failure = Some(LoopFailure {
                message: message.clone(),
                phase: phase.to_string(),
                iteration,
            });
        }
        self.warn_once(&format!(
            "{} task failed: {message}",
            self.backend().label()
        ))
        .await;
        self.finish(LoopStatus::Failed).await;
    }

    /// Capture the game view into `iter-<i>.png`. Tolerant: `None` on any error.
    async fn capture_iter(&self, i: u32) -> Option<String> {
        let params = serde_json::json!({ "width": 960, "height": 540, "format": "png" });
        let result = crate::bridge::call(&self.shared.project, "screenshot.gameView", params)
            .await
            .ok()?;
        let b64 = result.get("pngBase64").and_then(|v| v.as_str())?;
        let bytes = base64::engine::general_purpose::STANDARD.decode(b64).ok()?;
        let file = self.shared.dir.join(format!("iter-{i}.png"));
        std::fs::write(&file, bytes).ok()?;
        Some(file.to_string_lossy().into_owned())
    }

    /// Commit the iteration's changes. Returns the short sha, or `None` when
    /// there's nothing to commit / no repo (recording a one-time warning).
    async fn git_checkpoint(&self, i: u32, summary: &str) -> Option<String> {
        let project = self.shared.project.clone();
        let loop8: String = self.shared.loop_id.chars().take(8).collect();
        let summary = summary.to_string();
        let res =
            tokio::task::spawn_blocking(move || git_commit(&project, &loop8, i, &summary)).await;
        match res {
            Ok(Ok(sha)) => sha,
            Ok(Err(msg)) => {
                self.warn_once(&format!("git: {}", first_meaningful_line(&msg)))
                    .await;
                None
            }
            Err(_) => None,
        }
    }

    async fn warn_once(&self, warning: &str) {
        let prefix = warning.split(':').next().unwrap_or(warning).to_string();
        let mut st = self.shared.state.lock().await;
        if !st.warnings.iter().any(|w| w.starts_with(&prefix)) {
            st.warnings.push(warning.to_string());
        }
    }

    async fn push_iteration(&self, iter: LoopIteration, total_cost: f64) {
        {
            let mut st = self.shared.state.lock().await;
            st.iterations.push(iter);
            st.total_cost_usd = total_cost;
        }
        persist_and_emit(&self.app, &self.shared).await;
    }

    async fn set_iteration_qa(&self, index: u32, qa: Option<QaResult>, total_cost: f64) {
        {
            let mut st = self.shared.state.lock().await;
            if let Some(it) = st.iterations.iter_mut().find(|it| it.index == index) {
                it.qa = qa;
            }
            st.total_cost_usd = total_cost;
        }
        persist_and_emit(&self.app, &self.shared).await;
    }

    async fn set_current_run(&self, run_id: Option<String>) {
        {
            let mut st = self.shared.state.lock().await;
            st.current_run_id = run_id;
        }
        persist_and_emit(&self.app, &self.shared).await;
    }

    async fn has_pending_feedback(&self) -> bool {
        self.shared
            .state
            .lock()
            .await
            .feedback
            .iter()
            .any(|feedback| feedback.applied_at_iteration.is_none())
    }

    async fn take_pending_feedback(&self, iteration: u32) -> Vec<String> {
        let feedback = {
            let mut state = self.shared.state.lock().await;
            let mut texts = Vec::new();
            for item in &mut state.feedback {
                if item.applied_at_iteration.is_none() {
                    item.applied_at_iteration = Some(iteration);
                    texts.push(item.text.clone());
                }
            }
            texts
        };
        if !feedback.is_empty() {
            persist_and_emit(&self.app, &self.shared).await;
        }
        feedback
    }

    async fn finish(&self, status: LoopStatus) {
        {
            let mut st = self.shared.state.lock().await;
            st.status = status;
            st.current_run_id = None;
        }
        persist_and_emit(&self.app, &self.shared).await;
    }
}

fn turn_failure(backend: Backend, info: &ExitInfo) -> Option<String> {
    if info.cancelled {
        return Some("The task was cancelled.".into());
    }
    if info.is_error {
        return info
            .error_text
            .as_deref()
            .filter(|text| !text.trim().is_empty())
            .or_else(|| (!info.stderr_tail.trim().is_empty()).then_some(info.stderr_tail.as_str()))
            .or_else(|| {
                info.result_text.as_deref().filter(|text| {
                    let trimmed = text.trim_start();
                    !trimmed.is_empty() && !trimmed.starts_with("```json")
                })
            })
            .map(str::to_string)
            .or_else(|| Some(format!("{} returned an error.", backend.label())));
    }
    if !info.result_seen {
        return Some(crate::agent::spawn::friendly_spawn_error(
            backend,
            &info.stderr_tail,
            info.exit_code,
        ));
    }
    None
}

/// Persist the state to `state.json` and broadcast it on `loop:update`.
async fn persist_and_emit(app: &AppHandle, shared: &LoopShared) {
    let snapshot = shared.state.lock().await.clone();
    if let Ok(bytes) = serde_json::to_vec_pretty(&snapshot) {
        let _ = std::fs::write(shared.dir.join("state.json"), bytes);
    }
    let _ = app.emit("loop:update", &snapshot);
}

fn load_latest_state(project: &Path) -> Option<LoopState> {
    let root = project.join(".unity-vibe").join("loop");
    let mut candidates = std::fs::read_dir(root)
        .ok()?
        .filter_map(Result::ok)
        .map(|entry| entry.path().join("state.json"))
        .filter_map(|path| {
            let modified = std::fs::metadata(&path).ok()?.modified().ok()?;
            Some((modified, path))
        })
        .collect::<Vec<_>>();
    candidates.sort_by(|left, right| right.cmp(left));

    for (_, path) in candidates {
        let Ok(bytes) = std::fs::read(&path) else {
            continue;
        };
        let Ok(mut state) = serde_json::from_slice::<LoopState>(&bytes) else {
            continue;
        };
        if state.status.is_active() {
            let run_id = state.current_run_id.as_deref().unwrap_or("");
            let phase = if run_id.ends_with(":qa") {
                "qa"
            } else {
                "builder"
            };
            let iteration = run_id
                .split(':')
                .rev()
                .nth(1)
                .and_then(|value| value.parse().ok())
                .unwrap_or(state.iterations.len() as u32);
            state.status = LoopStatus::Failed;
            state.current_run_id = None;
            state.failure = Some(LoopFailure {
                message: "Studio closed while this agent step was still running.".into(),
                phase: phase.into(),
                iteration,
            });
            if let Ok(updated) = serde_json::to_vec_pretty(&state) {
                let _ = std::fs::write(&path, updated);
            }
        }
        return Some(state);
    }
    None
}

// --- git checkpoint (blocking) -------------------------------------------------

/// `git add -A && git commit -m … && git rev-parse --short HEAD` for `project`,
/// via the shared [`crate::gitutil`] helpers. `Ok(None)` = benign no-op (nothing
/// to commit); `Err` = git unavailable / not a repo (surfaced once as a
/// warning). Never pushes.
fn git_commit(
    project: &Path,
    loop8: &str,
    i: u32,
    summary: &str,
) -> Result<Option<String>, String> {
    // An `add -A` failure is almost always "not a git repository" → Err.
    crate::gitutil::add_all(project)?;
    let msg = format!(
        "vibe-loop {} iter {}: {}",
        loop8,
        i,
        trim_summary(summary, 72)
    );
    // "nothing to commit" (clean tree) and any other commit no-op are non-fatal
    // — just no checkpoint this iteration.
    if !crate::gitutil::commit(project, &msg)? {
        return Ok(None);
    }
    crate::gitutil::head_short(project)
}

// --- prompts -------------------------------------------------------------------

/// Shared tail appended to every builder prompt: the verify → screenshot →
/// fenced-verdict contract the reflector depends on.
const BUILDER_TAIL: &str = "\n\nAfter you make changes, run unity_verify to confirm the project compiles and the tests pass, then capture the result with unity_capture_game_view.\n\nEND your reply with EXACTLY one fenced json block and NOTHING after it:\n```json\n{\"status\":\"done|continue|blocked\",\"summary\":\"<one sentence>\",\"screenshotPath\":\"<absolute path to your screenshot, or empty>\"}\n```\nUse \"done\" ONLY when the WHOLE goal is achieved and unity_verify passes. Use \"continue\" when there is more to do. Use \"blocked\" only if you genuinely cannot make progress.";

fn reference_block(images: &[String]) -> String {
    if images.is_empty() {
        "(none provided)".into()
    } else {
        images
            .iter()
            .map(|p| format!("- {p}"))
            .collect::<Vec<_>>()
            .join("\n")
    }
}

fn builder_prompt(
    i: u32,
    goal: &str,
    images: &[String],
    prev_summary: &str,
    qa_feedback: Option<&str>,
    user_feedback: &[String],
    continuation_context: Option<&str>,
) -> String {
    let refs = reference_block(images);
    let feedback = feedback_block(user_feedback);
    if i == 0 {
        let continuation = continuation_context
            .filter(|context| !context.trim().is_empty())
            .map(|context| {
                format!(
                    "\n\nCONTINUATION CONTEXT:\n{}\n\nThis is not a blank-slate first step. Inspect the current project state and implement the NEXT remaining increment.",
                    context.trim()
                )
            })
            .unwrap_or_else(|| {
                "\n\nThis is the first iteration. Implement the FIRST small, safe increment toward the goal — do not attempt everything at once.".into()
            });
        format!(
            "You are an autonomous Unity build agent working toward a goal, one small increment at a time.\n\nGOAL:\n{goal}\n\nReference images:\n{refs}{feedback}{continuation}{BUILDER_TAIL}"
        )
    } else {
        let qa = match qa_feedback {
            Some(notes) if !notes.trim().is_empty() => {
                format!("\n\nQA feedback on the current state (address this):\n{notes}")
            }
            _ => String::new(),
        };
        format!(
            "Continue working toward the goal.\n\nGOAL:\n{goal}\n\nReference images:\n{refs}\n\nPrevious iteration summary: {prev_summary}{qa}{feedback}\n\nImplement the NEXT small increment toward the goal.{BUILDER_TAIL}"
        )
    }
}

fn feedback_block(feedback: &[String]) -> String {
    if feedback.is_empty() {
        return String::new();
    }
    let items = feedback
        .iter()
        .map(|text| format!("- {}", text.trim()))
        .collect::<Vec<_>>()
        .join("\n");
    format!(
        "\n\nUSER FEEDBACK RECEIVED DURING THE PREVIOUS STEP:\n{items}\n\nBefore acting, reconsider your plan against this feedback. Treat it as current user direction and address it in this step."
    )
}

fn qa_prompt(goal: &str, images: &[String]) -> String {
    let refs = reference_block(images);
    format!(
        "You are a harsh, skeptical QA reviewer. Judge whether this goal has been FULLY achieved in the CURRENT state of the Unity project.\n\nGOAL:\n{goal}\n\nReference images:\n{refs}\n\nJudge in this order:\n\n1. Run `unity_qa` FIRST. It is the ground truth — compile status, console errors, tests, missing scripts and dangling references come back as structured checks, and your opinion does not override it. Report what it returned in the `gate` field: \"pass\" if every check passed (checks it reports as skipped are not failures), \"fail\" if any check failed, \"unavailable\" if the tool could not run at all.\n2. Then judge the goal itself. Use unity_capture_game_view to see the current game view, and unity_enter_play_mode / unity_simulate_input if runtime behaviour matters.\n\nSet `pass` to true only when the gate passed AND the goal is fully met. A good-looking screenshot over a failing gate is not a pass. Be strict — do not pass work that is incomplete or visibly wrong.\n\nEND your reply with EXACTLY one fenced json block and NOTHING after it:\n```json\n{{\"pass\":true|false,\"gate\":\"pass|fail|unavailable\",\"score\":0,\"notes\":\"<what is wrong, or what is good>\"}}\n```"
    )
}

// --- small helpers -------------------------------------------------------------

fn trim_summary(s: &str, max: usize) -> String {
    let one_line = s.replace('\n', " ");
    let one_line = one_line.trim();
    if one_line.chars().count() <= max {
        one_line.to_string()
    } else {
        one_line.chars().take(max).collect()
    }
}

fn first_meaningful_line(s: &str) -> String {
    s.lines()
        .map(str::trim)
        .find(|line| !line.is_empty() && !line.starts_with("```") && *line != "{" && *line != "}")
        .unwrap_or("The agent stopped unexpectedly.")
        .trim_matches(|character| character == '"' || character == ',')
        .to_string()
}

fn normalize_feedback(text: &str) -> Result<String, String> {
    let text = text.trim();
    if text.is_empty() {
        return Err("Write a comment before adding feedback.".into());
    }
    if text.chars().count() > 2_000 {
        return Err("Feedback is limited to 2,000 characters.".into());
    }
    Ok(text.to_string())
}

fn feedback_target_iteration(state: &LoopState) -> u32 {
    let completed = state.iterations.len() as u32;
    match state.current_run_id.as_deref() {
        Some(run_id) if run_id.ends_with(":builder") => completed + 1,
        _ => completed,
    }
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_state() -> LoopState {
        LoopState {
            loop_id: "loop".into(),
            goal: "goal".into(),
            reference_images: vec![],
            status: LoopStatus::Running,
            iterations: vec![],
            total_cost_usd: 0.0,
            options: LoopOptions {
                max_iterations: 10,
                max_cost_usd: 5.0,
                qa_every: 1,
                reference_images: vec![],
                agent: AgentRunOptions::default(),
                continuation_context: None,
            },
            warnings: vec![],
            feedback: vec![],
            failure: None,
            current_run_id: Some("loop:1:0:builder".into()),
        }
    }

    #[test]
    fn builder_prompt_switches_on_iteration() {
        let first = builder_prompt(0, "make a cube", &[], "", None, &[], None);
        assert!(first.contains("first iteration"));
        assert!(first.contains("make a cube"));
        assert!(first.contains("```json"));

        let later = builder_prompt(
            2,
            "make a cube",
            &["/tmp/ref.png".into()],
            "added a plane",
            Some("cube is the wrong colour"),
            &["Make it twice as large.".into()],
            None,
        );
        assert!(later.contains("Previous iteration summary: added a plane"));
        assert!(later.contains("cube is the wrong colour"));
        assert!(later.contains("/tmp/ref.png"));
        assert!(later.contains("USER FEEDBACK"));
        assert!(later.contains("Make it twice as large."));

        let continued = builder_prompt(
            0,
            "make a cube",
            &[],
            "",
            None,
            &[],
            Some("Step 1 already added the cube."),
        );
        assert!(continued.contains("CONTINUATION CONTEXT"));
        assert!(continued.contains("Step 1 already added the cube."));
        assert!(continued.contains("not a blank-slate first step"));
    }

    #[test]
    fn qa_prompt_mentions_goal_and_block() {
        let p = qa_prompt("ship the level", &[]);
        assert!(p.contains("ship the level"));
        assert!(p.contains("\"pass\""));
        // The critic is required to run the ground-truth gate and report it.
        assert!(p.contains("unity_qa"));
        assert!(p.contains("\"gate\""));
    }

    #[test]
    fn summary_trims_to_one_line_and_length() {
        let s = trim_summary("line one\nline two that is quite long", 12);
        assert_eq!(s, "line one lin");
    }

    #[test]
    fn legacy_loop_options_default_to_automatic_claude_controls() {
        let options: LoopOptions = serde_json::from_value(serde_json::json!({
            "maxIterations": 10,
            "maxCostUsd": 5.0,
            "qaEvery": 1,
            "referenceImages": []
        }))
        .unwrap();
        assert_eq!(options.agent, AgentRunOptions::default());
    }

    #[test]
    fn failed_agent_turns_do_not_become_fake_unknown_iterations() {
        let missing = ExitInfo {
            stderr_tail: "not logged in".into(),
            exit_code: Some(1),
            ..ExitInfo::default()
        };
        assert!(turn_failure(Backend::Codex, &missing)
            .unwrap()
            .contains("Sign in"));

        let partial = ExitInfo {
            is_error: true,
            result_seen: true,
            result_text: Some("```json\n{\"status\":\"continue\"}\n```".into()),
            ..ExitInfo::default()
        };
        assert_eq!(
            turn_failure(Backend::Codex, &partial).as_deref(),
            Some("Codex returned an error.")
        );

        let valid = ExitInfo {
            result_seen: true,
            result_text: Some("done".into()),
            ..ExitInfo::default()
        };
        assert!(turn_failure(Backend::Claude, &valid).is_none());
    }

    #[test]
    fn feedback_is_trimmed_bounded_and_targets_the_next_builder() {
        assert_eq!(
            normalize_feedback("  make it blue  ").unwrap(),
            "make it blue"
        );
        assert!(normalize_feedback("   ").is_err());
        assert!(normalize_feedback(&"x".repeat(2_001)).is_err());

        let mut state = test_state();
        assert_eq!(feedback_target_iteration(&state), 1);
        state.current_run_id = Some("loop:1:0:qa".into());
        state.iterations.push(LoopIteration {
            index: 0,
            verdict: "done".into(),
            summary: String::new(),
            cost_usd: 0.0,
            screenshot_path: None,
            commit_sha: None,
            qa: None,
        });
        assert_eq!(feedback_target_iteration(&state), 1);
    }

    #[test]
    fn reloads_an_interrupted_run_as_recoverable_failure() {
        let project =
            std::env::temp_dir().join(format!("unity-vibe-loop-test-{}", nanoid::nanoid!()));
        let loop_dir = project.join(".unity-vibe").join("loop").join("saved-loop");
        std::fs::create_dir_all(&loop_dir).unwrap();

        let mut state = test_state();
        state.current_run_id = Some("loop:saved-loop:4:builder".into());
        let path = loop_dir.join("state.json");
        std::fs::write(&path, serde_json::to_vec_pretty(&state).unwrap()).unwrap();

        let restored = load_latest_state(&project).unwrap();
        assert_eq!(restored.status, LoopStatus::Failed);
        assert_eq!(restored.current_run_id, None);
        let failure = restored.failure.unwrap();
        assert_eq!(failure.phase, "builder");
        assert_eq!(failure.iteration, 4);

        let persisted: LoopState = serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap();
        assert_eq!(persisted.status, LoopStatus::Failed);
        std::fs::remove_dir_all(project).unwrap();
    }
}
