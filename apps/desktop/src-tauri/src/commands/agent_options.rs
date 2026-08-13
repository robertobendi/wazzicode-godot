use crate::agent::{AgentModelOption, Backend};
use crate::error::{AppError, AppResult};
use serde::Deserialize;
use std::time::Duration;

#[tauri::command]
pub async fn agent_model_catalog(backend: Backend) -> AppResult<Vec<AgentModelOption>> {
    tokio::task::spawn_blocking(move || model_catalog_blocking(backend))
        .await
        .map_err(|e| AppError::Other(format!("model catalog task failed: {e}")))?
}

pub(crate) fn model_catalog_blocking(backend: Backend) -> AppResult<Vec<AgentModelOption>> {
    match backend {
        Backend::Claude => claude_catalog(),
        Backend::Codex => codex_catalog(),
    }
}

fn claude_catalog() -> AppResult<Vec<AgentModelOption>> {
    let mut cmd = crate::proc::command("claude")?;
    cmd.arg("--help");
    let out = crate::proc::output_with_timeout(cmd, Duration::from_secs(10))?;
    if !out.status.success() {
        return Err(AppError::Other(
            "Claude rejected the model capability probe.".into(),
        ));
    }
    let help = format!(
        "{}\n{}",
        String::from_utf8_lossy(&out.stdout),
        String::from_utf8_lossy(&out.stderr)
    );
    Ok(claude_catalog_from_help(&help))
}

fn claude_catalog_from_help(help: &str) -> Vec<AgentModelOption> {
    // Claude has no machine-readable catalog. Opus is intentionally first as
    // Studio's preferred default; aliases stay version-neutral because the CLI
    // can retarget them without exposing the resolved model in `--help`.
    let mut models = vec![AgentModelOption::claude(
        "opus",
        "Opus (latest)",
        crate::agent::options::claude_efforts_for(Some("opus")),
    )];
    if help.contains("'fable'") || help.contains("claude-fable-") {
        models.push(AgentModelOption::claude(
            "fable",
            "Fable (latest)",
            crate::agent::options::claude_efforts_for(Some("fable")),
        ));
    }
    models.extend([
        AgentModelOption::claude(
            "sonnet",
            "Sonnet",
            crate::agent::options::claude_efforts_for(Some("sonnet")),
        ),
        AgentModelOption::claude(
            "haiku",
            "Haiku",
            crate::agent::options::claude_efforts_for(Some("haiku")),
        ),
    ]);
    models
}

fn codex_catalog() -> AppResult<Vec<AgentModelOption>> {
    run_codex_catalog().map_err(|error| {
        AppError::Other(format!(
            "Couldn't read the Codex model catalog. Update the Codex CLI and try again: {error}"
        ))
    })
}

fn run_codex_catalog() -> AppResult<Vec<AgentModelOption>> {
    let mut cmd = crate::proc::command("codex")?;
    // `debug models` lacks `--ignore-user-config`. It needs no credentials when
    // reading the CLI's bundled catalog, so give it an empty app-owned home to
    // prevent user provider/routing config from being loaded at all.
    let catalog_home = crate::store::config_dir()?.join("codex-catalog-home");
    std::fs::create_dir_all(&catalog_home)?;
    cmd.args(["debug", "models", "--bundled"]);
    crate::codexauth::isolate_child_environment(&mut cmd);
    cmd.env("CODEX_HOME", catalog_home);
    let out = crate::proc::output_with_timeout(cmd, Duration::from_secs(20))?;
    if !out.status.success() {
        let detail = String::from_utf8_lossy(&out.stderr);
        let detail = detail.lines().rev().find(|l| !l.trim().is_empty());
        return Err(AppError::Other(
            detail
                .unwrap_or("Codex rejected the model catalog command.")
                .trim()
                .into(),
        ));
    }
    parse_codex_catalog(&out.stdout)
}

#[derive(Deserialize)]
struct RawCatalog {
    models: Vec<RawModel>,
}

#[derive(Deserialize)]
struct RawModel {
    slug: String,
    display_name: Option<String>,
    description: Option<String>,
    default_reasoning_level: Option<String>,
    #[serde(default)]
    supported_reasoning_levels: Vec<RawEffort>,
    visibility: Option<String>,
    priority: Option<u32>,
}

#[derive(Deserialize)]
struct RawEffort {
    effort: String,
}

fn parse_codex_catalog(bytes: &[u8]) -> AppResult<Vec<AgentModelOption>> {
    let mut raw: RawCatalog = serde_json::from_slice(bytes)
        .map_err(|e| AppError::Other(format!("Codex returned an unreadable model catalog: {e}")))?;
    raw.models
        .sort_by_key(|model| model.priority.unwrap_or(u32::MAX));
    Ok(raw
        .models
        .into_iter()
        .filter(|m| m.visibility.as_deref() == Some("list"))
        .map(|m| AgentModelOption {
            label: m.display_name.unwrap_or_else(|| m.slug.clone()),
            id: m.slug,
            description: m.description,
            default_effort: m.default_reasoning_level,
            efforts: m
                .supported_reasoning_levels
                .into_iter()
                .map(|level| level.effort)
                .collect(),
        })
        .collect())
}

pub(crate) fn strongest_effort(efforts: &[String]) -> Option<String> {
    ["ultra", "max", "xhigh", "high", "medium", "low"]
        .into_iter()
        .find(|candidate| efforts.iter().any(|effort| effort == candidate))
        .map(str::to_string)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_visible_models_and_their_exact_efforts() {
        let fixture = br#"{
            "models": [
                {
                    "slug": "gpt-visible",
                    "display_name": "GPT Visible",
                    "description": "Useful",
                    "priority": 2,
                    "default_reasoning_level": "medium",
                    "supported_reasoning_levels": [
                        {"effort": "low"}, {"effort": "medium"}, {"effort": "max"}
                    ],
                    "visibility": "list"
                },
                {
                    "slug": "internal-review",
                    "priority": 1,
                    "supported_reasoning_levels": [{"effort": "high"}],
                    "visibility": "hide"
                }
            ]
        }"#;
        let models = parse_codex_catalog(fixture).unwrap();
        assert_eq!(models.len(), 1);
        assert_eq!(models[0].id, "gpt-visible");
        assert_eq!(models[0].label, "GPT Visible");
        assert_eq!(models[0].default_effort.as_deref(), Some("medium"));
        assert_eq!(models[0].efforts, ["low", "medium", "max"]);
    }

    #[test]
    fn codex_catalog_orders_visible_models_by_verified_priority() {
        let fixture = br#"{
            "models": [
                {
                    "slug": "gpt-terra",
                    "priority": 2,
                    "supported_reasoning_levels": [{"effort": "max"}],
                    "visibility": "list"
                },
                {
                    "slug": "gpt-sol",
                    "priority": 1,
                    "supported_reasoning_levels": [{"effort": "ultra"}],
                    "visibility": "list"
                }
            ]
        }"#;
        let models = parse_codex_catalog(fixture).unwrap();
        assert_eq!(
            models
                .iter()
                .map(|model| model.id.as_str())
                .collect::<Vec<_>>(),
            ["gpt-sol", "gpt-terra"]
        );
    }

    #[test]
    fn claude_catalog_exposes_only_verified_efforts() {
        let models = claude_catalog_from_help(
            "--model <model> aliases include 'fable', 'opus', or 'sonnet'; full name claude-fable-5",
        );
        let efforts = |id: &str| {
            models
                .iter()
                .find(|model| model.id == id)
                .unwrap()
                .efforts
                .as_slice()
        };
        assert_eq!(efforts("opus"), ["low", "medium", "high", "xhigh", "max"]);
        assert_eq!(efforts("sonnet"), ["low", "medium", "high", "xhigh", "max"]);
        assert_eq!(efforts("fable"), ["low", "medium", "high", "xhigh", "max"]);
        assert!(efforts("haiku").is_empty());
        assert_eq!(
            models
                .iter()
                .map(|model| (model.id.as_str(), model.label.as_str()))
                .collect::<Vec<_>>(),
            [
                ("opus", "Opus (latest)"),
                ("fable", "Fable (latest)"),
                ("sonnet", "Sonnet"),
                ("haiku", "Haiku"),
            ]
        );
    }

    #[test]
    fn claude_catalog_uses_opus_when_the_installed_cli_predates_fable() {
        let models = claude_catalog_from_help("--model <model> aliases include 'opus' or 'sonnet'");
        assert_eq!(models[0].id, "opus");
        assert!(!models.iter().any(|model| model.id == "fable"));
    }

    #[test]
    fn strongest_effort_uses_capability_not_catalog_order() {
        let efforts = ["max", "low", "ultra", "xhigh"].map(str::to_string);
        assert_eq!(strongest_effort(&efforts).as_deref(), Some("ultra"));
        assert_eq!(strongest_effort(&[]), None);
    }
}
