//! Godot project selection and validation.

use crate::error::{AppError, AppResult};
use crate::state::AppState;
use crate::store::settings::{save, Settings};
use serde::Serialize;
use std::path::{Component, Path, PathBuf};
use tauri::State;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectInfo {
    pub ok: bool,
    pub name: String,
    pub path: String,
    pub godot_version: Option<String>,
    pub has_project_file: bool,
    pub addon_installed: bool,
    pub vibe_initialized: bool,
    pub brain_ready: bool,
    pub safety_mode: Option<String>,
}

#[tauri::command]
pub async fn validate_godot_project(path: String) -> AppResult<ProjectInfo> {
    Ok(inspect_project(path))
}

pub fn inspect_project(path: String) -> ProjectInfo {
    let root = PathBuf::from(&path);
    let project_file = contained_project_path(&root, Path::new("project.godot")).ok();
    let has_project_file = project_file.as_ref().is_some_and(|file| file.is_file());
    let project_settings = project_file
        .as_ref()
        .filter(|_| has_project_file)
        .and_then(|file| std::fs::read_to_string(file).ok());
    let godot_version = project_settings.as_deref().and_then(read_godot_version);
    let configured_name = project_settings.as_deref().and_then(read_project_name);
    let addon_installed = root
        .join("addons")
        .join("godot_vibe_os")
        .join("plugin.cfg")
        .is_file();
    let config = root.join(".godot-vibe").join("config.json");
    let vibe_initialized = config.is_file();
    let brain_ready = crate::commands::project_map::project_map_is_initialized(&root);
    let safety_mode = vibe_initialized
        .then(|| read_safety_mode(&config))
        .flatten();
    let name = configured_name.unwrap_or_else(|| {
        root.file_name()
            .map(|s| s.to_string_lossy().into_owned())
            .unwrap_or_else(|| path.clone())
    });

    ProjectInfo {
        ok: has_project_file,
        name,
        path,
        godot_version,
        has_project_file,
        addon_installed,
        vibe_initialized,
        brain_ready,
        safety_mode,
    }
}

#[tauri::command]
pub async fn set_current_project(path: String, state: State<'_, AppState>) -> AppResult<Settings> {
    ensure_project_access(Path::new(&path))?;

    let mut settings = state.settings.write().await;
    settings.current_project = Some(path.clone());
    settings.recent_projects.retain(|p| p != &path);
    settings.recent_projects.insert(0, path);
    settings.recent_projects.truncate(8);
    save(&state.config_dir, &settings)?;
    Ok(settings.clone())
}

pub fn ensure_project_access(project: &Path) -> AppResult<bool> {
    let file = contained_project_path(project, Path::new(".godot-vibe/config.json"))?;
    let dir = file
        .parent()
        .ok_or_else(|| AppError::InvalidPath(file.display().to_string()))?;
    if file.is_file() {
        let raw = std::fs::read_to_string(&file)?;
        let config: serde_json::Value = serde_json::from_str(&raw).map_err(|error| {
            crate::error::AppError::Other(format!("Invalid {}: {error}", file.display()))
        })?;
        if !config.is_object() {
            return Err(crate::error::AppError::Other(format!(
                "Invalid {}: expected a JSON object",
                file.display()
            )));
        }
        return Ok(false);
    }

    std::fs::create_dir_all(&dir)?;
    let config = serde_json::json!({
        "safetyMode": "autopilot",
        "allowSceneWrites": true,
        "allowResourceWrites": true,
        "allowScriptWrites": true,
        "allowProjectSettingsWrites": false,
        "allowEditorControl": true,
        "autoSnapshot": true
    });
    let mut bytes = serde_json::to_vec_pretty(&config)?;
    bytes.push(b'\n');
    std::fs::write(file, bytes)?;
    Ok(true)
}

pub(crate) fn contained_project_path(project: &Path, relative: &Path) -> AppResult<PathBuf> {
    if relative.as_os_str().is_empty()
        || relative
            .components()
            .any(|component| !matches!(component, Component::Normal(_) | Component::CurDir))
    {
        return Err(AppError::InvalidPath(relative.display().to_string()));
    }

    let root = crate::pathutil::canonicalize(project)?;
    if !root.is_dir() {
        return Err(AppError::InvalidPath(project.display().to_string()));
    }
    let target = root.join(relative);
    let mut probe = target.as_path();

    loop {
        match std::fs::symlink_metadata(probe) {
            Ok(_) => {
                let resolved = crate::pathutil::canonicalize(probe).map_err(|error| {
                    AppError::Other(format!(
                        "Refusing to access {}: could not resolve it safely: {error}",
                        target.display()
                    ))
                })?;
                if !resolved.starts_with(&root) {
                    return Err(AppError::Other(format!(
                        "Refusing to access {}: path resolves outside project {}",
                        target.display(),
                        root.display()
                    )));
                }
                break;
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                probe = probe.parent().ok_or_else(|| {
                    AppError::InvalidPath(format!(
                        "{} has no existing project ancestor",
                        target.display()
                    ))
                })?;
            }
            Err(error) => return Err(error.into()),
        }
    }

    Ok(target)
}

fn read_godot_version(raw: &str) -> Option<String> {
    let value = setting_value(raw, "config/features")?;
    let start = value.find('"')? + 1;
    let end = value[start..].find('"')? + start;
    let candidate = value[start..end].trim();
    (!candidate.is_empty()).then(|| candidate.to_string())
}

fn read_project_name(raw: &str) -> Option<String> {
    let value = setting_value(raw, "config/name")?.trim();
    let unquoted = value.strip_prefix('"')?.strip_suffix('"')?.trim();
    (!unquoted.is_empty()).then(|| unquoted.replace("\\\"", "\""))
}

fn setting_value<'a>(raw: &'a str, key: &str) -> Option<&'a str> {
    raw.lines().find_map(|line| {
        let line = line.trim();
        let rest = line.strip_prefix(key)?.trim_start();
        rest.strip_prefix('=').map(str::trim)
    })
}

fn read_safety_mode(config: &Path) -> Option<String> {
    let raw = std::fs::read_to_string(config).ok()?;
    let value: serde_json::Value = serde_json::from_str(&raw).ok()?;
    value
        .get("safetyMode")
        .and_then(|mode| mode.as_str())
        .map(str::to_owned)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn project_settings_parse_name_and_engine_feature() {
        let raw = r#"
config_version=5

[application]
config/name="Star Hopper"

[rendering]
config/features=PackedStringArray("4.4", "GL Compatibility")
"#;
        assert_eq!(read_project_name(raw).as_deref(), Some("Star Hopper"));
        assert_eq!(read_godot_version(raw).as_deref(), Some("4.4"));
    }

    #[test]
    fn project_access_preserves_explicit_safety_settings() {
        let root = std::env::temp_dir().join(format!("godot-vibe-access-{}", nanoid::nanoid!(10)));
        let config_dir = root.join(".godot-vibe");
        std::fs::create_dir_all(&config_dir).unwrap();
        std::fs::write(
            config_dir.join("config.json"),
            r#"{"safetyMode":"read_only","allowSceneWrites":false,"bridgePort":49999}"#,
        )
        .unwrap();

        assert!(!ensure_project_access(&root).unwrap());
        let raw = std::fs::read_to_string(config_dir.join("config.json")).unwrap();
        let value: serde_json::Value = serde_json::from_str(&raw).unwrap();
        assert_eq!(value["safetyMode"], "read_only");
        assert_eq!(value["allowSceneWrites"], false);
        assert_eq!(value["bridgePort"], 49999);

        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn project_access_creates_defaults_but_rejects_corrupt_config() {
        let root = std::env::temp_dir().join(format!("godot-vibe-access-{}", nanoid::nanoid!(10)));
        std::fs::create_dir_all(&root).unwrap();
        assert!(ensure_project_access(&root).unwrap());
        assert!(!ensure_project_access(&root).unwrap());
        let file = root.join(".godot-vibe/config.json");
        let value: serde_json::Value =
            serde_json::from_slice(&std::fs::read(&file).unwrap()).unwrap();
        assert_eq!(value["safetyMode"], "autopilot");
        assert_eq!(value["allowProjectSettingsWrites"], false);

        std::fs::write(&file, "{ broken").unwrap();
        let error =
            ensure_project_access(&root).expect_err("corrupt safety config must not fail open");
        assert!(error.to_string().contains("Invalid"));
        assert_eq!(std::fs::read_to_string(&file).unwrap(), "{ broken");
        let _ = std::fs::remove_dir_all(root);
    }

    #[cfg(unix)]
    #[test]
    fn project_access_rejects_config_symlink_outside_project() {
        use std::os::unix::fs::symlink;

        let root = std::env::temp_dir().join(format!("godot-vibe-access-{}", nanoid::nanoid!(10)));
        let project = root.join("project");
        let outside = root.join("outside-config.json");
        std::fs::create_dir_all(project.join(".godot-vibe")).unwrap();
        std::fs::write(&outside, r#"{"safetyMode":"read_only"}"#).unwrap();
        symlink(&outside, project.join(".godot-vibe/config.json")).unwrap();

        let error = ensure_project_access(&project).expect_err("outside symlink must be rejected");
        assert!(error.to_string().contains("outside project"));
        assert_eq!(
            std::fs::read_to_string(&outside).unwrap(),
            r#"{"safetyMode":"read_only"}"#
        );

        let _ = std::fs::remove_dir_all(root);
    }

    #[cfg(unix)]
    #[test]
    fn project_access_rejects_symlinked_state_directory_outside_project() {
        use std::os::unix::fs::symlink;

        let root = std::env::temp_dir().join(format!("godot-vibe-access-{}", nanoid::nanoid!(10)));
        let project = root.join("project");
        let outside = root.join("outside-state");
        std::fs::create_dir_all(&project).unwrap();
        std::fs::create_dir_all(&outside).unwrap();
        symlink(&outside, project.join(".godot-vibe")).unwrap();

        let error = ensure_project_access(&project).expect_err("outside parent must be rejected");
        assert!(error.to_string().contains("outside project"));
        assert!(!outside.join("config.json").exists());

        let _ = std::fs::remove_dir_all(root);
    }

    #[cfg(unix)]
    #[test]
    fn project_inspection_rejects_project_file_symlink_outside_project() {
        use std::os::unix::fs::symlink;

        let root = std::env::temp_dir().join(format!("godot-vibe-inspect-{}", nanoid::nanoid!(10)));
        let project = root.join("project");
        let outside = root.join("outside.godot");
        std::fs::create_dir_all(&project).unwrap();
        std::fs::write(
            &outside,
            "config_version=5\n[application]\nconfig/name=\"Outside Secret\"\n",
        )
        .unwrap();
        symlink(&outside, project.join("project.godot")).unwrap();

        let inspected = inspect_project(project.to_string_lossy().into_owned());

        assert!(!inspected.ok);
        assert!(!inspected.has_project_file);
        assert_ne!(inspected.name, "Outside Secret");
        let _ = std::fs::remove_dir_all(root);
    }
}
