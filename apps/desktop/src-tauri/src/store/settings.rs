use crate::agent::{AgentModelOption, Backend};
use crate::error::AppResult;
use serde::{Deserialize, Serialize};
use std::path::Path;

/// Bump when the on-disk shape changes in a way that needs migration.
/// v2 added backend/model selection; v3 added per-backend reasoning defaults;
/// v4 made strong defaults explicit; v5 tracks which choices should continue
/// following each installed CLI's preferred model and strongest effort; v6
/// moves the managed Claude preference from the Fable alias to the Opus alias;
/// v7 adds the theme choice and keeps pre-theme installs on light.
/// Older files deserialize cleanly because every added field has a default.
const CURRENT_SCHEMA_VERSION: u32 = 7;
const DEFAULT_CLAUDE_MODEL: &str = "opus";
const DEFAULT_CLAUDE_EFFORT: &str = "max";
const DEFAULT_CODEX_MODEL: &str = "gpt-5.6-sol";
const DEFAULT_CODEX_EFFORT: &str = "ultra";

/// Which color scheme the UI paints in. `System` follows the OS; dark is the
/// default, matching the rest of the suite.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ThemeChoice {
    System,
    Light,
    #[default]
    Dark,
}

/// Persistent user settings. Lives at `<config_dir>/settings.json`.
///
/// Every field carries a `serde` default so a settings file written by an
/// older build (missing newer keys) still deserializes cleanly.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    #[serde(default = "default_schema_version")]
    pub schema_version: u32,
    /// Recently opened Unity project paths, most-recent-first.
    #[serde(default)]
    pub recent_projects: Vec<String>,
    /// The Unity project currently in focus, if any.
    #[serde(default)]
    pub current_project: Option<String>,
    /// Which coding agent drives runs. Defaults to Claude, so an existing
    /// settings file (schema v1, no such key) keeps its current behaviour.
    #[serde(default)]
    pub agent_backend: Backend,
    /// Preferred Claude model id, or None to let the CLI decide.
    #[serde(default)]
    pub model: Option<String>,
    /// Preferred Codex model id, or None to let the CLI decide. Kept separate
    /// from `model` so switching backends can't hand `claude-opus-4-8` to Codex
    /// (or `gpt-5-codex` to Claude), which would fail the run outright.
    #[serde(default)]
    pub codex_model: Option<String>,
    /// Preferred Claude reasoning effort, or None to let the CLI decide.
    #[serde(default)]
    pub effort: Option<String>,
    /// Preferred Codex reasoning effort. Kept separate because Codex support is
    /// model-specific and can differ from Claude's accepted values.
    #[serde(default)]
    pub codex_effort: Option<String>,
    /// App-managed defaults follow catalog changes; explicit user choices do not.
    #[serde(default)]
    pub model_follows_catalog: bool,
    #[serde(default)]
    pub effort_follows_model: bool,
    #[serde(default)]
    pub codex_model_follows_catalog: bool,
    #[serde(default)]
    pub codex_effort_follows_model: bool,
    /// Color scheme for the UI. Defaults to following the OS.
    #[serde(default)]
    pub theme: ThemeChoice,
    /// Show the raw stream / debug drawer in the UI.
    #[serde(default)]
    pub debug_drawer: bool,
    /// Set true after the first successful pair/verify. Lets the app skip the
    /// pairing gate on subsequent launches (pairing is per-machine).
    #[serde(default)]
    pub paired_ok: bool,
    /// Set true once the onboarding wizard completes. When false, the wizard
    /// subsumes the pairing gate + project pick on first run. "Redo setup"
    /// flips it back off. Defaults false so existing files re-onboard once.
    #[serde(default)]
    pub onboarded: bool,
}

fn default_schema_version() -> u32 {
    CURRENT_SCHEMA_VERSION
}

impl Settings {
    /// The model override for `backend`, or `None` to let that CLI decide.
    /// Empty strings (a cleared text field in the UI) count as unset.
    pub fn model_for(&self, backend: Backend) -> Option<&str> {
        let raw = match backend {
            Backend::Claude => self.model.as_deref(),
            Backend::Codex => self.codex_model.as_deref(),
        };
        raw.filter(|m| !m.trim().is_empty())
    }

    pub fn effort_for(&self, backend: Backend) -> Option<&str> {
        let raw = match backend {
            Backend::Claude => self.effort.as_deref(),
            Backend::Codex => self.codex_effort.as_deref(),
        };
        raw.map(str::trim).filter(|v| !v.is_empty())
    }
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            schema_version: CURRENT_SCHEMA_VERSION,
            recent_projects: Vec::new(),
            current_project: None,
            agent_backend: Backend::default(),
            model: Some(DEFAULT_CLAUDE_MODEL.into()),
            codex_model: Some(DEFAULT_CODEX_MODEL.into()),
            effort: Some(DEFAULT_CLAUDE_EFFORT.into()),
            codex_effort: Some(DEFAULT_CODEX_EFFORT.into()),
            model_follows_catalog: true,
            effort_follows_model: true,
            codex_model_follows_catalog: true,
            codex_effort_follows_model: true,
            theme: ThemeChoice::Dark,
            debug_drawer: false,
            paired_ok: false,
            onboarded: false,
        }
    }
}

const FILE_NAME: &str = "settings.json";

pub fn load(config_dir: &Path) -> AppResult<Settings> {
    let path = config_dir.join(FILE_NAME);
    if !path.exists() {
        let mut s = Settings::default();
        reconcile_runtime_defaults(&mut s);
        save(config_dir, &s)?;
        return Ok(s);
    }
    let bytes = std::fs::read(&path)?;
    match serde_json::from_slice::<Settings>(&bytes) {
        Ok(mut s) => {
            let changed = migrate_legacy_defaults(&mut s);
            if reconcile_runtime_defaults(&mut s) || changed {
                save(config_dir, &s)?;
            }
            Ok(s)
        }
        Err(_) => {
            // Corrupt file — back it up and reset to defaults so a bad edit
            // never bricks startup.
            let backup = path.with_extension("json.corrupt");
            let _ = std::fs::rename(&path, &backup);
            let mut s = Settings::default();
            reconcile_runtime_defaults(&mut s);
            save(config_dir, &s)?;
            Ok(s)
        }
    }
}

fn migrate_legacy_defaults(settings: &mut Settings) -> bool {
    if settings.schema_version >= CURRENT_SCHEMA_VERSION {
        return false;
    }

    if settings.schema_version < 7 {
        // Foundry was light-only through v6. An existing install keeps the
        // palette it already had; only fresh ones adopt the dark default.
        settings.theme = ThemeChoice::Light;
    }

    if settings.schema_version < 4 {
        settings.model_follows_catalog = is_blank(&settings.model);
        settings.effort_follows_model = is_blank(&settings.effort);
        settings.codex_model_follows_catalog = is_blank(&settings.codex_model);
        settings.codex_effort_follows_model = is_blank(&settings.codex_effort);

        if settings.model_follows_catalog {
            settings.model = Some(DEFAULT_CLAUDE_MODEL.into());
        }
        if settings.codex_model_follows_catalog {
            settings.codex_model = Some(DEFAULT_CODEX_MODEL.into());
        }
        if settings.effort_follows_model {
            settings.effort = settings
                .model_follows_catalog
                .then(|| DEFAULT_CLAUDE_EFFORT.into());
        }
        if settings.codex_effort_follows_model {
            settings.codex_effort = settings
                .codex_model_follows_catalog
                .then(|| DEFAULT_CODEX_EFFORT.into());
        }
    } else if settings.schema_version == 4 {
        // v4 had no provenance markers. Each generated fallback can be
        // recognized independently without reclassifying lower explicit choices.
        settings.model_follows_catalog = trimmed(&settings.model) == Some("fable");
        settings.effort_follows_model = trimmed(&settings.effort) == Some(DEFAULT_CLAUDE_EFFORT);
        settings.codex_model_follows_catalog =
            trimmed(&settings.codex_model) == Some(DEFAULT_CODEX_MODEL);
        settings.codex_effort_follows_model =
            trimmed(&settings.codex_effort) == Some(DEFAULT_CODEX_EFFORT);
    }
    if settings.model_follows_catalog {
        settings.model = Some(DEFAULT_CLAUDE_MODEL.into());
        if settings.effort_follows_model {
            settings.effort = Some(DEFAULT_CLAUDE_EFFORT.into());
        }
    }
    settings.schema_version = CURRENT_SCHEMA_VERSION;
    true
}

fn reconcile_runtime_defaults(settings: &mut Settings) -> bool {
    let mut changed = false;
    if let Ok(catalog) = crate::commands::agent_options::model_catalog_blocking(Backend::Claude) {
        changed |= reconcile_backend(
            &mut settings.model,
            &mut settings.effort,
            settings.model_follows_catalog,
            settings.effort_follows_model,
            &catalog,
        );
    }
    if let Ok(catalog) = crate::commands::agent_options::model_catalog_blocking(Backend::Codex) {
        changed |= reconcile_backend(
            &mut settings.codex_model,
            &mut settings.codex_effort,
            settings.codex_model_follows_catalog,
            settings.codex_effort_follows_model,
            &catalog,
        );
    }
    changed
}

fn reconcile_backend(
    model: &mut Option<String>,
    effort: &mut Option<String>,
    model_follows_catalog: bool,
    effort_follows_model: bool,
    catalog: &[AgentModelOption],
) -> bool {
    if catalog.is_empty() {
        return false;
    }

    let before = (model.clone(), effort.clone());
    if model_follows_catalog {
        *model = Some(catalog[0].id.clone());
    } else {
        *model = trimmed(model).map(str::to_string);
    }

    let listed = trimmed(model).and_then(|id| catalog.iter().find(|entry| entry.id == id));
    let current_effort = trimmed(effort);
    *effort = match listed {
        Some(entry)
            if !effort_follows_model
                && current_effort.is_some_and(|value| entry.efforts.iter().any(|e| e == value)) =>
        {
            current_effort.map(str::to_string)
        }
        Some(entry) => crate::commands::agent_options::strongest_effort(&entry.efforts),
        None if effort_follows_model => None,
        None => current_effort.map(str::to_string),
    };

    before != (model.clone(), effort.clone())
}

fn trimmed(value: &Option<String>) -> Option<&str> {
    value
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
}

fn is_blank(value: &Option<String>) -> bool {
    trimmed(value).is_none()
}

/// Atomic write: serialize to a temp file, then rename over the target so a
/// crash mid-write can never leave a half-written settings file.
pub fn save(config_dir: &Path, settings: &Settings) -> AppResult<()> {
    std::fs::create_dir_all(config_dir)?;
    let path = config_dir.join(FILE_NAME);
    let tmp = config_dir.join(format!("{FILE_NAME}.tmp"));
    let bytes = serde_json::to_vec_pretty(settings)?;
    std::fs::write(&tmp, bytes)?;
    std::fs::rename(&tmp, &path)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_v1_file_keeps_its_explicit_claude_model_during_migration() {
        // Exactly what schema v1 wrote — no `agentBackend`, no `codexModel`.
        let v1 = r#"{
            "schemaVersion": 1,
            "recentProjects": ["/Users/x/Game"],
            "currentProject": "/Users/x/Game",
            "powerMode": true,
            "model": "claude-opus-4-8",
            "debugDrawer": false,
            "pairedOk": true,
            "onboarded": true
        }"#;
        let mut s: Settings = serde_json::from_str(v1).expect("v1 settings must deserialize");
        assert!(migrate_legacy_defaults(&mut s));
        assert_eq!(s.agent_backend, Backend::Claude);
        assert_eq!(s.model.as_deref(), Some("claude-opus-4-8"));
        assert_eq!(s.effort, None);
        assert!(!s.model_follows_catalog);
        assert!(s.effort_follows_model);
        assert_eq!(s.codex_model.as_deref(), Some("gpt-5.6-sol"));
        assert_eq!(s.codex_effort.as_deref(), Some("ultra"));
        assert!(s.codex_model_follows_catalog);
        assert!(s.codex_effort_follows_model);
    }

    #[test]
    fn a_pre_theme_install_stays_light_while_fresh_ones_go_dark() {
        let mut existing = Settings {
            schema_version: 6,
            ..Settings::default()
        };
        assert!(migrate_legacy_defaults(&mut existing));
        assert_eq!(existing.theme, ThemeChoice::Light);
        assert_eq!(Settings::default().theme, ThemeChoice::Dark);
    }

    #[test]
    fn model_for_is_per_backend_and_ignores_blanks() {
        let s = Settings {
            model: Some("claude-opus-4-8".into()),
            codex_model: Some("  ".into()),
            ..Settings::default()
        };
        assert_eq!(s.model_for(Backend::Claude), Some("claude-opus-4-8"));
        // A whitespace-only override must not become `--model "  "`.
        assert_eq!(s.model_for(Backend::Codex), None);
    }

    #[test]
    fn effort_for_is_per_backend_and_ignores_blanks() {
        let s = Settings {
            effort: Some("high".into()),
            codex_effort: Some(" ".into()),
            ..Settings::default()
        };
        assert_eq!(s.effort_for(Backend::Claude), Some("high"));
        assert_eq!(s.effort_for(Backend::Codex), None);
    }

    #[test]
    fn fresh_settings_use_the_preferred_verified_defaults() {
        let s = Settings::default();
        assert_eq!(s.schema_version, 7);
        assert_eq!(s.theme, ThemeChoice::Dark);
        assert_eq!(s.model.as_deref(), Some("opus"));
        assert_eq!(s.effort.as_deref(), Some("max"));
        assert_eq!(s.codex_model.as_deref(), Some("gpt-5.6-sol"));
        assert_eq!(s.codex_effort.as_deref(), Some("ultra"));
        assert!(s.model_follows_catalog);
        assert!(s.effort_follows_model);
        assert!(s.codex_model_follows_catalog);
        assert!(s.codex_effort_follows_model);
    }

    #[test]
    fn v6_migration_fills_all_blank_legacy_choices() {
        let mut s = Settings {
            schema_version: 3,
            model: None,
            effort: Some("  ".into()),
            codex_model: Some("".into()),
            codex_effort: None,
            ..Settings::default()
        };

        assert!(migrate_legacy_defaults(&mut s));
        assert_eq!(s.schema_version, 7);
        assert_eq!(s.model.as_deref(), Some("opus"));
        assert_eq!(s.effort.as_deref(), Some("max"));
        assert_eq!(s.codex_model.as_deref(), Some("gpt-5.6-sol"));
        assert_eq!(s.codex_effort.as_deref(), Some("ultra"));
        assert!(s.model_follows_catalog);
        assert!(s.effort_follows_model);
        assert!(s.codex_model_follows_catalog);
        assert!(s.codex_effort_follows_model);
        assert!(!migrate_legacy_defaults(&mut s));
    }

    #[test]
    fn v6_migration_preserves_explicit_lower_choices() {
        let mut s = Settings {
            schema_version: 3,
            model: Some("opus".into()),
            effort: Some("low".into()),
            codex_model: Some("gpt-5.2".into()),
            codex_effort: Some("low".into()),
            ..Settings::default()
        };

        assert!(migrate_legacy_defaults(&mut s));
        assert_eq!(s.model.as_deref(), Some("opus"));
        assert_eq!(s.effort.as_deref(), Some("low"));
        assert_eq!(s.codex_model.as_deref(), Some("gpt-5.2"));
        assert_eq!(s.codex_effort.as_deref(), Some("low"));
        assert!(!s.model_follows_catalog);
        assert!(!s.effort_follows_model);
        assert!(!s.codex_model_follows_catalog);
        assert!(!s.codex_effort_follows_model);
    }

    #[test]
    fn v6_migration_moves_only_the_managed_fable_default_to_opus() {
        let mut managed = Settings {
            schema_version: 5,
            model: Some("fable".into()),
            effort: Some("max".into()),
            model_follows_catalog: true,
            effort_follows_model: true,
            ..Settings::default()
        };
        assert!(migrate_legacy_defaults(&mut managed));
        assert_eq!(managed.schema_version, 7);
        assert_eq!(managed.model.as_deref(), Some("opus"));
        assert_eq!(managed.effort.as_deref(), Some("max"));

        let mut explicit = Settings {
            schema_version: 5,
            model: Some("fable".into()),
            effort: Some("max".into()),
            model_follows_catalog: false,
            effort_follows_model: false,
            ..Settings::default()
        };
        assert!(migrate_legacy_defaults(&mut explicit));
        assert_eq!(explicit.model.as_deref(), Some("fable"));
    }

    #[test]
    fn v4_generated_fields_keep_independent_catalog_provenance() {
        let mut s = Settings {
            schema_version: 4,
            model: Some("fable".into()),
            effort: Some("low".into()),
            codex_model: Some("gpt-5.2".into()),
            codex_effort: Some("ultra".into()),
            ..Settings::default()
        };

        assert!(migrate_legacy_defaults(&mut s));
        assert_eq!(s.model.as_deref(), Some("opus"));
        assert!(s.model_follows_catalog);
        assert!(!s.effort_follows_model);
        assert!(!s.codex_model_follows_catalog);
        assert!(s.codex_effort_follows_model);
    }

    #[test]
    fn v4_explicit_opus_choice_does_not_become_catalog_managed() {
        let mut s = Settings {
            schema_version: 4,
            model: Some("opus".into()),
            effort: Some("low".into()),
            ..Settings::default()
        };

        assert!(migrate_legacy_defaults(&mut s));
        assert_eq!(s.model.as_deref(), Some("opus"));
        assert_eq!(s.effort.as_deref(), Some("low"));
        assert!(!s.model_follows_catalog);
        assert!(!s.effort_follows_model);
    }

    #[test]
    fn runtime_catalog_replaces_only_managed_models() {
        let catalog = [
            model("gpt-new", &["low", "ultra"]),
            model("gpt-old", &["max"]),
        ];
        let mut selected_model = Some("gpt-hard-coded".into());
        let mut selected_effort = Some("ultra".into());

        assert!(reconcile_backend(
            &mut selected_model,
            &mut selected_effort,
            true,
            true,
            &catalog,
        ));
        assert_eq!(selected_model.as_deref(), Some("gpt-new"));
        assert_eq!(selected_effort.as_deref(), Some("ultra"));

        selected_model = Some("gpt-old".into());
        selected_effort = Some("max".into());
        assert!(!reconcile_backend(
            &mut selected_model,
            &mut selected_effort,
            false,
            false,
            &catalog,
        ));
        assert_eq!(selected_model.as_deref(), Some("gpt-old"));
    }

    #[test]
    fn migration_resolves_blank_effort_against_the_explicit_model() {
        let mut claude = Settings {
            schema_version: 3,
            model: Some("haiku".into()),
            effort: None,
            codex_model: Some("gpt-old".into()),
            codex_effort: None,
            ..Settings::default()
        };
        assert!(migrate_legacy_defaults(&mut claude));
        assert!(!claude.model_follows_catalog);
        assert!(claude.effort_follows_model);
        assert!(!claude.codex_model_follows_catalog);
        assert!(claude.codex_effort_follows_model);

        let claude_catalog = [model("fable", &["low", "max"]), model("haiku", &[])];
        assert!(!reconcile_backend(
            &mut claude.model,
            &mut claude.effort,
            claude.model_follows_catalog,
            claude.effort_follows_model,
            &claude_catalog,
        ));
        assert_eq!(claude.effort, None);

        let codex_catalog = [
            model("gpt-new", &["ultra"]),
            model("gpt-old", &["low", "xhigh"]),
        ];
        assert!(reconcile_backend(
            &mut claude.codex_model,
            &mut claude.codex_effort,
            claude.codex_model_follows_catalog,
            claude.codex_effort_follows_model,
            &codex_catalog,
        ));
        assert_eq!(claude.codex_model.as_deref(), Some("gpt-old"));
        assert_eq!(claude.codex_effort.as_deref(), Some("xhigh"));
    }

    fn model(id: &str, efforts: &[&str]) -> AgentModelOption {
        AgentModelOption {
            id: id.into(),
            label: id.into(),
            description: None,
            default_effort: None,
            efforts: efforts.iter().map(|effort| (*effort).into()).collect(),
        }
    }
}
