//! Live, source-backed Godot editor status for the activity panel.

use crate::bridge;
use crate::error::{AppError, AppResult};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GodotDiagnosticsSnapshot {
    pub filesystem: FilesystemStatus,
    pub scenes: OpenScenes,
    pub play: PlayStatus,
    pub tests: TestStatus,
    pub captured_at: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FilesystemStatus {
    pub scanning: bool,
    pub importing: bool,
    pub progress: f64,
    pub indexed_files: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenScenes {
    #[serde(default)]
    pub scenes: Vec<SceneSummary>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub active_scene: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SceneSummary {
    pub path: String,
    pub name: String,
    #[serde(alias = "active")]
    pub is_active: bool,
    #[serde(default, alias = "unsaved")]
    pub is_unsaved: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub root_type: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlayStatus {
    #[serde(alias = "isPlaying")]
    pub playing: bool,
    #[serde(default, alias = "scene", skip_serializing_if = "Option::is_none")]
    pub scene_path: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TestStatus {
    pub status: String,
    pub message: String,
}

#[tauri::command]
pub async fn godot_diagnostics(project: String) -> AppResult<GodotDiagnosticsSnapshot> {
    read_snapshot(Path::new(&project)).await
}

async fn read_snapshot(project: &Path) -> AppResult<GodotDiagnosticsSnapshot> {
    let (filesystem, scenes, play) = tokio::try_join!(
        call_typed(project, "filesystem.status", serde_json::json!({})),
        call_typed(project, "scene.getOpenScenes", serde_json::json!({})),
        call_typed(project, "play.status", serde_json::json!({})),
    )?;

    Ok(GodotDiagnosticsSnapshot {
        filesystem,
        scenes,
        play,
        tests: TestStatus {
            status: "not_configured".into(),
            message: "No Godot test runner is configured for this project.".into(),
        },
        captured_at: now_ms(),
    })
}

async fn call_typed<T: for<'de> Deserialize<'de>>(
    project: &Path,
    method: &str,
    params: Value,
) -> AppResult<T> {
    let value = bridge::call(project, method, params).await?;
    serde_json::from_value(value)
        .map_err(|error| AppError::Other(format!("{method} returned invalid data: {error}")))
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn diagnostics_shapes_match_the_addon_contract() {
        let filesystem: FilesystemStatus = serde_json::from_value(serde_json::json!({
            "scanning": false,
            "importing": true,
            "progress": 0.7,
            "indexedFiles": 42
        }))
        .unwrap();
        assert!(filesystem.importing);
        assert_eq!(filesystem.indexed_files, 42);

        let scenes: OpenScenes = serde_json::from_value(serde_json::json!({
            "scenes": [{
                "path": "res://levels/intro.tscn",
                "name": "Intro",
                "rootType": "Node2D",
                "active": true,
                "unsaved": true
            }],
            "count": 1,
            "activeScene": "res://levels/intro.tscn"
        }))
        .unwrap();
        assert!(scenes.scenes[0].is_active);
        assert!(scenes.scenes[0].is_unsaved);

        let play: PlayStatus = serde_json::from_value(serde_json::json!({
            "playing": true,
            "scenePath": "res://levels/intro.tscn"
        }))
        .unwrap();
        assert!(play.playing);
        assert_eq!(play.scene_path.as_deref(), Some("res://levels/intro.tscn"));
    }
}
