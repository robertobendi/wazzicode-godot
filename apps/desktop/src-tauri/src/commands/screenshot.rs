//! Live Godot 2D/3D editor viewport capture for the activity panel.

use crate::error::{AppError, AppResult};
use crate::state::AppState;
use base64::Engine;
use serde::Serialize;
use std::path::PathBuf;
use tauri::State;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptureResult {
    pub png_path: String,
}

#[tauri::command]
pub async fn bridge_capture(
    project: String,
    kind: String,
    state: State<'_, AppState>,
) -> AppResult<CaptureResult> {
    let project_path = PathBuf::from(&project);
    let (method, width, height, file_kind) = capture_spec(&kind);
    let result = crate::bridge::call(
        &project_path,
        method,
        serde_json::json!({ "width": width, "height": height }),
    )
    .await?;
    let encoded = result
        .get("pngBase64")
        .and_then(|value| value.as_str())
        .ok_or_else(|| AppError::Other("Godot bridge returned no image".into()))?;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(encoded)
        .map_err(|error| AppError::Other(format!("decode image: {error}")))?;

    let directory = state.config_dir.join("captures");
    std::fs::create_dir_all(&directory)?;
    let file = directory.join(format!(
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
        "3d" => ("viewport.capture3D", 960, 540, "3d"),
        _ => ("viewport.capture2D", 960, 540, "2d"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn capture_kinds_map_to_verified_addon_methods() {
        assert_eq!(capture_spec("2d").0, "viewport.capture2D");
        assert_eq!(capture_spec("3d").0, "viewport.capture3D");
        assert_eq!(capture_spec("unknown").3, "2d");
    }
}
