//! Codex sign-in commands (the Codex counterpart to `commands::pairing`).
//!
//! Thin wrappers over [`crate::codexauth`]. Credentials stay with the Codex CLI;
//! nothing here returns or persists a token. Sign-in is ChatGPT-subscription
//! only — there is intentionally no API-key command, because that would bill API
//! credits rather than the user's plan.

use crate::codexauth::CodexAuthStatus;
use crate::error::AppResult;
use crate::state::AppState;
use tauri::{AppHandle, State};

/// Is Codex installed, and is it signed in? Safe to poll.
#[tauri::command]
pub async fn codex_auth_status(state: State<'_, AppState>) -> AppResult<CodexAuthStatus> {
    Ok(state.codex_login.status().await)
}

/// Begin a browser sign-in. Progress arrives on the `codex:login` event.
#[tauri::command]
pub async fn codex_login_start(app: AppHandle, state: State<'_, AppState>) -> AppResult<()> {
    state.codex_login.start(app).await
}

/// Abort an in-flight browser sign-in.
#[tauri::command]
pub async fn codex_login_cancel(state: State<'_, AppState>) -> AppResult<()> {
    state.codex_login.cancel().await;
    Ok(())
}

/// Forget Codex credentials.
#[tauri::command]
pub async fn codex_logout(state: State<'_, AppState>) -> AppResult<()> {
    state.codex_login.logout().await
}
