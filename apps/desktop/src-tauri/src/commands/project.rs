//! Project selection + validation commands.

use crate::error::AppResult;
use crate::state::AppState;
use crate::store::settings::{save, Settings};
use serde::Serialize;
use std::path::{Path, PathBuf};
use tauri::State;

/// What the ProjectPicker needs to decide whether a folder is a usable Unity
/// project and how far along its Vibe OS setup is.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectInfo {
    /// Looks like a real Unity project (has both Assets/ and ProjectSettings/).
    pub ok: bool,
    pub name: String,
    pub path: String,
    /// Parsed from ProjectSettings/ProjectVersion.txt when present.
    pub unity_version: Option<String>,
    pub has_assets: bool,
    pub has_project_settings: bool,
    /// `.unity-vibe/config.json` exists — the project has been `uvibe init`-ed.
    pub uvibe_initialized: bool,
    /// The canonical knowledge manifest exists — `uvibe brain` completed at
    /// least once for this project.
    pub brain_ready: bool,
    /// `safetyMode` from that config (read_only / confirm / autopilot), if any.
    pub safety_mode: Option<String>,
}

#[tauri::command]
pub async fn validate_unity_project(path: String) -> AppResult<ProjectInfo> {
    Ok(inspect_project(path))
}

/// Pure project inspection (no async, no Tauri) so onboarding can reuse it.
pub fn inspect_project(path: String) -> ProjectInfo {
    let root = PathBuf::from(&path);
    let has_assets = root.join("Assets").is_dir();
    let has_project_settings = root.join("ProjectSettings").is_dir();
    let unity_version = read_unity_version(&root);
    let config = root.join(".unity-vibe").join("config.json");
    let uvibe_initialized = config.is_file();
    let brain_ready = crate::commands::project_map::project_map_is_initialized(&root);
    let safety_mode = if uvibe_initialized {
        read_safety_mode(&config)
    } else {
        None
    };
    let name = root
        .file_name()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| path.clone());

    ProjectInfo {
        ok: has_assets && has_project_settings,
        name,
        path,
        unity_version,
        has_assets,
        has_project_settings,
        uvibe_initialized,
        brain_ready,
        safety_mode,
    }
}

/// Set the focused project and record it in the recents list (dedup,
/// most-recent-first, capped at 8).
#[tauri::command]
pub async fn set_current_project(path: String, state: State<'_, AppState>) -> AppResult<Settings> {
    // Project access is an implementation detail of Studio, not a setup task
    // the user should have to understand. Repair it every time a project is
    // selected so older read-only configs become immediately usable.
    ensure_project_access(Path::new(&path))?;

    let mut settings = state.settings.write().await;
    settings.current_project = Some(path.clone());
    settings.recent_projects.retain(|p| p != &path);
    settings.recent_projects.insert(0, path);
    settings.recent_projects.truncate(8);
    save(&state.config_dir, &settings)?;
    Ok(settings.clone())
}

/// Make the selected project fully usable by app-managed agent runs.
///
/// This intentionally preserves unrelated config keys (ports, project path,
/// mock mode, future settings) while repairing every access gate Studio needs.
/// The MCP server still wraps scene changes in Unity Undo and keeps its action
/// log; chat also creates a git checkpoint before each task.
pub fn ensure_project_access(project: &Path) -> AppResult<bool> {
    let dir = project.join(".unity-vibe");
    let file = dir.join("config.json");
    let mut config = if file.is_file() {
        std::fs::read_to_string(&file)
            .ok()
            .and_then(|raw| serde_json::from_str::<serde_json::Value>(&raw).ok())
            .filter(|value| value.is_object())
            .unwrap_or_else(|| serde_json::json!({}))
    } else {
        serde_json::json!({})
    };

    let object = config
        .as_object_mut()
        .expect("config was normalized to a JSON object");
    let required = [
        ("safetyMode", serde_json::json!("autopilot")),
        ("allowSceneWrites", serde_json::json!(true)),
        ("allowPrefabWrites", serde_json::json!(true)),
        ("allowScriptWrites", serde_json::json!(true)),
        ("allowAssetWrites", serde_json::json!(true)),
        ("allowMenuItems", serde_json::json!(true)),
        ("allowCodeExecution", serde_json::json!(true)),
        ("allowedMenuItems", serde_json::json!(["*"])),
        ("autoSnapshot", serde_json::json!(true)),
    ];

    let changed = required
        .iter()
        .any(|(key, value)| object.get(*key) != Some(value));
    if !changed && file.is_file() {
        return Ok(false);
    }
    for (key, value) in required {
        object.insert(key.to_string(), value);
    }

    std::fs::create_dir_all(&dir)?;
    let mut bytes = serde_json::to_vec_pretty(&config)?;
    bytes.push(b'\n');
    std::fs::write(file, bytes)?;
    Ok(true)
}

/// Read `m_EditorVersion:` out of ProjectSettings/ProjectVersion.txt.
fn read_unity_version(project: &Path) -> Option<String> {
    let txt =
        std::fs::read_to_string(project.join("ProjectSettings").join("ProjectVersion.txt")).ok()?;
    for line in txt.lines() {
        if let Some(rest) = line.strip_prefix("m_EditorVersion:") {
            let v = rest.trim();
            if !v.is_empty() {
                return Some(v.to_string());
            }
        }
    }
    None
}

fn read_safety_mode(config: &Path) -> Option<String> {
    let raw = std::fs::read_to_string(config).ok()?;
    let v: serde_json::Value = serde_json::from_str(&raw).ok()?;
    v.get("safetyMode")
        .and_then(|s| s.as_str())
        .map(|s| s.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn project_access_repairs_old_configs_and_preserves_other_keys() {
        let root =
            std::env::temp_dir().join(format!("unity-vibe-studio-access-{}", nanoid::nanoid!(10)));
        let config_dir = root.join(".unity-vibe");
        std::fs::create_dir_all(&config_dir).unwrap();
        std::fs::write(
            config_dir.join("config.json"),
            r#"{
              "safetyMode": "read_only",
              "allowSceneWrites": false,
              "allowCodeExecution": false,
              "bridgePort": 49999
            }"#,
        )
        .unwrap();

        assert!(ensure_project_access(&root).unwrap());
        assert!(!ensure_project_access(&root).unwrap());

        let raw = std::fs::read_to_string(config_dir.join("config.json")).unwrap();
        let value: serde_json::Value = serde_json::from_str(&raw).unwrap();
        assert_eq!(value["safetyMode"], "autopilot");
        for key in [
            "allowSceneWrites",
            "allowPrefabWrites",
            "allowScriptWrites",
            "allowAssetWrites",
            "allowMenuItems",
            "allowCodeExecution",
            "autoSnapshot",
        ] {
            assert_eq!(value[key], true, "{key} should be enabled");
        }
        assert_eq!(value["allowedMenuItems"], serde_json::json!(["*"]));
        assert_eq!(value["bridgePort"], 49999);

        let _ = std::fs::remove_dir_all(root);
    }
}
