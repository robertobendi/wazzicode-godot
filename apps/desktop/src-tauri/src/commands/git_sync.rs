//! The chat "Synchronize" commands: status check + commit/fetch/pull/merge/push.

use crate::error::{AppError, AppResult};
use crate::gitsync::{SyncReport, SyncStatus};
use std::path::PathBuf;

/// Synchronize `project` with its git remote. Blocking git work runs off the
/// async runtime. A non-repo (or a conflict) comes back as a message, not a
/// panic; the report's `steps`/`summary` describe exactly what happened.
#[tauri::command]
pub async fn git_synchronize(
    project: String,
    message: Option<String>,
) -> AppResult<SyncReport> {
    tokio::task::spawn_blocking(move || {
        crate::gitsync::synchronize(&PathBuf::from(&project), message.as_deref())
    })
    .await
    .map_err(|e| AppError::Other(format!("sync task failed: {e}")))?
    .map_err(AppError::Other)
}

/// Cheap "is there anything to sync?" probe for the button's attention state.
/// `fetch` contacts the remote when true; the webview throttles that so a repo
/// isn't fetched after every single run.
#[tauri::command]
pub async fn git_sync_status(project: String, fetch: bool) -> AppResult<SyncStatus> {
    tokio::task::spawn_blocking(move || {
        crate::gitsync::sync_status(&PathBuf::from(&project), fetch)
    })
    .await
    .map_err(|e| AppError::Other(format!("sync status task failed: {e}")))?
    .map_err(AppError::Other)
}
