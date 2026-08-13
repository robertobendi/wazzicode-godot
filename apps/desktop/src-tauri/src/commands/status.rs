//! Bridge status-loop commands.

use crate::error::AppResult;
use crate::state::AppState;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager, State};

/// Start (or restart) the 2s Unity bridge status poller for `project`. Emits
/// `status:update` events. Also (re)grants the project's inbox dir to the asset
/// protocol so pasted/dropped image thumbnails render — machine-specific, so
/// granted at runtime like the captures dir in lib.rs (this is the "project set
/// or changed" moment the frontend drives).
#[tauri::command]
pub async fn status_start(
    app: AppHandle,
    project: String,
    state: State<'_, AppState>,
) -> AppResult<()> {
    grant_inbox_scope(&app, Path::new(&project));
    crate::bridge::start_status_loop(app, &state, PathBuf::from(project)).await;
    Ok(())
}

/// Create `<project>/.unity-vibe/inbox` and allow the webview to render files
/// under it via `convertFileSrc`. Best-effort: log and continue on failure.
fn grant_inbox_scope(app: &AppHandle, project: &Path) {
    let inbox = project.join(".unity-vibe").join("inbox");
    if let Err(e) = std::fs::create_dir_all(&inbox) {
        log::warn!("could not create inbox dir: {e}");
        return;
    }
    if let Err(e) = app.asset_protocol_scope().allow_directory(&inbox, true) {
        log::warn!("could not grant inbox dir to asset scope: {e}");
    }
}

/// Stop the status poller.
#[tauri::command]
pub async fn status_stop(state: State<'_, AppState>) -> AppResult<()> {
    crate::bridge::stop_status_loop(&state).await;
    Ok(())
}
