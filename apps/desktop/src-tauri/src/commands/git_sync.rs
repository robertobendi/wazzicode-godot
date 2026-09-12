//! The chat "Synchronize" command: commit, fetch, pull/merge, push.

use crate::error::{AppError, AppResult};
use crate::gitsync::SyncReport;
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
