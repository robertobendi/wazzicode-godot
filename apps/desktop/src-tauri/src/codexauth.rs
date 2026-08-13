//! Codex sign-in driver.
//!
//! Same principle as the Claude pairing flow — **CLI-managed credentials, no
//! token handling by us** — but a much simpler mechanism, because `codex login`
//! doesn't need a TTY the way `claude setup-token` does. It starts a local
//! callback server, opens the browser at ChatGPT, and writes its own credentials
//! to `$CODEX_HOME/auth.json` (default `~/.codex`). We never see, store, or
//! inject a token; later `codex exec` spawns just inherit the environment and
//! use those credentials.
//!
//! So this module only has to:
//!   1. run `codex login status` to ask "are we signed in with ChatGPT?";
//!   2. spawn `codex login`, scrape the sign-in URL off its output so the user
//!      can click it (or forward it) if the browser didn't open by itself;
//!   3. poll status until it flips, then stop the child.
//!
//! **Subscription only, by construction.** Plain `codex login` is the ChatGPT
//! sign-in, which bills the user's *plan*. Codex also supports an API-key login
//! (`--with-api-key`), which bills *API credits* instead — a different wallet, and
//! not one this product wants to spend from by accident. We therefore don't
//! expose that path at all, scrub inherited API/access-token variables, and pin
//! login commands to the CLI's official ChatGPT endpoint and auth method.
//! These controls cover Codex's inference transport; tools run by the agent
//! retain the project environment Studio intentionally gives them.
//!
//! At most one login runs at a time.

use crate::error::{AppError, AppResult};
use serde::Serialize;
use std::process::{Command, Stdio};
use std::sync::Arc;
use std::time::Duration;
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::sync::Mutex as AsyncMutex;

/// Credentials inherited from the app launcher could silently select another
/// account, while internal endpoint overrides can redirect refresh/revoke
/// tokens. App runs use only the CLI's persisted login and official endpoints.
pub const ISOLATED_ENV_VARS: &[&str] = &[
    "OPENAI_API_KEY",
    "OPENAI_BASE_URL",
    "OPENAI_ORGANIZATION",
    "OPENAI_PROJECT",
    "CODEX_API_KEY",
    "CODEX_ACCESS_TOKEN",
    "CODEX_AUTH",
    "CODEX_HOME",
    "CODEX_OSS_BASE_URL",
    "CODEX_OSS_PORT",
    "CODEX_REFRESH_TOKEN_URL_OVERRIDE",
    "CODEX_REVOKE_TOKEN_URL_OVERRIDE",
    "CODEX_AUTHAPI_BASE_URL",
    "CODEX_APP_SERVER_LOGIN_CLIENT_ID",
    "CODEX_EXEC_SERVER_URL",
    "CODEX_EXEC_SERVER_NOISE_REGISTRY_URL",
    "CODEX_EXEC_SERVER_NOISE_ENVIRONMENT_ID",
    "CODEX_EXEC_SERVER_NOISE_AUTH_TOKEN",
    "CODEX_EXEC_SERVER_NOISE_CHATGPT_ACCOUNT_ID",
    "CODEX_CONNECTORS_TOKEN",
    "CODEX_GITHUB_PERSONAL_ACCESS_TOKEN",
    "CODEX_URL",
    "CODEX_CA_CERTIFICATE",
    "SSL_CERT_FILE",
    "SSL_CERT_DIR",
    "REQUESTS_CA_BUNDLE",
    "CURL_CA_BUNDLE",
    "NODE_EXTRA_CA_CERTS",
    "GIT_SSL_CAINFO",
    "PIP_CERT",
    "BUNDLE_SSL_CA_CERT",
    "npm_config_cafile",
    "NPM_CONFIG_CAFILE",
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "ALL_PROXY",
    "NO_PROXY",
    "http_proxy",
    "https_proxy",
    "all_proxy",
    "no_proxy",
];
pub const SUBSCRIPTION_CONFIG_OVERRIDES: &[&str] = &[
    "forced_login_method='chatgpt'",
    "model_provider='openai'",
    "chatgpt_base_url='https://chatgpt.com/backend-api/'",
];

/// Strip one-shot credentials, token endpoints, and remote execution routing
/// so the child uses the persisted ChatGPT login and local project environment.
pub fn isolate_child_environment(cmd: &mut Command) {
    for var in ISOLATED_ENV_VARS {
        cmd.env_remove(var);
    }
}

/// Login subcommands do not expose `--ignore-user-config`, so override the two
/// user-config keys that can change the account flow or redirect it.
fn configure_subscription_auth(cmd: &mut Command) {
    isolate_child_environment(cmd);
    for value in SUBSCRIPTION_CONFIG_OVERRIDES {
        cmd.args(["-c", value]);
    }
}

/// How long we let a browser sign-in run before giving up. The user has to
/// switch to a browser, sign in, and come back — generous, but finite so a
/// walked-away login can't leak a child process forever.
const LOGIN_TIMEOUT: Duration = Duration::from_secs(300);
/// How often we re-ask `codex login status` while waiting.
const POLL_INTERVAL: Duration = Duration::from_secs(2);
const STATUS_TIMEOUT: Duration = Duration::from_secs(10);

/// Result of `codex login status`.
#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct CodexAuthStatus {
    /// Is the `codex` binary on PATH at all?
    pub installed: bool,
    pub logged_in: bool,
    /// The CLI's status line, or an actionable explanation for an incompatible
    /// login mode.
    pub detail: Option<String>,
}

/// Progress of an in-flight `codex login`, mirrored to the UI on every change.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LoginUpdate {
    pub phase: LoginPhase,
    /// The ChatGPT sign-in URL, once the CLI prints it.
    pub url: Option<String>,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum LoginPhase {
    Starting,
    /// Waiting on the user to finish in the browser.
    AwaitingBrowser,
    Success,
    Failed,
    Cancelled,
}

/// Tracks the single in-flight login so it can be cancelled.
struct LoginAttempt {
    id: String,
    child: tokio::process::Child,
}

#[derive(Clone, Default)]
pub struct CodexLoginManager {
    child: Arc<AsyncMutex<Option<LoginAttempt>>>,
}

impl CodexLoginManager {
    /// Ask the CLI whether we're signed in. Cheap; safe to call on every render.
    pub async fn status(&self) -> CodexAuthStatus {
        if !crate::proc::is_installed("codex") {
            return CodexAuthStatus::default();
        }
        let Ok(mut cmd) = crate::proc::command("codex") else {
            return CodexAuthStatus::default();
        };
        cmd.args(["login", "status"]);
        configure_subscription_auth(&mut cmd);
        let mut cmd = tokio::process::Command::from(cmd);
        cmd.kill_on_drop(true);
        let out = tokio::time::timeout(STATUS_TIMEOUT, cmd.output()).await;

        match out {
            Ok(Ok(o)) => {
                let (logged_in, detail) =
                    classify_status(o.status.success(), o.stdout.as_slice(), o.stderr.as_slice());
                CodexAuthStatus {
                    installed: true,
                    logged_in,
                    detail,
                }
            }
            Ok(Err(error)) => CodexAuthStatus {
                installed: true,
                logged_in: false,
                detail: Some(format!("Codex sign-in status failed: {error}")),
            },
            Err(_) => CodexAuthStatus {
                installed: true,
                logged_in: false,
                detail: Some(
                    "Codex sign-in status timed out. Restart the CLI and try again.".into(),
                ),
            },
        }
    }

    /// Start a browser sign-in. Returns immediately; progress arrives on the
    /// `codex:login` event. Errors if a login is already running.
    ///
    /// Plain `codex login` — the ChatGPT flow, which bills the user's plan. The
    /// API-key flow (`--with-api-key`) is deliberately not offered: it spends API
    /// credits, which is a different wallet from the subscription this product is
    /// built around.
    pub async fn start(&self, app: AppHandle) -> AppResult<()> {
        let mut guard = self.child.lock().await;
        if guard.is_some() {
            return Err(AppError::Other(
                "A Codex sign-in is already running.".into(),
            ));
        }

        let mut cmd = crate::proc::command("codex")?;
        cmd.arg("login")
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        configure_subscription_auth(&mut cmd);
        let mut command = tokio::process::Command::from(cmd);
        command.kill_on_drop(true);
        let mut child = command
            .spawn()
            .map_err(|e| AppError::Other(format!("could not start Codex: {e}")))?;

        let stdout = child.stdout.take();
        let stderr = child.stderr.take();
        let attempt_id = nanoid::nanoid!();
        *guard = Some(LoginAttempt {
            id: attempt_id.clone(),
            child,
        });
        drop(guard);
        emit(&app, LoginPhase::Starting, None, None);

        // Scrape the sign-in URL off whichever stream it lands on. Codex prints
        // it while it waits on the local callback, and may or may not have
        // managed to open a browser itself — so we always surface it.
        if let Some(out) = stdout {
            scan_for_url(self.clone(), attempt_id.clone(), app.clone(), out);
        }
        if let Some(err) = stderr {
            scan_for_url(self.clone(), attempt_id.clone(), app.clone(), err);
        }

        // Wait for this exact child to exit, then ask the CLI which auth mode it
        // persisted. Waiting for exit avoids mistaking an older valid login for
        // completion of a replacement browser flow.
        let this = self.clone();
        tokio::spawn(async move {
            let deadline = tokio::time::Instant::now() + LOGIN_TIMEOUT;
            loop {
                tokio::time::sleep(POLL_INTERVAL).await;

                let Some(exited) = this.attempt_exited(&attempt_id).await else {
                    return;
                };
                if exited {
                    let logged_in = this.status().await.logged_in;
                    if !this.reap_if(&attempt_id).await {
                        return;
                    }
                    if logged_in {
                        emit(&app, LoginPhase::Success, None, None);
                    } else {
                        emit(
                            &app,
                            LoginPhase::Failed,
                            None,
                            Some("Codex sign-in closed before ChatGPT authentication completed. Try again.".into()),
                        );
                    }
                    return;
                }
                if tokio::time::Instant::now() >= deadline {
                    if this.reap_if(&attempt_id).await {
                        emit(
                            &app,
                            LoginPhase::Failed,
                            None,
                            Some("Sign-in timed out. Try again.".into()),
                        );
                    }
                    return;
                }
            }
        });

        Ok(())
    }

    /// Cancel an in-flight sign-in.
    pub async fn cancel(&self) {
        let id = self
            .child
            .lock()
            .await
            .as_ref()
            .map(|attempt| attempt.id.clone());
        if let Some(id) = id {
            self.reap_if(&id).await;
        }
    }

    async fn attempt_exited(&self, id: &str) -> Option<bool> {
        let mut guard = self.child.lock().await;
        let attempt = guard.as_mut().filter(|attempt| attempt.id == id)?;
        match attempt.child.try_wait() {
            Ok(Some(_)) => Some(true),
            Ok(None) => Some(false),
            Err(_) => Some(true),
        }
    }

    /// Kill and clear only the named attempt. An older poll task can never
    /// cancel or complete a newer browser flow.
    async fn reap_if(&self, id: &str) -> bool {
        let attempt = {
            let mut guard = self.child.lock().await;
            if !guard.as_ref().is_some_and(|attempt| attempt.id == id) {
                return false;
            }
            guard.take()
        };
        if let Some(mut attempt) = attempt {
            let _ = attempt.child.start_kill();
            let _ = attempt.child.wait().await;
        }
        true
    }

    /// Forget the stored credentials (`codex logout`).
    pub async fn logout(&self) -> AppResult<()> {
        let mut cmd = crate::proc::command("codex")?;
        cmd.arg("logout");
        configure_subscription_auth(&mut cmd);
        let mut cmd = tokio::process::Command::from(cmd);
        cmd.kill_on_drop(true);
        let output = tokio::time::timeout(STATUS_TIMEOUT, cmd.output())
            .await
            .map_err(|_| AppError::Other("Codex sign-out timed out.".into()))?
            .map_err(|error| AppError::Other(format!("could not sign out of Codex: {error}")))?;
        if output.status.success() {
            return Ok(());
        }
        let detail = [&output.stderr, &output.stdout]
            .into_iter()
            .find_map(|bytes| {
                String::from_utf8_lossy(bytes)
                    .lines()
                    .map(str::trim)
                    .find(|line| !line.is_empty())
                    .map(str::to_string)
            })
            .unwrap_or_else(|| "Codex rejected the sign-out request.".into());
        Err(AppError::Other(detail))
    }
}

/// Watch one of the child's pipes for the sign-in URL and push it to the UI.
fn scan_for_url<R>(manager: CodexLoginManager, attempt_id: String, app: AppHandle, pipe: R)
where
    R: tokio::io::AsyncRead + Unpin + Send + 'static,
{
    tokio::spawn(async move {
        let mut lines = BufReader::new(pipe).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            if let Some(url) = find_url(&line) {
                if manager.attempt_exited(&attempt_id).await.is_some() {
                    emit(&app, LoginPhase::AwaitingBrowser, Some(url), None);
                }
            }
        }
    });
}

fn emit(app: &AppHandle, phase: LoginPhase, url: Option<String>, error: Option<String>) {
    let _ = app.emit("codex:login", LoginUpdate { phase, url, error });
}

const OFFICIAL_AUTHORIZE_URL: &str = "https://auth.openai.com/oauth/authorize?";

/// First official Codex browser-login URL on a line, trimmed of punctuation the
/// CLI may wrap it in. The webview can open this URL, so reject every other host
/// and path even when it appears in otherwise valid CLI output.
fn find_url(line: &str) -> Option<String> {
    line.match_indices("https://").find_map(|(start, _)| {
        let rest = &line[start..];
        let end = rest
            .find(|c: char| {
                c.is_whitespace() || c.is_control() || c == '"' || c == '\'' || c == '<' || c == '>'
            })
            .unwrap_or(rest.len());
        let url = rest[..end].trim_end_matches(['.', ',', ')', ']']);
        (url.starts_with(OFFICIAL_AUTHORIZE_URL) && url.len() > OFFICIAL_AUTHORIZE_URL.len())
            .then(|| url.to_string())
    })
}

fn classify_status(success: bool, stdout: &[u8], stderr: &[u8]) -> (bool, Option<String>) {
    let lines = [stdout, stderr]
        .into_iter()
        .flat_map(|bytes| {
            String::from_utf8_lossy(bytes)
                .lines()
                .map(str::trim)
                .filter(|line| !line.is_empty())
                .map(str::to_string)
                .collect::<Vec<_>>()
        })
        .collect::<Vec<_>>();
    let chatgpt = lines.iter().find(|line| chatgpt_status_line(line));
    let api_key = lines
        .iter()
        .find(|line| line.starts_with("Logged in using an API key"));
    let logged_in = success && chatgpt.is_some();
    let detail = match (success, chatgpt, api_key, lines.first()) {
        (true, Some(line), _, _) => Some(line.clone()),
        (true, _, Some(_), _) => Some(
            "Codex is signed in with an API key. Sign in with ChatGPT here so tasks use your ChatGPT plan instead of API credits."
                .into(),
        ),
        (true, _, _, Some(line)) => Some(format!(
            "Codex reported an unsupported login mode ({line}). Sign in with ChatGPT to continue."
        )),
        (_, _, _, detail) => detail.cloned(),
    };
    (logged_in, detail)
}

fn chatgpt_status_line(line: &str) -> bool {
    const PREFIX: &str = "Logged in using ChatGPT";
    line == PREFIX
        || line.strip_prefix(PREFIX).is_some_and(|suffix| {
            suffix
                .chars()
                .next()
                .is_some_and(|c| c.is_whitespace() || matches!(c, '-' | '(' | '[' | '—'))
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extracts_the_sign_in_url() {
        let line = "  Open this URL to sign in: https://auth.openai.com/oauth/authorize?client_id=app&state=123 ";
        assert_eq!(
            find_url(line).as_deref(),
            Some("https://auth.openai.com/oauth/authorize?client_id=app&state=123")
        );
    }

    #[test]
    fn strips_trailing_punctuation_and_ignores_urlless_lines() {
        assert_eq!(
            find_url("Go to https://auth.openai.com/oauth/authorize?state=123.").as_deref(),
            Some("https://auth.openai.com/oauth/authorize?state=123")
        );
        assert_eq!(find_url("Starting local login server..."), None);
        assert_eq!(
            find_url(
                "Help: https://example.com then https://auth.openai.com/oauth/authorize?state=123"
            )
            .as_deref(),
            Some("https://auth.openai.com/oauth/authorize?state=123")
        );
        for untrusted in [
            "https://example.com/login",
            "https://auth.openai.com.evil.invalid/oauth/authorize?state=123",
            "https://auth.openai.com@evil.invalid/oauth/authorize?state=123",
            "https://auth.openai.com/oauth/token?state=123",
            "https://auth.openai.com/oauth/authorize?",
        ] {
            assert_eq!(find_url(untrusted), None, "{untrusted}");
        }
    }

    #[test]
    fn accepts_only_chatgpt_login_status() {
        let (logged_in, detail) = classify_status(true, b"Logged in using ChatGPT\n", b"");
        assert!(logged_in);
        assert_eq!(detail.as_deref(), Some("Logged in using ChatGPT"));

        let (logged_in, detail) =
            classify_status(true, b"Logged in using an API key - sk-proj-...\n", b"");
        assert!(!logged_in);
        assert!(detail.unwrap().contains("Sign in with ChatGPT"));

        let (logged_in, detail) = classify_status(
            true,
            b"warning: cache unavailable\nLogged in using ChatGPT - user@example.com\n",
            b"",
        );
        assert!(logged_in);
        assert!(detail.unwrap().contains("user@example.com"));
        assert!(!chatgpt_status_line("Logged in using ChatGPTish"));
    }

    /// Money/account guard: inherited one-shot credentials must never replace
    /// the CLI's persisted ChatGPT login.
    #[test]
    fn inherited_codex_overrides_are_scrubbed_from_children() {
        for required in [
            "OPENAI_API_KEY",
            "OPENAI_BASE_URL",
            "OPENAI_ORGANIZATION",
            "OPENAI_PROJECT",
            "CODEX_HOME",
            "CODEX_OSS_BASE_URL",
            "CODEX_OSS_PORT",
        ] {
            assert!(ISOLATED_ENV_VARS.contains(&required), "missing {required}");
        }
        let mut cmd = Command::new("codex");
        for var in ISOLATED_ENV_VARS {
            cmd.env(var, "untrusted");
        }
        cmd.env("PATH", "/usr/bin");
        isolate_child_environment(&mut cmd);

        let kept: Vec<_> = cmd
            .get_envs()
            // `env_remove` records the var with a `None` value — that's the
            // removal instruction, not an inherited value.
            .filter(|(_, v)| v.is_some())
            .map(|(k, _)| k.to_string_lossy().into_owned())
            .collect();
        assert!(kept.contains(&"PATH".to_string()), "PATH must survive");
        for var in ISOLATED_ENV_VARS {
            assert!(
                !kept.contains(&var.to_string()),
                "{var} must not reach a Codex child"
            );
        }
    }

    #[test]
    fn login_commands_pin_the_official_subscription_flow() {
        assert_eq!(
            SUBSCRIPTION_CONFIG_OVERRIDES,
            [
                "forced_login_method='chatgpt'",
                "model_provider='openai'",
                "chatgpt_base_url='https://chatgpt.com/backend-api/'",
            ]
        );
        let mut cmd = Command::new("codex");
        cmd.arg("login");
        configure_subscription_auth(&mut cmd);
        let args = cmd
            .get_args()
            .map(|arg| arg.to_string_lossy().into_owned())
            .collect::<Vec<_>>();
        for value in SUBSCRIPTION_CONFIG_OVERRIDES {
            assert!(args.contains(&value.to_string()), "missing {value}");
        }
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn stale_login_attempt_cannot_reap_a_newer_child() {
        let child = tokio::process::Command::new("/bin/sh")
            .args(["-c", "sleep 30"])
            .spawn()
            .unwrap();
        let manager = CodexLoginManager::default();
        *manager.child.lock().await = Some(LoginAttempt {
            id: "new-attempt".into(),
            child,
        });

        assert!(!manager.reap_if("old-attempt").await);
        assert!(manager.attempt_exited("new-attempt").await.is_some());
        assert!(manager.reap_if("new-attempt").await);
    }
}
