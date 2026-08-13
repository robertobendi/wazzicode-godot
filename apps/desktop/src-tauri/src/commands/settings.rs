use crate::error::AppResult;
use crate::state::AppState;
use crate::store::settings::{save, Settings};
use tauri::State;

#[tauri::command]
pub async fn get_settings(state: State<'_, AppState>) -> AppResult<Settings> {
    Ok(state.settings.read().await.clone())
}

#[tauri::command]
pub async fn update_settings(
    settings: Settings,
    state: State<'_, AppState>,
) -> AppResult<Settings> {
    let mut current = state.settings.write().await;
    save(&state.config_dir, &settings)?;
    *current = settings.clone();
    Ok(settings)
}

/// Trivial liveness probe: confirms the Rust backend is reachable from the
/// webview. Used during startup/dev; harmless in release.
#[tauri::command]
pub async fn ping() -> AppResult<String> {
    Ok("pong".to_string())
}
