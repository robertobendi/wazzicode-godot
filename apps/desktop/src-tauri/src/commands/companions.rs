//! Companion tools the agent can use next to the engine server. Today that is
//! Pyrite, the AI block modeler: the Settings card shows whether it was found
//! (or why not), and can open its editor so the user can watch generations.

use crate::error::{AppError, AppResult};
use crate::mcpconfig::{locate_pyrite, PyriteSource};
use crate::state::AppState;
use serde::Serialize;
use std::path::PathBuf;
use std::process::Stdio;
use std::time::Duration;
use tauri::State;

const DEFAULT_PYRITE_PORT: u16 = 38590;

/// What the Settings card renders. `problem` explains a miss in words the user
/// can act on; `running` says whether the Pyrite daemon answers right now.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PyriteStatus {
    pub enabled: bool,
    pub found: bool,
    pub source: Option<PyriteSource>,
    pub script: Option<String>,
    pub version: Option<String>,
    pub linked_path: Option<String>,
    pub problem: Option<String>,
    pub running: bool,
}

#[tauri::command]
pub async fn pyrite_status(state: State<'_, AppState>) -> AppResult<PyriteStatus> {
    let (enabled, linked) = {
        let s = state.settings.read().await;
        (s.pyrite_enabled, linked_path(s.pyrite_path.as_deref()))
    };
    let located = tokio::task::spawn_blocking({
        let linked = linked.clone();
        move || locate_pyrite(linked.as_deref())
    })
    .await
    .map_err(|e| AppError::Other(e.to_string()))?;
    let running = located.is_ok() && daemon_running().await;
    Ok(match located {
        Ok(install) => PyriteStatus {
            enabled,
            found: true,
            source: Some(install.source),
            script: Some(install.script.to_string_lossy().into_owned()),
            version: install.version,
            linked_path: linked.map(|p| p.to_string_lossy().into_owned()),
            problem: None,
            running,
        },
        Err(problem) => PyriteStatus {
            enabled,
            found: false,
            source: None,
            script: None,
            version: None,
            linked_path: linked.map(|p| p.to_string_lossy().into_owned()),
            problem: Some(problem),
            running: false,
        },
    })
}

/// Open the Pyrite editor (it starts its own daemon on demand). Detached: the
/// editor outlives this call and is the user's to close.
#[tauri::command]
pub async fn pyrite_open(state: State<'_, AppState>) -> AppResult<()> {
    let linked = linked_path(state.settings.read().await.pyrite_path.as_deref());
    let install = locate_pyrite(linked.as_deref()).map_err(AppError::Other)?;
    let mut cmd = std::process::Command::new(&install.server.command);
    // Same launcher as the MCP server, with `open` in place of `mcp`.
    let mut args = install.server.args.clone();
    match args.iter().rposition(|a| a == "mcp") {
        Some(i) => args[i] = "open".into(),
        None => args.push("open".into()),
    }
    cmd.args(&args)
        .env("PATH", crate::proc::search_path())
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    crate::proc::no_window(&mut cmd);
    cmd.spawn()
        .map_err(|e| AppError::Other(format!("Couldn't open Pyrite: {e}")))?;
    Ok(())
}

fn linked_path(raw: Option<&str>) -> Option<PathBuf> {
    raw.map(str::trim).filter(|p| !p.is_empty()).map(PathBuf::from)
}

/// The port Pyrite's daemon listens on: `PYRITE_PORT`, else the one Pyrite
/// recorded in its discovery file, else its default.
fn daemon_port() -> u16 {
    if let Some(port) = std::env::var("PYRITE_PORT").ok().and_then(|p| p.parse().ok()) {
        return port;
    }
    crate::mcpconfig::pyrite_home()
        .and_then(|home| std::fs::read_to_string(home.join("mcp-entry.json")).ok())
        .and_then(|text| serde_json::from_str::<serde_json::Value>(&text).ok())
        .and_then(|v| v.get("port")?.as_u64())
        .and_then(|p| u16::try_from(p).ok())
        .unwrap_or(DEFAULT_PYRITE_PORT)
}

async fn daemon_running() -> bool {
    let Ok(client) = reqwest::Client::builder()
        .timeout(Duration::from_millis(800))
        .no_proxy()
        .build()
    else {
        return false;
    };
    let url = format!("http://127.0.0.1:{}/api/health", daemon_port());
    match client.get(url).send().await {
        Ok(res) if res.status().is_success() => res
            .json::<serde_json::Value>()
            .await
            .is_ok_and(|v| v.get("name").and_then(|n| n.as_str()) == Some("pyrite")),
        _ => false,
    }
}
