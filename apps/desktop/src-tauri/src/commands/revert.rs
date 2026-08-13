//! Revert command — the "Undo last change" safety net.
//!
//! Before every chat turn, [`chat_send`](super::chat::chat_send) takes a
//! *studio checkpoint* (a git commit of the project as it stood just before the
//! AI touched it) and stashes it in [`AppState::checkpoints`]. `revert_last`
//! rolls the project back to that checkpoint: `git reset --hard <sha>` plus a
//! `git clean -fd` that removes AI-created untracked files while preserving the
//! studio's own state dir (`.unity-vibe/`).
//!
//! It refuses to run while a chat or auto-loop is active for the project (you
//! can't rewind under a live edit), and clears the checkpoint once reverted so
//! the button hides until the next turn.

use crate::error::{AppError, AppResult};
use crate::state::AppState;
use serde::Serialize;
use std::path::PathBuf;
use tauri::State;

/// Outcome of a revert, mirrored to the webview as camelCase.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RevertResult {
    pub ok: bool,
    /// The short sha the project was restored to.
    pub restored_to: String,
}

/// Roll `project` back to its last studio checkpoint. Errors if nothing is
/// available to undo, or if a chat/loop is still running for the project.
#[tauri::command]
pub async fn revert_last(project: String, state: State<'_, AppState>) -> AppResult<RevertResult> {
    let project_path = PathBuf::from(&project);
    let _permit = state
        .executions
        .try_acquire(&project_path)
        .ok_or_else(|| AppError::Other("busy: another task is using this project".into()))?;

    // Guard: never rewind the tree out from under a live edit.
    if state.sessions.has_run_for(&project_path) || state.loops.is_running_for(&project_path).await
    {
        return Err(AppError::Other(
            "Something is still running — wait for it to finish, then undo.".into(),
        ));
    }

    let checkpoint = state.checkpoints.lock().await.get(&project_path).cloned();
    let Some(checkpoint) = checkpoint else {
        return Err(AppError::Other("There's nothing to undo yet.".into()));
    };

    let sha = checkpoint.sha.clone();
    let reset_project = project_path.clone();
    tokio::task::spawn_blocking(move || -> Result<(), String> {
        crate::gitutil::reset_hard(&reset_project, &sha)?;
        // Remove untracked files the AI created, but never the studio's own
        // state dir (sessions, inbox, loop scratch, config).
        crate::gitutil::clean(&reset_project, &[".unity-vibe/"])
    })
    .await
    .map_err(|e| AppError::Other(format!("revert task failed: {e}")))?
    .map_err(AppError::Other)?;

    // Consumed — hide the button until the next turn checkpoints again.
    state.checkpoints.lock().await.remove(&project_path);

    Ok(RevertResult {
        ok: true,
        restored_to: checkpoint.sha,
    })
}
