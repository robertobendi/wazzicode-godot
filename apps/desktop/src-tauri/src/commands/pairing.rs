//! Pairing + auth commands.
//!
//! `pairing_*` drives the hidden-PTY `claude setup-token` flow (state streamed
//! on `pairing:update`). `auth_*` tracks whether this machine is connected —
//! setup-token output is stored in the OS credential store and supplied only
//! to Claude child processes; `paired_ok` is the cheap persisted gate.

use crate::error::AppResult;
use crate::pairing::PairingState;
use crate::state::AppState;
use serde::Serialize;
use tauri::{AppHandle, State};

/// Begin pairing. Returns the pairing id used in `pairing_submit_code`. State
/// transitions arrive on the `pairing:update` event.
#[tauri::command]
pub async fn pairing_start(app: AppHandle, state: State<'_, AppState>) -> AppResult<String> {
    state.pairing.start(app)
}

/// Submit the admin's one-time code into the running pairing.
#[tauri::command]
pub async fn pairing_submit_code(
    app: AppHandle,
    pairing_id: String,
    code: String,
    state: State<'_, AppState>,
) -> AppResult<()> {
    state.pairing.submit_code(app, &pairing_id, &code)
}

/// Cancel / start over: kill the running pairing and return to idle.
#[tauri::command]
pub async fn pairing_cancel(app: AppHandle, state: State<'_, AppState>) -> AppResult<()> {
    state.pairing.cancel(app);
    Ok(())
}

/// Latest pairing state (UI refresh safety after a reload). `None` if no
/// pairing has run this session.
#[tauri::command]
pub async fn pairing_state(state: State<'_, AppState>) -> AppResult<Option<PairingState>> {
    Ok(state.pairing.snapshot())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthStatus {
    /// This machine has connected at least once (persisted flag). The app-level
    /// gate uses this cheap read and verifies the local auth status on demand.
    pub paired_ok: bool,
}

/// Whether this machine is marked connected. Read from settings only.
#[tauri::command]
pub async fn auth_status(state: State<'_, AppState>) -> AppResult<AuthStatus> {
    Ok(AuthStatus {
        paired_ok: state.settings.read().await.paired_ok,
    })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthVerify {
    pub ok: bool,
    pub error: Option<String>,
}

/// Live subscription-credential check: use the already-validated app-managed
/// setup token when present, otherwise require `claude auth status` to report a
/// first-party subscription. This makes no inference request.
#[tauri::command]
pub async fn auth_verify(state: State<'_, AppState>) -> AppResult<AuthVerify> {
    let res = tokio::task::spawn_blocking(crate::pairing::verify_subscription_status)
        .await
        .map_err(|e| crate::error::AppError::Other(format!("verify task failed: {e}")))?;

    {
        let ok = res.is_ok();
        let mut s = state.settings.write().await;
        if s.paired_ok != ok {
            s.paired_ok = ok;
            crate::store::settings::save(&state.config_dir, &s)?;
        }
    }

    Ok(match res {
        Ok(()) => AuthVerify {
            ok: true,
            error: None,
        },
        Err(e) => AuthVerify {
            ok: false,
            error: Some(e),
        },
    })
}

/// Forget the app-managed OAuth token and connection flag. CLI-managed `/login`
/// credentials are left untouched.
#[tauri::command]
pub async fn auth_clear(state: State<'_, AppState>) -> AppResult<()> {
    crate::claudeauth::clear_oauth_token()?;
    let mut s = state.settings.write().await;
    s.paired_ok = false;
    crate::store::settings::save(&state.config_dir, &s)?;
    Ok(())
}
