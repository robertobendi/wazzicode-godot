//! Unity diagnostics for the human-facing Activity panel.

use crate::bridge;
use crate::error::{AppError, AppResult};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UnityDiagnosticsSnapshot {
    pub compile: CompileStatus,
    pub console: ConsoleResult,
    pub play_mode: PlayModeStatus,
    pub captured_at: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CompileStatus {
    pub is_compiling: bool,
    pub has_errors: bool,
    pub error_count: u64,
    pub warning_count: u64,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub errors: Vec<CompileProblem>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CompileProblem {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub file: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub line: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub column: Option<u64>,
    pub message: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub r#type: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConsoleResult {
    #[serde(default)]
    pub logs: Vec<ConsoleEntry>,
    #[serde(default)]
    pub truncated: bool,
    #[serde(default)]
    pub buffer_size: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConsoleEntry {
    pub r#type: String,
    pub message: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stack_trace: Option<String>,
    pub timestamp: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlayModeStatus {
    pub is_playing: bool,
    pub is_paused: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub time_scale: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub frame_count: Option<u64>,
}

#[tauri::command]
pub async fn unity_diagnostics(project: String) -> AppResult<UnityDiagnosticsSnapshot> {
    read_snapshot(Path::new(&project)).await
}

#[tauri::command]
pub async fn unity_clear_console(project: String) -> AppResult<()> {
    let project = Path::new(&project);
    bridge::call(project, "system.health", serde_json::json!({})).await?;
    bridge::call(project, "console.clear", serde_json::json!({})).await?;
    Ok(())
}

async fn read_snapshot(project: &Path) -> AppResult<UnityDiagnosticsSnapshot> {
    let (compile, console, play_mode) = tokio::try_join!(
        call_typed(project, "compile.status", serde_json::json!({})),
        call_typed(
            project,
            "console.getLogs",
            serde_json::json!({ "level": "all", "limit": 500 })
        ),
        call_typed(project, "playmode.status", serde_json::json!({})),
    )?;

    Ok(UnityDiagnosticsSnapshot {
        compile,
        console,
        play_mode,
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
    fn diagnostics_shape_deserializes_bridge_payloads() {
        let compile: CompileStatus = serde_json::from_value(serde_json::json!({
            "isCompiling": false,
            "hasErrors": true,
            "errorCount": 1,
            "warningCount": 2,
            "errors": [{ "file": "Assets/Player.cs", "line": 7, "column": 4, "message": "CS1002", "type": "error" }]
        }))
        .unwrap();
        assert!(compile.has_errors);
        assert_eq!(compile.errors[0].line, Some(7));

        let console: ConsoleResult = serde_json::from_value(serde_json::json!({
            "logs": [{ "type": "Exception", "message": "boom", "stackTrace": "at Player.Start()", "timestamp": 10 }],
            "truncated": false,
            "bufferSize": 1
        }))
        .unwrap();
        assert_eq!(
            console.logs[0].stack_trace.as_deref(),
            Some("at Player.Start()")
        );
    }
}
