//! Unity bridge status poller.
//!
//! The webview can't run the Node bridge client, so this replicates just the
//! slice needed for a status pill: discovery-file read + `system.health` +
//! project-identity check, plus `compile.status` / `playmode.status` for the
//! compiling/playing indicators.
//!
//! Protocol source of truth (keep in sync):
//!   - packages/bridge-client/src/httpClient.ts  (discovery, identity guard,
//!     refused-vs-timeout → UNITY_RELOADING mapping)
//!   - packages/core/src/protocol.ts             (request envelope shape:
//!     `makeBridgeRequest` → {id, version, method, params})
//!
//! A single 2s loop runs at a time; `start_status_loop` restarts it when the
//! focused project changes. Each tick emits one `status:update` event.

use crate::error::{AppError, AppResult};
use crate::state::AppState;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::time::Duration;
use tauri::{AppHandle, Emitter};

const DISCOVERY_REL: &str = "Library/UnityVibeOS/bridge.json";
const DEFAULT_HOST: &str = "127.0.0.1";
/// Matches PROTOCOL_VERSION in packages/core/src/version.ts. The bridge does
/// not strictly validate it for reads, but we send the real value anyway.
const PROTOCOL_VERSION: &str = "1.0";
const REQUEST_TIMEOUT: Duration = Duration::from_millis(1500);
const POLL_INTERVAL: Duration = Duration::from_secs(2);

/// Connection state surfaced to the UI.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum BridgeState {
    Disconnected,
    Reloading,
    IdentityMismatch,
    Connected,
}

/// Payload of the `status:update` event.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StatusUpdate {
    pub state: BridgeState,
    pub compiling: bool,
    pub play_mode: bool,
    pub friendly: String,
}

/// Minimal view of `Library/UnityVibeOS/bridge.json`.
#[derive(Debug, Clone, Deserialize)]
struct Discovery {
    port: u16,
    #[serde(default)]
    host: Option<String>,
}

/// The running poll loop and the project it's polling.
pub struct StatusTask {
    pub project: PathBuf,
    pub handle: tokio::task::JoinHandle<()>,
}

/// Start (or restart) the status loop for `project`. If a loop for the same
/// project is already running it's left alone; a different project aborts and
/// replaces it.
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

/// Stop any running status loop.
pub async fn stop_status_loop(state: &AppState) {
    if let Some(task) = state.status_task.lock().await.take() {
        task.handle.abort();
    }
}

/// How many consecutive disconnected polls to ride out as a calm "connecting"
/// state before escalating to "Open Unity and load <project>". Covers the app
/// launching a moment before the Editor writes bridge.json, and transient reads
/// of a half-written discovery file. At POLL_INTERVAL that's ~8s of grace.
const CONNECT_GRACE_TICKS: u32 = 4;

async fn run_loop(app: AppHandle, project: PathBuf) {
    let client = reqwest::Client::builder()
        .timeout(REQUEST_TIMEOUT)
        .build()
        .unwrap_or_default();
    let mut miss_streak: u32 = 0;
    loop {
        let mut update = poll_once(&project, &client).await;
        // Soften the very first disconnected polls: a freshly launched app that
        // beat the Editor to bridge.json shouldn't flash "Open Unity" — show
        // "Connecting…" until the miss actually persists.
        if update.state == BridgeState::Disconnected {
            miss_streak = miss_streak.saturating_add(1);
            if miss_streak <= CONNECT_GRACE_TICKS {
                update.friendly = "Connecting to Unity…".into();
            }
        } else {
            miss_streak = 0;
        }
        let _ = app.emit("status:update", update);
        tokio::time::sleep(POLL_INTERVAL).await;
    }
}

/// One poll cycle. Public so a future one-shot command / test can reuse it.
pub async fn poll_once(project: &Path, client: &reqwest::Client) -> StatusUpdate {
    let name = project_name(project);

    let Some(disco) = read_discovery(project) else {
        return StatusUpdate {
            state: BridgeState::Disconnected,
            compiling: false,
            play_mode: false,
            friendly: format!("Open Unity and load {name}"),
        };
    };
    let host = disco.host.unwrap_or_else(|| DEFAULT_HOST.into());
    let url = format!("http://{host}:{}/rpc", disco.port);

    match rpc(client, &url, "system.health").await {
        RpcOutcome::Ok(value) => {
            // Identity guard: the Editor that answered must be *this* project.
            if let Some(meta_path) = value
                .get("meta")
                .and_then(|m| m.get("projectPath"))
                .and_then(|v| v.as_str())
            {
                if !same_path(meta_path, project) {
                    return StatusUpdate {
                        state: BridgeState::IdentityMismatch,
                        compiling: false,
                        play_mode: false,
                        friendly: "A different Unity project is open".into(),
                    };
                }
            }
            // Connected — fill the secondary indicators, tolerating errors.
            let compiling = rpc_bool(client, &url, "compile.status", "isCompiling").await;
            let play_mode = rpc_bool(client, &url, "playmode.status", "isPlaying").await;
            StatusUpdate {
                state: BridgeState::Connected,
                compiling,
                play_mode,
                friendly: "Unity connected".into(),
            }
        }
        // Discovery file present but socket down / erroring → almost always a
        // script-domain reload (post-compile or entering play). Recoverable.
        RpcOutcome::Refused | RpcOutcome::ErrResponse => StatusUpdate {
            state: BridgeState::Reloading,
            compiling: true,
            play_mode: false,
            friendly: "Unity is recompiling — hang on…".into(),
        },
    }
}

/// Timeout for on-demand bridge calls (screenshots render a frame — allow more
/// than the 1.5s status poll budget).
const CALL_TIMEOUT: Duration = Duration::from_secs(15);

/// Make a one-shot bridge RPC for `project` and return its `result` payload.
///
/// Unlike the status poller (which only classifies reachability), this surfaces
/// real errors so callers can map them to friendly text: `UNITY_NOT_CONNECTED`
/// when there's no discovery file, `UNITY_RELOADING` when the socket is down,
/// or the bridge's own `CODE: message` on an `ok:false` response.
pub async fn call(
    project: &Path,
    method: &str,
    params: serde_json::Value,
) -> AppResult<serde_json::Value> {
    let disco =
        read_discovery(project).ok_or_else(|| AppError::Other("UNITY_NOT_CONNECTED".into()))?;
    let host = disco.host.unwrap_or_else(|| DEFAULT_HOST.into());
    let url = format!("http://{host}:{}/rpc", disco.port);

    let client = reqwest::Client::builder()
        .timeout(CALL_TIMEOUT)
        .build()
        .map_err(|e| AppError::Other(format!("http client: {e}")))?;
    let body = serde_json::json!({
        "id": "studio",
        "version": PROTOCOL_VERSION,
        "method": method,
        "params": params,
    });

    // A refused/timed-out socket with a discovery file present is almost always
    // a script-domain reload — recoverable, so map it to UNITY_RELOADING.
    let resp = client
        .post(&url)
        .json(&body)
        .send()
        .await
        .map_err(|_| AppError::Other("UNITY_RELOADING".into()))?;
    if !resp.status().is_success() {
        return Err(AppError::Other(format!("bridge HTTP {}", resp.status())));
    }
    let v: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| AppError::Other(format!("bridge response: {e}")))?;

    ensure_response_project(&v, project)?;

    if v.get("ok").and_then(|b| b.as_bool()).unwrap_or(false) {
        return Ok(v.get("result").cloned().unwrap_or(serde_json::Value::Null));
    }
    let code = v
        .get("error")
        .and_then(|e| e.get("code"))
        .and_then(|c| c.as_str())
        .unwrap_or("BRIDGE_ERROR");
    let msg = v
        .get("error")
        .and_then(|e| e.get("message"))
        .and_then(|m| m.as_str())
        .unwrap_or("bridge returned an error");
    Err(AppError::Other(format!("{code}: {msg}")))
}

fn ensure_response_project(response: &serde_json::Value, project: &Path) -> AppResult<()> {
    let Some(actual) = response
        .get("meta")
        .and_then(|meta| meta.get("projectPath"))
        .and_then(|value| value.as_str())
    else {
        return Ok(());
    };
    if same_path(actual, project) {
        return Ok(());
    }
    Err(AppError::Other(format!(
        "PROJECT_IDENTITY_MISMATCH: Connected Unity is '{actual}' but expected '{}'.",
        project.display()
    )))
}

enum RpcOutcome {
    /// HTTP 2xx and `ok:true`; carries the parsed response.
    Ok(serde_json::Value),
    /// HTTP non-2xx or `ok:false` or unparseable body.
    ErrResponse,
    /// Connection refused / timed out.
    Refused,
}

async fn rpc(client: &reqwest::Client, url: &str, method: &str) -> RpcOutcome {
    let body = serde_json::json!({
        "id": "studio",
        "version": PROTOCOL_VERSION,
        "method": method,
        "params": {}
    });
    match client.post(url).json(&body).send().await {
        Ok(resp) => {
            if !resp.status().is_success() {
                return RpcOutcome::ErrResponse;
            }
            match resp.json::<serde_json::Value>().await {
                Ok(v) if v.get("ok").and_then(|b| b.as_bool()).unwrap_or(false) => {
                    RpcOutcome::Ok(v)
                }
                _ => RpcOutcome::ErrResponse,
            }
        }
        Err(_) => RpcOutcome::Refused,
    }
}

/// Call a status method and read a boolean out of `result.<key>`, defaulting to
/// false on any error (these indicators are best-effort).
async fn rpc_bool(client: &reqwest::Client, url: &str, method: &str, key: &str) -> bool {
    match rpc(client, url, method).await {
        RpcOutcome::Ok(v) => v
            .get("result")
            .and_then(|r| r.get(key))
            .and_then(|b| b.as_bool())
            .unwrap_or(false),
        _ => false,
    }
}

fn read_discovery(project: &Path) -> Option<Discovery> {
    let raw = std::fs::read_to_string(project.join(DISCOVERY_REL)).ok()?;
    let d: Discovery = serde_json::from_str(&raw).ok()?;
    if d.port == 0 {
        return None;
    }
    Some(d)
}

fn project_name(project: &Path) -> String {
    project
        .file_name()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| project.display().to_string())
}

/// Case-insensitive, trailing-separator-normalized path compare — mirrors
/// `samePath` in httpClient.ts.
fn same_path(a: &str, project: &Path) -> bool {
    let norm = |s: &str| s.replace('\\', "/").trim_end_matches('/').to_lowercase();
    norm(a) == norm(&project.to_string_lossy())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn same_path_normalizes() {
        assert!(same_path("/Users/x/Game/", Path::new("/Users/x/Game")));
        assert!(same_path(
            "C:\\Users\\X\\Game",
            Path::new("C:/Users/x/Game")
        ));
        assert!(!same_path("/Users/x/Other", Path::new("/Users/x/Game")));
    }

    #[test]
    fn response_identity_rejects_a_different_project() {
        let response = serde_json::json!({
            "ok": true,
            "meta": { "projectPath": "/Users/x/Other" },
            "result": {}
        });
        let error = ensure_response_project(&response, Path::new("/Users/x/Game"))
            .expect_err("a different Unity project must be rejected");
        assert!(error.to_string().contains("PROJECT_IDENTITY_MISMATCH"));
    }
}
