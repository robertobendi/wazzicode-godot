//! Quick actions — one-tap starter prompts shown above the composer.
//!
//! The app ships three built-in actions (mirrored in `src/lib/quickActions.ts`
//! for instant, offline rendering). A studio can override them per-project by
//! dropping a `<project>/.unity-vibe/quick_actions.json` file — an array of
//! `{label, prompt}` — which REPLACES the defaults. Parsing is tolerant: a
//! missing file returns the defaults, and a malformed / partially-invalid file
//! logs a warning and also falls back to the defaults.

use crate::error::AppError;
use serde::{Deserialize, Serialize};
use std::path::Path;

/// A single starter prompt. camelCase over IPC; mirrored by the TS
/// `QuickAction` type.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct QuickAction {
    pub label: String,
    pub prompt: String,
}

/// The built-in defaults. Kept in sync with `src/lib/quickActions.ts`.
fn default_quick_actions() -> Vec<QuickAction> {
    vec![
        QuickAction {
            label: "Fix whatever's broken".into(),
            prompt: "Run unity_qa, fix every actionable failure it finds, then rerun the full gate until it passes.".into(),
        },
        QuickAction {
            label: "Screenshot tour".into(),
            prompt: "Open each scene in the project, capture a game-view screenshot of each, and summarize what's in them.".into(),
        },
        QuickAction {
            label: "Tidy the scene".into(),
            prompt: "Look at the current scene hierarchy and tidy it: group loose objects under sensible parents, fix obvious naming, and report what you changed.".into(),
        },
    ]
}

/// Return the effective quick actions for `project`: a valid per-project
/// override file if present, otherwise the built-in defaults.
#[tauri::command]
pub async fn read_quick_actions(project: String) -> Result<Vec<QuickAction>, AppError> {
    tokio::task::spawn_blocking(move || read_quick_actions_blocking(&project))
        .await
        .map_err(|e| AppError::Other(format!("quick actions task failed: {e}")))
}

fn read_quick_actions_blocking(project: &str) -> Vec<QuickAction> {
    let path = Path::new(project)
        .join(".unity-vibe")
        .join("quick_actions.json");
    let Ok(raw) = std::fs::read_to_string(&path) else {
        // No override file — the common case.
        return default_quick_actions();
    };
    match parse_override(&raw) {
        Some(actions) => actions,
        None => {
            log::warn!(
                "ignoring malformed quick_actions.json at {} — using defaults",
                path.display()
            );
            default_quick_actions()
        }
    }
}

/// Parse an override file's contents. `Some(actions)` only for a non-empty array
/// of well-formed `{label, prompt}` objects (blank labels/prompts are dropped);
/// `None` for anything else (bad JSON, wrong shape, or all-empty).
fn parse_override(raw: &str) -> Option<Vec<QuickAction>> {
    let parsed: Vec<QuickAction> = serde_json::from_str(raw).ok()?;
    let cleaned: Vec<QuickAction> = parsed
        .into_iter()
        .filter(|a| !a.label.trim().is_empty() && !a.prompt.trim().is_empty())
        .collect();
    if cleaned.is_empty() {
        None
    } else {
        Some(cleaned)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_are_present() {
        let d = default_quick_actions();
        assert_eq!(d.len(), 3);
        assert!(d
            .iter()
            .all(|a| !a.label.is_empty() && !a.prompt.is_empty()));
    }

    #[test]
    fn parse_override_accepts_valid_array() {
        let raw = r#"[{"label":"Do X","prompt":"Please do X"}]"#;
        let parsed = parse_override(raw).unwrap();
        assert_eq!(parsed.len(), 1);
        assert_eq!(parsed[0].label, "Do X");
    }

    #[test]
    fn parse_override_rejects_garbage_and_empty() {
        assert!(parse_override("not json").is_none());
        assert!(parse_override("{}").is_none()); // object, not array
        assert!(parse_override("[]").is_none()); // empty array
                                                 // All entries blank → treated as empty → None.
        assert!(parse_override(r#"[{"label":"  ","prompt":""}]"#).is_none());
    }

    #[test]
    fn read_falls_back_to_defaults_without_file() {
        let project = std::env::temp_dir().join(format!("uvibe-qa-{}", nanoid::nanoid!(8)));
        std::fs::create_dir_all(&project).unwrap();
        let actions = read_quick_actions_blocking(project.to_str().unwrap());
        assert_eq!(actions.len(), 3);
        std::fs::remove_dir_all(&project).ok();
    }

    #[test]
    fn read_uses_override_when_present() {
        let project = std::env::temp_dir().join(format!("uvibe-qa-{}", nanoid::nanoid!(8)));
        let dir = project.join(".unity-vibe");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            dir.join("quick_actions.json"),
            r#"[{"label":"Only one","prompt":"Just this"}]"#,
        )
        .unwrap();
        let actions = read_quick_actions_blocking(project.to_str().unwrap());
        assert_eq!(actions.len(), 1);
        assert_eq!(actions[0].label, "Only one");
        std::fs::remove_dir_all(&project).ok();
    }
}
