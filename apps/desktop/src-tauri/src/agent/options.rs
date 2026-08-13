use crate::agent::Backend;
use crate::error::{AppError, AppResult};
use serde::{Deserialize, Serialize};

const CLAUDE_EFFORTS: &[&str] = &["low", "medium", "high", "xhigh", "max"];
const NO_EFFORTS: &[&str] = &[];

/// Backend + model controls captured when a task starts. Keeping this on the
/// run prevents later Settings changes from altering an in-flight task.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentRunOptions {
    #[serde(default)]
    pub backend: Backend,
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default)]
    pub effort: Option<String>,
}

impl AgentRunOptions {
    pub fn model(&self) -> Option<&str> {
        self.model
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
    }

    pub fn effort(&self) -> Option<&str> {
        self.effort
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
    }

    pub fn validate(&self) -> AppResult<()> {
        if let Some(model) = self.model() {
            if model.len() > 128 || model.chars().any(char::is_control) {
                return Err(AppError::Other("That model name is not valid.".into()));
            }
        }

        if let Some(effort) = self.effort() {
            let valid = match self.backend {
                Backend::Claude => claude_efforts_for(self.model()).contains(&effort),
                Backend::Codex => {
                    effort.len() <= 32
                        && effort
                            .chars()
                            .all(|c| c.is_ascii_lowercase() || c == '_' || c == '-')
                }
            };
            if !valid {
                return Err(AppError::Other(format!(
                    "{effort:?} is not a supported {} reasoning effort.",
                    self.backend.label()
                )));
            }
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentModelOption {
    pub id: String,
    pub label: String,
    pub description: Option<String>,
    pub default_effort: Option<String>,
    pub efforts: Vec<String>,
}

impl AgentModelOption {
    pub fn claude(id: &str, label: &str, efforts: &[&str]) -> Self {
        Self {
            id: id.into(),
            label: label.into(),
            description: None,
            default_effort: None,
            efforts: efforts.iter().map(|v| (*v).into()).collect(),
        }
    }
}

pub(crate) fn claude_efforts_for(model: Option<&str>) -> &'static [&'static str] {
    match model {
        Some("haiku") => NO_EFFORTS,
        Some("fable" | "opus" | "sonnet") | None => CLAUDE_EFFORTS,
        // A custom full model id can carry capabilities the alias catalog
        // cannot infer; let the installed CLI validate it.
        Some(_) => CLAUDE_EFFORTS,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn trims_empty_overrides_to_automatic() {
        let options = AgentRunOptions {
            backend: Backend::Codex,
            model: Some("  ".into()),
            effort: Some("".into()),
        };
        assert_eq!(options.model(), None);
        assert_eq!(options.effort(), None);
        assert!(options.validate().is_ok());
    }

    #[test]
    fn claude_accepts_only_efforts_supported_by_the_selected_model() {
        for model in ["fable", "opus", "sonnet"] {
            for effort in CLAUDE_EFFORTS {
                let options = AgentRunOptions {
                    backend: Backend::Claude,
                    model: Some(model.into()),
                    effort: Some((*effort).into()),
                };
                assert!(options.validate().is_ok(), "{model} {effort}");
            }
        }
        for (model, effort) in [("haiku", "low"), ("opus", "ultra")] {
            let invalid = AgentRunOptions {
                backend: Backend::Claude,
                model: Some(model.into()),
                effort: Some(effort.into()),
            };
            assert!(invalid.validate().is_err(), "{model} {effort}");
        }
    }

    #[test]
    fn codex_effort_is_future_compatible_but_toml_safe() {
        let valid = AgentRunOptions {
            backend: Backend::Codex,
            effort: Some("future_level".into()),
            ..AgentRunOptions::default()
        };
        assert!(valid.validate().is_ok());

        for effort in ["High", "high'", "high value"] {
            let invalid = AgentRunOptions {
                backend: Backend::Codex,
                effort: Some(effort.into()),
                ..AgentRunOptions::default()
            };
            assert!(invalid.validate().is_err(), "{effort}");
        }
    }
}
