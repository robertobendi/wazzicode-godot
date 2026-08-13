//! Chat commands: spawn/cancel a headless agent run against a project.

use crate::agent::flags::{build_args, FlagInput};
use crate::agent::AgentRunOptions;
use crate::error::AppResult;
use crate::state::AppState;
use std::path::PathBuf;
use tauri::{AppHandle, Emitter, State};

/// Start a chat turn. Writes the app-managed MCP config, builds the argv from
/// current settings, spawns the selected agent backend (Claude or Codex), and
/// returns the `runId` the frontend subscribes to (`agent:stream:<runId>`,
/// `agent:done:<runId>`, `agent:error:<runId>`). Errors with `"busy"` if a run
/// is already active for the project.
#[tauri::command]
pub async fn chat_send(
    app: AppHandle,
    project: String,
    prompt: String,
    resume_session_id: Option<String>,
    options: AgentRunOptions,
    state: State<'_, AppState>,
) -> AppResult<String> {
    options.validate()?;
    let project_path = PathBuf::from(&project);
    // Self-heal any old/manual read-only project config before the MCP server
    // starts. Users should never have to run a permission command themselves.
    crate::commands::project::ensure_project_access(&project_path)?;
    // Chat and auto mode are mutually exclusive per project.
    if state.loops.is_running_for(&project_path).await {
        return Err(crate::error::AppError::Other(
            "busy: auto mode is running".into(),
        ));
    }
    let permit = state
        .executions
        .try_acquire(&project_path)
        .ok_or_else(|| crate::error::AppError::Other("busy: another task is running".into()))?;

    // Safety net: before the AI touches anything, take a "studio checkpoint" —
    // a git commit of the project as it stands now — so the user can undo the
    // whole turn later. No-op (and revert stays hidden) when the project isn't a
    // git repo. Blocking git work runs off the async runtime.
    let cp_project = project_path.clone();
    let cp_prompt = prompt.clone();
    let checkpoint = tokio::task::spawn_blocking(move || {
        crate::gitutil::make_checkpoint(&cp_project, &cp_prompt)
    })
    .await
    .ok()
    .flatten();
    if let Some(cp) = checkpoint {
        state
            .checkpoints
            .lock()
            .await
            .insert(project_path.clone(), cp.clone());
        // The webview shows the "Undo last change" button once the turn ends;
        // it gates on `running`, so surfacing the checkpoint now is fine.
        let _ = app.emit("checkpoint:ready", &cp);
    }

    let mcp_config = crate::mcpconfig::ensure_mcp_config(&app, &state.config_dir, &project_path)?;
    let mcp_entry = crate::mcpconfig::mcp_entry(&app, &project_path);
    let settings = state.settings.read().await.clone();
    let backend = options.backend;
    let args = build_args(
        backend,
        &settings,
        &FlagInput {
            mcp_config_path: &mcp_config,
            mcp_entry: &mcp_entry,
            resume_session_id: resume_session_id.as_deref(),
            // Chat turns are user-paced; only the auto-loop caps turns.
            max_turns: None,
            run_options: Some(&options),
            read_only: false,
        },
    );
    state
        .sessions
        .start_run(app, backend, project_path, prompt, args, permit)
        .await
}

/// Stop the active run (kills the Claude process tree). No-op if it already
/// finished.
#[tauri::command]
pub async fn chat_cancel(run_id: String, state: State<'_, AppState>) -> AppResult<()> {
    state.sessions.cancel(&run_id).await;
    Ok(())
}

/// Complete the listener handshake. Fast failures are cached until this call,
/// so a task can never finish in the gap before the webview knows its run id.
#[tauri::command]
pub async fn chat_subscribe(
    run_id: String,
    state: State<'_, AppState>,
) -> AppResult<Option<crate::agent::session::TerminalEvent>> {
    Ok(state.sessions.subscribe(&run_id))
}
