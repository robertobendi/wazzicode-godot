//! Live Game, Scene, or selected-object capture for the activity panel.
//!
//! Calls the matching Unity bridge screenshot method (result carries a base64
//! PNG), decodes it, and overwrites one per-project capture file.

use crate::error::{AppError, AppResult};
use crate::state::AppState;
use base64::Engine;
use serde::Serialize;
use std::path::PathBuf;
use tauri::State;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptureResult {
    /// Absolute path to the freshly-written PNG.
    pub png_path: String,
}

/// Capture a Unity view and write it to the per-project capture
/// file. Returns the path for the frontend to render. Bubbles up the friendly
/// bridge error codes (UNITY_NOT_CONNECTED / UNITY_RELOADING / …) on failure.
#[tauri::command]
pub async fn bridge_capture(
    project: String,
    kind: String,
    state: State<'_, AppState>,
) -> AppResult<CaptureResult> {
    let project_path = PathBuf::from(&project);
    let (method, width, height, file_kind) = capture_spec(&kind);
    let params = serde_json::json!({ "width": width, "height": height, "format": "png" });

    let result = crate::bridge::call(&project_path, method, params).await?;
    let b64 = result
        .get("pngBase64")
        .and_then(|v| v.as_str())
        .ok_or_else(|| AppError::Other("bridge returned no image".into()))?;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(b64)
        .map_err(|e| AppError::Other(format!("decode image: {e}")))?;

    let dir = state.config_dir.join("captures");
    std::fs::create_dir_all(&dir)?;
    let file = dir.join(format!(
        "{}-{file_kind}-latest.png",
        crate::mcpconfig::project_hash(&project_path),
    ));
    std::fs::write(&file, bytes)?;

    Ok(CaptureResult {
        png_path: file.to_string_lossy().into_owned(),
    })
}

fn capture_spec(kind: &str) -> (&'static str, u64, u64, &'static str) {
    match kind {
        "scene" => ("screenshot.sceneView", 960, 540, "scene"),
        "selected" => ("screenshot.selected", 768, 768, "selected"),
        _ => ("screenshot.gameView", 960, 540, "game"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn capture_kinds_map_to_verified_bridge_methods() {
        assert_eq!(capture_spec("game").0, "screenshot.gameView");
        assert_eq!(capture_spec("scene").0, "screenshot.sceneView");
        assert_eq!(
            capture_spec("selected"),
            ("screenshot.selected", 768, 768, "selected")
        );
        assert_eq!(capture_spec("unknown").0, "screenshot.gameView");
        assert_eq!(capture_spec("unknown").3, "game");
    }
}
