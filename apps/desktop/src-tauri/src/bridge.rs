//! Godot editor-addon bridge status and RPC client.

use crate::error::{AppError, AppResult};
use crate::state::AppState;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::time::Duration;
use tauri::{AppHandle, Emitter};

const DISCOVERY_REL: &str = ".godot/godot-vibe-os/bridge.json";
const DEFAULT_HOST: &str = "127.0.0.1";
const PROTOCOL_VERSION: &str = "1.1";
const REQUEST_TIMEOUT: Duration = Duration::from_millis(1500);
const CALL_TIMEOUT: Duration = Duration::from_secs(15);
const POLL_INTERVAL: Duration = Duration::from_secs(2);
const CONNECT_GRACE_TICKS: u32 = 4;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum BridgeState {
    Disconnected,
    Reloading,
    IdentityMismatch,
    Connected,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StatusUpdate {
    pub state: BridgeState,
    pub importing: bool,
    pub play_mode: bool,
    pub friendly: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Discovery {
    port: u16,
    #[serde(default)]
    host: Option<String>,
    token: String,
    project_path: String,
    protocol_version: String,
}

pub struct StatusTask {
    pub project: PathBuf,
    pub handle: tokio::task::JoinHandle<()>,
}

pub async fn start_status_loop(app: AppHandle, state: &AppState, project: PathBuf) {
    let mut guard = state.status_task.lock().await;
    if let Some(existing) = guard.as_ref() {
        if existing.project == project {
            return;
        }
        existing.handle.abort();
    }
    let app_loop = app.clone();
    let project_loop = project.clone();
    let handle = tokio::spawn(async move { run_loop(app_loop, project_loop).await });
    *guard = Some(StatusTask { project, handle });
}

pub async fn stop_status_loop(state: &AppState) {
    if let Some(task) = state.status_task.lock().await.take() {
        task.handle.abort();
    }
}

async fn run_loop(app: AppHandle, project: PathBuf) {
    let client = reqwest::Client::builder()
        .timeout(REQUEST_TIMEOUT)
        .build()
        .unwrap_or_default();
    let mut miss_streak = 0_u32;
    loop {
        let mut update = poll_once(&project, &client).await;
        if update.state == BridgeState::Disconnected {
            miss_streak = miss_streak.saturating_add(1);
            if miss_streak <= CONNECT_GRACE_TICKS {
                update.friendly = "Connecting to Godot…".into();
            }
        } else {
            miss_streak = 0;
        }
        let _ = app.emit("status:update", update);
        tokio::time::sleep(POLL_INTERVAL).await;
    }
}

pub async fn poll_once(project: &Path, client: &reqwest::Client) -> StatusUpdate {
    let name = project_name(project);
    let Some(discovery) = read_discovery(project) else {
        return status(
            BridgeState::Disconnected,
            false,
            false,
            format!("Open {name} in Godot"),
        );
    };
    let url = rpc_url(&discovery);
    match rpc(
        client,
        &url,
        &discovery.token,
        "system.health",
        serde_json::json!({}),
    )
    .await
    {
        RpcOutcome::Ok(response) => {
            if let Some(actual) = response_project(&response) {
                if !same_path(actual, project) {
                    return status(
                        BridgeState::IdentityMismatch,
                        false,
                        false,
                        "A different Godot project is open".into(),
                    );
                }
            }
            let filesystem = rpc(
                client,
                &url,
                &discovery.token,
                "filesystem.status",
                serde_json::json!({}),
            )
            .await;
            let playing = rpc_result_bool(
                rpc(
                    client,
                    &url,
                    &discovery.token,
                    "play.status",
                    serde_json::json!({}),
                )
                .await,
                "playing",
            );
            let importing = match filesystem {
                RpcOutcome::Ok(value) => {
                    rpc_result_field_bool(&value, "scanning")
                        || rpc_result_field_bool(&value, "importing")
                }
                _ => false,
            };
            status(
                BridgeState::Connected,
                importing,
                playing,
                if importing {
                    "Godot is importing resources…".into()
                } else if playing {
                    "Godot connected · project running".into()
                } else {
                    "Godot connected".into()
                },
            )
        }
        RpcOutcome::Unavailable | RpcOutcome::ErrResponse { .. } => status(
            BridgeState::Reloading,
            false,
            false,
            "Godot bridge is restarting…".into(),
        ),
    }
}

pub async fn call(
    project: &Path,
    method: &str,
    params: serde_json::Value,
) -> AppResult<serde_json::Value> {
    let discovery =
        read_discovery(project).ok_or_else(|| AppError::Other("GODOT_NOT_CONNECTED".into()))?;
    let client = reqwest::Client::builder()
        .timeout(CALL_TIMEOUT)
        .build()
        .map_err(|error| AppError::Other(format!("http client: {error}")))?;
    let response = match rpc(
        &client,
        &rpc_url(&discovery),
        &discovery.token,
        method,
        params,
    )
    .await
    {
        RpcOutcome::Ok(value) => value,
        RpcOutcome::Unavailable => return Err(AppError::Other("GODOT_RELOADING".into())),
        RpcOutcome::ErrResponse { code, message } => {
            return Err(AppError::Other(format!("{code}: {message}")))
        }
    };

    ensure_response_project(&response, project)?;
    Ok(response
        .get("result")
        .cloned()
        .unwrap_or(serde_json::Value::Null))
}

fn status(state: BridgeState, importing: bool, play_mode: bool, friendly: String) -> StatusUpdate {
    StatusUpdate {
        state,
        importing,
        play_mode,
        friendly,
    }
}

enum RpcOutcome {
    Ok(serde_json::Value),
    ErrResponse { code: String, message: String },
    Unavailable,
}

async fn rpc(
    client: &reqwest::Client,
    url: &str,
    token: &str,
    method: &str,
    params: serde_json::Value,
) -> RpcOutcome {
    let body = serde_json::json!({
        "id": "foundry-godot",
        "version": PROTOCOL_VERSION,
        "method": method,
        "params": params,
    });
    let response = match client
        .post(url)
        .header("X-Godot-Vibe-Token", token)
        .json(&body)
        .send()
        .await
    {
        Ok(response) => response,
        Err(_) => return RpcOutcome::Unavailable,
    };
    let status = response.status();
    match response.json::<serde_json::Value>().await {
        Ok(value)
            if status.is_success() && value.get("ok").and_then(|v| v.as_bool()) == Some(true) =>
        {
            RpcOutcome::Ok(value)
        }
        Ok(value) => {
            let (code, message) = response_error(&value, status);
            log::debug!("Godot bridge RPC failed: {code} {message}");
            RpcOutcome::ErrResponse { code, message }
        }
        Err(_) => RpcOutcome::ErrResponse {
            code: format!("BRIDGE_HTTP_{}", status.as_u16()),
            message: "Godot bridge returned invalid JSON".into(),
        },
    }
}

fn response_error(value: &serde_json::Value, status: reqwest::StatusCode) -> (String, String) {
    let code = value
        .pointer("/error/code")
        .and_then(|value| value.as_str())
        .or_else(|| value.get("error").and_then(|value| value.as_str()))
        .map(str::to_owned)
        .unwrap_or_else(|| format!("BRIDGE_HTTP_{}", status.as_u16()));
    let message = value
        .pointer("/error/message")
        .and_then(|value| value.as_str())
        .map(str::to_owned)
        .unwrap_or_else(|| {
            status
                .canonical_reason()
                .unwrap_or("Bridge request failed")
                .into()
        });
    (code, message)
}

fn rpc_result_bool(outcome: RpcOutcome, key: &str) -> bool {
    match outcome {
        RpcOutcome::Ok(value) => rpc_result_field_bool(&value, key),
        _ => false,
    }
}

fn rpc_result_field_bool(response: &serde_json::Value, key: &str) -> bool {
    response
        .get("result")
        .and_then(|result| result.get(key))
        .and_then(|value| value.as_bool())
        .unwrap_or(false)
}

fn response_project(response: &serde_json::Value) -> Option<&str> {
    response
        .pointer("/meta/projectPath")
        .or_else(|| response.pointer("/result/projectPath"))
        .and_then(|value| value.as_str())
}

fn ensure_response_project(response: &serde_json::Value, project: &Path) -> AppResult<()> {
    let Some(actual) = response_project(response) else {
        return Ok(());
    };
    if same_path(actual, project) {
        return Ok(());
    }
    Err(AppError::Other(format!(
        "PROJECT_IDENTITY_MISMATCH: Connected Godot project is '{actual}' but expected '{}'.",
        project.display()
    )))
}

fn read_discovery(project: &Path) -> Option<Discovery> {
    let raw = std::fs::read_to_string(project.join(DISCOVERY_REL)).ok()?;
    let discovery: Discovery = serde_json::from_str(&raw).ok()?;
    let host = discovery.host.as_deref().unwrap_or(DEFAULT_HOST);
    (discovery.port > 0
        && matches!(host, "127.0.0.1" | "::1")
        && discovery.token.len() >= 32
        && discovery.protocol_version == PROTOCOL_VERSION
        && same_path(&discovery.project_path, project))
    .then_some(discovery)
}

fn rpc_url(discovery: &Discovery) -> String {
    let host = discovery.host.as_deref().unwrap_or(DEFAULT_HOST);
    format!("http://{host}:{}/rpc", discovery.port)
}

fn project_name(project: &Path) -> String {
    project
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_else(|| project.display().to_string())
}

fn same_path(left: &str, right: &Path) -> bool {
    let normalize = |value: &str| {
        value
            .replace('\\', "/")
            .trim_end_matches('/')
            .to_lowercase()
    };
    normalize(left) == normalize(&right.to_string_lossy())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn discovery_requires_a_port_and_token() {
        let root =
            std::env::temp_dir().join(format!("godot-vibe-discovery-{}", nanoid::nanoid!(8)));
        let directory = root.join(".godot/godot-vibe-os");
        std::fs::create_dir_all(&directory).unwrap();
        std::fs::write(
            directory.join("bridge.json"),
            format!(
                r#"{{"host":"127.0.0.1","port":38588,"token":"{}","projectPath":"{}","protocolVersion":"1.1"}}"#,
                "s".repeat(32),
                root.display()
            ),
        )
        .unwrap();
        let discovery = read_discovery(&root).expect("valid discovery");
        assert_eq!(rpc_url(&discovery), "http://127.0.0.1:38588/rpc");
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn discovery_rejects_remote_hosts_and_forged_project_identity() {
        let root =
            std::env::temp_dir().join(format!("godot-vibe-discovery-{}", nanoid::nanoid!(8)));
        let directory = root.join(".godot/godot-vibe-os");
        std::fs::create_dir_all(&directory).unwrap();
        let file = directory.join("bridge.json");
        std::fs::write(
            &file,
            format!(
                r#"{{"host":"example.com","port":38588,"token":"{}","projectPath":"{}","protocolVersion":"1.1"}}"#,
                "s".repeat(32),
                root.display()
            ),
        )
        .unwrap();
        assert!(read_discovery(&root).is_none());
        std::fs::write(
            &file,
            format!(
                r#"{{"host":"127.0.0.1","port":38588,"token":"{}","projectPath":"/another/project","protocolVersion":"1.1"}}"#,
                "s".repeat(32)
            ),
        )
        .unwrap();
        assert!(read_discovery(&root).is_none());
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn response_identity_rejects_a_different_project() {
        let response = serde_json::json!({
            "ok": true,
            "meta": { "projectPath": "/Users/x/Other" },
            "result": {}
        });
        let error = ensure_response_project(&response, Path::new("/Users/x/Game"))
            .expect_err("different Godot project must be rejected");
        assert!(error.to_string().contains("PROJECT_IDENTITY_MISMATCH"));
    }

    #[test]
    fn rpc_errors_preserve_addon_codes_for_actionable_ui_copy() {
        let capture = serde_json::json!({
            "error": {
                "code": "CAPTURE_UNAVAILABLE",
                "message": "The 3D editor viewport is unavailable."
            }
        });
        assert_eq!(
            response_error(&capture, reqwest::StatusCode::BAD_REQUEST),
            (
                "CAPTURE_UNAVAILABLE".into(),
                "The 3D editor viewport is unavailable.".into()
            )
        );

        let unauthorized = serde_json::json!({ "error": "unauthorized" });
        assert_eq!(
            response_error(&unauthorized, reqwest::StatusCode::UNAUTHORIZED),
            ("unauthorized".into(), "Unauthorized".into())
        );
    }
}
