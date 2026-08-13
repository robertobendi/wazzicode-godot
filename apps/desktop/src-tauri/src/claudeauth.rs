//! Claude subscription credential isolation for app-launched children.

use crate::error::{AppError, AppResult};
use portable_pty::CommandBuilder;
use serde::Deserialize;
use std::process::Command;
use std::time::Duration;

const CREDENTIAL_SERVICE: &str = "com.wazzicode.unityvibestudio";
const CREDENTIAL_ACCOUNT: &str = "claude-oauth-token";
const OAUTH_TOKEN_ENV: &str = "CLAUDE_CODE_OAUTH_TOKEN";
const OAUTH_TOKEN_FD_ENV: &str = "CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR";
const EFFORT_ENV: &str = "CLAUDE_CODE_EFFORT_LEVEL";
const OFFICIAL_API_BASE: &str = "https://api.anthropic.com";
const AUTH_STATUS_TIMEOUT: Duration = Duration::from_secs(10);
const INHERITED_AUTH_ENV_VARS: &[&str] = &[
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
    "ANTHROPIC_ORGANIZATION_ID",
    "ANTHROPIC_AWS_API_KEY",
    "ANTHROPIC_BEDROCK_MANTLE_API_KEY",
    "ANTHROPIC_FOUNDRY_API_KEY",
    "ANTHROPIC_FOUNDRY_AUTH_TOKEN",
    "ANTHROPIC_IDENTITY_TOKEN",
    "ANTHROPIC_IDENTITY_TOKEN_FILE",
    "CLAUDE_API_KEY",
    "CLAUDE_BRIDGE_OAUTH_TOKEN",
    "CLAUDE_SESSION_INGRESS_TOKEN_FILE",
    "CLAUDE_TRUSTED_DEVICE_TOKEN",
    OAUTH_TOKEN_ENV,
    "CLAUDE_CODE_OAUTH_REFRESH_TOKEN",
    "CLAUDE_CODE_OAUTH_SCOPES",
    "CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR",
    OAUTH_TOKEN_FD_ENV,
    "CLAUDE_CODE_WEBSOCKET_AUTH_FILE_DESCRIPTOR",
    "CCR_OAUTH_TOKEN_FILE",
    "CLAUDE_CODE_HOST_CREDS_FILE",
    "CLAUDE_CODE_HOST_AUTH_ENV_VAR",
    "CLAUDE_CODE_SESSION_ACCESS_TOKEN",
    "CLAUDE_CODE_HFI_BEARER_TOKEN",
];
const INHERITED_ROUTING_ENV_VARS: &[&str] = &[
    "ANTHROPIC_BASE_URL",
    "ANTHROPIC_CONFIG_DIR",
    "ANTHROPIC_MODEL",
    "ANTHROPIC_DEFAULT_FABLE_MODEL",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL",
    "ANTHROPIC_DEFAULT_OPUS_MODEL",
    "ANTHROPIC_DEFAULT_SONNET_MODEL",
    "ANTHROPIC_AWS_BASE_URL",
    "ANTHROPIC_BEDROCK_BASE_URL",
    "ANTHROPIC_BEDROCK_MANTLE_BASE_URL",
    "ANTHROPIC_VERTEX_BASE_URL",
    "ANTHROPIC_FOUNDRY_BASE_URL",
    "ANTHROPIC_CUSTOM_HEADERS",
    "ANTHROPIC_UNIX_SOCKET",
    "ANTHROPIC_AWS_WORKSPACE_ID",
    "ANTHROPIC_FOUNDRY_RESOURCE",
    "ANTHROPIC_VERTEX_PROJECT_ID",
    "CLAUDE_CODE_API_BASE_URL",
    "CLAUDE_CODE_ARTIFACTS_API_BASE_URL",
    "_CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL",
    "CLAUDE_CODE_GB_BASE_URL",
    "CLAUDE_CODE_CUSTOM_OAUTH_URL",
    "CLAUDE_CODE_OAUTH_CLIENT_ID",
    "CLAUDE_CODE_MANAGED_SETTINGS_PATH",
    "CLAUDE_CODE_REMOTE_SETTINGS_PATH",
    "CLAUDE_CODE_MOCK_REMOTE_SETTINGS",
    "CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST",
    "CLAUDE_CODE_CLIENT_CERT",
    "CLAUDE_CODE_CLIENT_KEY",
    "CLAUDE_CODE_CLIENT_KEY_PASSPHRASE",
    "CLAUDE_CODE_HTTP_PROXY",
    "CLAUDE_CODE_HTTPS_PROXY",
    "CLAUDE_CODE_PROXY_URL",
    "CLAUDE_CODE_PROXY_HOST",
    "CLAUDE_CODE_HOST_HTTP_PROXY_PORT",
    "CLAUDE_CODE_HOST_SOCKS_PROXY_PORT",
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "ALL_PROXY",
    "NO_PROXY",
    "http_proxy",
    "https_proxy",
    "all_proxy",
    "no_proxy",
    "NODE_EXTRA_CA_CERTS",
    "SSL_CERT_FILE",
    "SSL_CERT_DIR",
    EFFORT_ENV,
    "CLAUDE_CODE_USE_BEDROCK",
    "CLAUDE_CODE_USE_VERTEX",
    "CLAUDE_CODE_USE_FOUNDRY",
    "CLAUDE_CODE_USE_ANTHROPIC_AWS",
    "CLAUDE_CODE_USE_GATEWAY",
    "CLAUDE_CODE_USE_MANTLE",
    "CLAUDE_AI_AUTHORIZE_URL",
    "CLAUDE_BASE",
    "CLAUDE_BRIDGE_BASE_URL",
    "CLAUDE_BRIDGE_SESSION_INGRESS_URL",
    "CLAUDE_CONFIG_DIR",
    "CLAUDE_LOCAL_OAUTH_API_BASE",
    "CLAUDE_LOCAL_OAUTH_APPS_BASE",
    "CLAUDE_LOCAL_OAUTH_CONSOLE_BASE",
    "CLAUDE_SECURESTORAGE_CONFIG_DIR",
];

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CliAuthStatus {
    logged_in: bool,
    auth_method: Option<String>,
    api_provider: Option<String>,
    subscription_type: Option<String>,
}

/// Keeps the parent side of a token descriptor alive until the child has
/// spawned. The descriptor is inherited by the child but never written to
/// disk or exposed in argv.
#[must_use]
pub struct CredentialGuard {
    #[cfg(unix)]
    _token_reader: Option<std::os::unix::net::UnixStream>,
}

impl CredentialGuard {
    fn empty() -> Self {
        Self {
            #[cfg(unix)]
            _token_reader: None,
        }
    }
}

pub fn is_isolated_var(name: &str) -> bool {
    INHERITED_AUTH_ENV_VARS
        .iter()
        .chain(INHERITED_ROUTING_ENV_VARS)
        .any(|candidate| name.eq_ignore_ascii_case(candidate))
}

/// Apply safe auth/routing settings to every app-launched Claude process.
/// When an app-managed token exists, it is read from the OS credential store
/// and injected through a file descriptor on Unix (process environment on
/// other platforms). Keep the returned guard alive until `spawn()` returns.
pub fn configure_child(cmd: &mut Command) -> AppResult<CredentialGuard> {
    let token = load_oauth_token()?;
    if token.is_none() {
        verify_cli_subscription()?;
    }
    configure_child_with_token(cmd, token.as_deref())
}

/// Verify that Studio has a subscription credential without making an
/// inference request. A stored app token has already passed the private
/// `claude setup-token` candidate check before this module will persist it.
pub fn verify_subscription_access() -> AppResult<()> {
    if load_oauth_token()?.is_some() {
        Ok(())
    } else {
        verify_cli_subscription()
    }
}

/// Fail closed unless Claude's own local status identifies a first-party
/// Claude subscription. App-managed tokens are admitted separately because
/// this app obtains them only from `claude setup-token`, whose CLI contract is
/// subscription-only.
pub fn verify_cli_subscription() -> AppResult<()> {
    let mut cmd = crate::proc::command("claude")?;
    scrub_inherited_credentials(&mut cmd);
    let settings = serde_json::to_string(&settings_document(None, false))?;
    cmd.args([
        "--setting-sources",
        "",
        "--settings",
        &settings,
        "auth",
        "status",
        "--json",
    ]);
    let output = crate::proc::output_with_timeout(cmd, AUTH_STATUS_TIMEOUT)?;
    validate_cli_auth_status(output.status.success(), &output.stdout)
}

fn validate_cli_auth_status(success: bool, stdout: &[u8]) -> AppResult<()> {
    let status: CliAuthStatus = serde_json::from_slice(stdout).map_err(|_| {
        AppError::Other(
            "Claude sign-in status could not be verified. Sign in with a Claude subscription and try again."
                .into(),
        )
    })?;
    let subscription = status
        .subscription_type
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty());
    if success
        && status.logged_in
        && status.auth_method.as_deref() == Some("claude.ai")
        && status.api_provider.as_deref() == Some("firstParty")
        && subscription.is_some()
    {
        return Ok(());
    }
    Err(AppError::Other(
        "Claude is not signed in with a verified Claude subscription. Use `claude auth login --claudeai` or pair a subscription token in Settings."
            .into(),
    ))
}

pub(crate) fn configure_child_with_token(
    cmd: &mut Command,
    token: Option<&str>,
) -> AppResult<CredentialGuard> {
    scrub_inherited_credentials(cmd);

    let (guard, oauth_fd, preserve_oauth_env) = match token {
        Some(token) => inject_token(cmd, validate_token(token)?)?,
        None => (CredentialGuard::empty(), None, false),
    };
    #[cfg(not(unix))]
    if token.is_some() {
        // Windows has no POSIX descriptor inheritance for Claude's secure FD
        // channel. Exclude file-based sources so a repository cannot replace
        // the process token; managed policy still applies.
        cmd.arg("--setting-sources").arg("");
        // Empty setting sources also disable CLAUDE.md discovery. Preserve the
        // onboarding-generated project instructions explicitly; the CLI reads
        // this file before starting the turn.
        if let Some(path) = project_instructions(cmd) {
            cmd.arg("--append-system-prompt-file").arg(path);
        }
    }
    let settings =
        serde_json::to_string(&settings_document(oauth_fd.as_deref(), preserve_oauth_env))?;
    cmd.arg("--settings").arg(settings);
    Ok(guard)
}

#[cfg(any(not(unix), test))]
fn project_instructions(cmd: &Command) -> Option<std::path::PathBuf> {
    let path = cmd.get_current_dir()?.join("CLAUDE.md");
    path.is_file().then_some(path)
}

/// Safe, non-secret settings for `claude setup-token`.
pub fn pairing_settings_json() -> AppResult<String> {
    Ok(serde_json::to_string(&settings_document(None, false))?)
}

pub fn scrub_inherited_credentials(cmd: &mut Command) {
    for var in INHERITED_AUTH_ENV_VARS
        .iter()
        .chain(INHERITED_ROUTING_ENV_VARS)
    {
        cmd.env_remove(var);
    }
}

pub fn scrub_pty_credentials(cmd: &mut CommandBuilder) {
    for var in INHERITED_AUTH_ENV_VARS
        .iter()
        .chain(INHERITED_ROUTING_ENV_VARS)
    {
        cmd.env_remove(var);
    }
}

pub fn prefer_cli_effort(cmd: &mut Command) {
    cmd.env_remove(EFFORT_ENV);
}

pub(crate) fn store_oauth_token(token: &str) -> AppResult<()> {
    let entry = credential_entry()?;
    store_oauth_token_in(&entry, token)
}

pub fn load_oauth_token() -> AppResult<Option<String>> {
    let entry = credential_entry()?;
    load_oauth_token_from(&entry)
}

pub fn clear_oauth_token() -> AppResult<()> {
    let entry = credential_entry()?;
    clear_oauth_token_from(&entry)
}

fn credential_entry() -> AppResult<keyring::Entry> {
    keyring::Entry::new(CREDENTIAL_SERVICE, CREDENTIAL_ACCOUNT).map_err(|error| {
        AppError::Other(format!(
            "The system credential store for Claude couldn't be opened: {error}"
        ))
    })
}

fn store_oauth_token_in(entry: &keyring::Entry, token: &str) -> AppResult<()> {
    let token = validate_token(token)?;
    entry.set_password(token).map_err(|error| {
        AppError::Other(format!(
            "The Claude credential couldn't be saved in the system credential store: {error}"
        ))
    })
}

fn load_oauth_token_from(entry: &keyring::Entry) -> AppResult<Option<String>> {
    match entry.get_password() {
        Ok(token) => Ok(Some(validate_token(&token)?.to_string())),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(error) => Err(AppError::Other(format!(
            "The Claude credential couldn't be read from the system credential store: {error}"
        ))),
    }
}

fn clear_oauth_token_from(entry: &keyring::Entry) -> AppResult<()> {
    match entry.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(error) => Err(AppError::Other(format!(
            "The Claude credential couldn't be removed from the system credential store: {error}"
        ))),
    }
}

#[cfg(unix)]
fn inject_token(
    cmd: &mut Command,
    token: &str,
) -> AppResult<(CredentialGuard, Option<String>, bool)> {
    use std::io::Write;
    use std::net::Shutdown;
    use std::os::fd::AsRawFd;
    use std::os::unix::net::UnixStream;
    use std::os::unix::process::CommandExt;

    let (reader, mut writer) = UnixStream::pair()?;
    let fd = reader.as_raw_fd();
    let flags = unsafe { libc::fcntl(fd, libc::F_GETFD) };
    if flags == -1 || unsafe { libc::fcntl(fd, libc::F_SETFD, flags | libc::FD_CLOEXEC) } == -1 {
        return Err(std::io::Error::last_os_error().into());
    }
    // Clear CLOEXEC only in this child after fork. Clearing it in the parent
    // would let an unrelated concurrent spawn inherit the credential pipe.
    unsafe {
        cmd.pre_exec(move || {
            let child_flags = libc::fcntl(fd, libc::F_GETFD);
            if child_flags == -1
                || libc::fcntl(fd, libc::F_SETFD, child_flags & !libc::FD_CLOEXEC) == -1
            {
                return Err(std::io::Error::last_os_error());
            }
            Ok(())
        });
    }
    writer.write_all(token.as_bytes())?;
    writer.shutdown(Shutdown::Write)?;
    drop(writer);

    let fd = fd.to_string();
    cmd.env(OAUTH_TOKEN_FD_ENV, &fd);
    Ok((
        CredentialGuard {
            _token_reader: Some(reader),
        },
        Some(fd),
        false,
    ))
}

#[cfg(not(unix))]
fn inject_token(
    cmd: &mut Command,
    token: &str,
) -> AppResult<(CredentialGuard, Option<String>, bool)> {
    cmd.env(OAUTH_TOKEN_ENV, token);
    Ok((CredentialGuard::empty(), None, true))
}

fn validate_token(token: &str) -> AppResult<&str> {
    const PREFIX: &str = "sk-ant-oat01-";
    token
        .strip_prefix(PREFIX)
        .filter(|suffix| suffix.len() >= 20)
        .filter(|suffix| suffix.len() <= 512)
        .filter(|suffix| suffix.chars().all(|c| c.is_ascii_graphic()))
        .map(|_| token)
        .ok_or_else(|| AppError::Other("Claude returned an invalid OAuth token.".into()))
}

fn settings_document(oauth_fd: Option<&str>, preserve_oauth_env: bool) -> serde_json::Value {
    let mut env = serde_json::Map::new();
    for name in INHERITED_AUTH_ENV_VARS
        .iter()
        .chain(INHERITED_ROUTING_ENV_VARS)
    {
        if preserve_oauth_env && *name == OAUTH_TOKEN_ENV {
            continue;
        }
        env.insert((*name).into(), "".into());
    }

    for (name, value) in [
        ("ANTHROPIC_BASE_URL", OFFICIAL_API_BASE),
        ("CLAUDE_CODE_API_BASE_URL", OFFICIAL_API_BASE),
        ("CLAUDE_CODE_USE_BEDROCK", "0"),
        ("CLAUDE_CODE_USE_VERTEX", "0"),
        ("CLAUDE_CODE_USE_FOUNDRY", "0"),
        ("CLAUDE_CODE_USE_ANTHROPIC_AWS", "0"),
        ("CLAUDE_CODE_USE_GATEWAY", "0"),
        ("CLAUDE_CODE_USE_MANTLE", "0"),
        ("CLAUDE_CODE_SUBPROCESS_ENV_SCRUB", "1"),
    ] {
        env.insert(name.into(), value.into());
    }
    if let Some(fd) = oauth_fd {
        env.insert(OAUTH_TOKEN_FD_ENV.into(), fd.into());
    }

    serde_json::json!({
        "disableAllHooks": true,
        "disableSkillShellExecution": true,
        "forceLoginMethod": "claudeai",
        "apiKeyHelper": "",
        "proxyAuthHelper": "",
        "awsCredentialExport": "",
        "awsAuthRefresh": "",
        "gcpAuthRefresh": "",
        "otelHeadersHelper": "",
        "env": env,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn token() -> &'static str {
        "sk-ant-oat01-AbCd1234EfGh5678IjKl9012MnOp"
    }

    fn mock_entry() -> keyring::Entry {
        keyring::Entry::new_with_credential(Box::new(keyring::mock::MockCredential::default()))
    }

    #[test]
    fn recognizes_all_isolated_credentials_and_routing_case_insensitively() {
        for required in [
            "ANTHROPIC_API_KEY",
            "ANTHROPIC_BASE_URL",
            "ANTHROPIC_CONFIG_DIR",
            "CLAUDE_CONFIG_DIR",
            "CLAUDE_SECURESTORAGE_CONFIG_DIR",
            "CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST",
        ] {
            assert!(is_isolated_var(required), "missing {required}");
        }
        for name in INHERITED_AUTH_ENV_VARS
            .iter()
            .chain(INHERITED_ROUTING_ENV_VARS)
        {
            assert!(is_isolated_var(name), "{name}");
            assert!(is_isolated_var(&name.to_ascii_lowercase()), "{name}");
        }
        assert!(!is_isolated_var("PATH"));
    }

    #[test]
    fn configure_always_scrubs_routing_and_applies_safe_inline_settings() {
        let mut cmd = Command::new("claude");
        cmd.env("ANTHROPIC_API_KEY", "secret")
            .env("ANTHROPIC_AUTH_TOKEN", "bearer")
            .env(OAUTH_TOKEN_ENV, "inherited")
            .env("ANTHROPIC_BASE_URL", "https://untrusted.invalid")
            .env(
                "CLAUDE_CODE_ARTIFACTS_API_BASE_URL",
                "https://untrusted.invalid",
            )
            .env("CLAUDE_CONFIG_DIR", "/tmp/untrusted-claude")
            .env("CLAUDE_CODE_USE_BEDROCK", "1")
            .env("SAFE_FOR_CHILD", "kept");

        let _guard = configure_child_with_token(&mut cmd, None).unwrap();

        let envs = cmd.get_envs().collect::<Vec<_>>();
        for key in [
            "ANTHROPIC_API_KEY",
            "ANTHROPIC_AUTH_TOKEN",
            OAUTH_TOKEN_ENV,
            "ANTHROPIC_BASE_URL",
            "CLAUDE_CODE_ARTIFACTS_API_BASE_URL",
            "CLAUDE_CONFIG_DIR",
            "CLAUDE_CODE_USE_BEDROCK",
        ] {
            assert!(envs
                .iter()
                .any(|(candidate, value)| *candidate == key && value.is_none()));
        }
        assert!(envs.iter().any(|(key, value)| {
            *key == "SAFE_FOR_CHILD" && value == &Some(std::ffi::OsStr::new("kept"))
        }));

        let args = cmd.get_args().collect::<Vec<_>>();
        assert_eq!(args[args.len() - 2], "--settings");
        let settings: serde_json::Value =
            serde_json::from_str(&args[args.len() - 1].to_string_lossy()).unwrap();
        assert_eq!(settings["disableAllHooks"], true);
        assert_eq!(settings["disableSkillShellExecution"], true);
        assert_eq!(settings["forceLoginMethod"], "claudeai");
        assert_eq!(settings["apiKeyHelper"], "");
        assert_eq!(settings["env"]["ANTHROPIC_BASE_URL"], OFFICIAL_API_BASE);
        assert_eq!(settings["env"]["CLAUDE_CODE_SUBPROCESS_ENV_SCRUB"], "1");
        assert_eq!(settings["env"][EFFORT_ENV], "");
    }

    #[cfg(unix)]
    #[test]
    fn app_token_uses_an_inherited_descriptor_and_never_argv() {
        use std::io::Read;

        let mut cmd = Command::new("claude");
        let mut guard = configure_child_with_token(&mut cmd, Some(token())).unwrap();
        let args = cmd
            .get_args()
            .map(|arg| arg.to_string_lossy().into_owned())
            .collect::<Vec<_>>();
        assert!(!args.iter().any(|arg| arg.contains(token())));

        let fd = cmd
            .get_envs()
            .find_map(|(name, value)| {
                (name == OAUTH_TOKEN_FD_ENV).then(|| value.unwrap().to_string_lossy().into_owned())
            })
            .unwrap();
        let settings: serde_json::Value = serde_json::from_str(args.last().unwrap()).unwrap();
        assert_eq!(settings["env"][OAUTH_TOKEN_FD_ENV], fd);
        assert_eq!(settings["env"][OAUTH_TOKEN_ENV], "");

        let mut injected = String::new();
        guard
            ._token_reader
            .take()
            .unwrap()
            .read_to_string(&mut injected)
            .unwrap();
        assert_eq!(injected, token());
    }

    #[cfg(unix)]
    #[test]
    fn token_descriptor_survives_exec_only_for_the_configured_child() {
        let mut cmd = Command::new("/bin/sh");
        let (_guard, _, _) = inject_token(&mut cmd, token()).unwrap();
        cmd.args(["-c", "cat <&$CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR"]);
        let output = cmd.output().unwrap();
        assert!(output.status.success());
        assert_eq!(String::from_utf8(output.stdout).unwrap(), token());
    }

    #[test]
    fn credential_entry_round_trips_replaces_and_clears() {
        let entry = mock_entry();
        store_oauth_token_in(&entry, token()).unwrap();
        assert_eq!(
            load_oauth_token_from(&entry).unwrap().as_deref(),
            Some(token())
        );

        let replacement = "sk-ant-oat01-ZyXw9876VuTs5432RqPo1098NmLk";
        store_oauth_token_in(&entry, replacement).unwrap();
        assert_eq!(
            load_oauth_token_from(&entry).unwrap().as_deref(),
            Some(replacement)
        );
        clear_oauth_token_from(&entry).unwrap();
        assert_eq!(load_oauth_token_from(&entry).unwrap(), None);
        clear_oauth_token_from(&entry).unwrap();
    }

    #[test]
    #[ignore = "touches the native OS credential store"]
    fn native_credential_store_round_trip() {
        let account = format!("claude-oauth-qa-{}", nanoid::nanoid!());
        let entry = keyring::Entry::new(CREDENTIAL_SERVICE, &account).unwrap();
        struct Cleanup<'a>(&'a keyring::Entry);
        impl Drop for Cleanup<'_> {
            fn drop(&mut self) {
                let _ = clear_oauth_token_from(self.0);
            }
        }
        let _cleanup = Cleanup(&entry);

        store_oauth_token_in(&entry, token()).unwrap();
        assert_eq!(
            load_oauth_token_from(&entry).unwrap().as_deref(),
            Some(token())
        );
        clear_oauth_token_from(&entry).unwrap();
        assert_eq!(load_oauth_token_from(&entry).unwrap(), None);
    }

    #[test]
    fn safe_settings_neutralize_every_isolated_source() {
        let document = settings_document(Some("17"), false);
        for name in INHERITED_AUTH_ENV_VARS
            .iter()
            .chain(INHERITED_ROUTING_ENV_VARS)
        {
            assert!(document["env"].get(*name).is_some(), "{name}");
        }
        assert_eq!(document["env"][OAUTH_TOKEN_FD_ENV], "17");
        assert_eq!(document["env"]["CLAUDE_CODE_GB_BASE_URL"], "");
        assert_eq!(document["otelHeadersHelper"], "");

        let pairing = settings_document(None, false);
        assert_eq!(pairing["env"][OAUTH_TOKEN_ENV], "");
        assert_eq!(pairing["env"][OAUTH_TOKEN_FD_ENV], "");
    }

    #[test]
    fn accepts_only_complete_first_party_subscription_status() {
        let valid = br#"{
            "loggedIn": true,
            "authMethod": "claude.ai",
            "apiProvider": "firstParty",
            "subscriptionType": "max",
            "email": "ignored@example.invalid"
        }"#;
        assert!(validate_cli_auth_status(true, valid).is_ok());

        for invalid in [
            br#"{"loggedIn":false,"authMethod":"claude.ai","apiProvider":"firstParty","subscriptionType":"max"}"#.as_slice(),
            br#"{"loggedIn":true,"authMethod":"api_key","apiProvider":"firstParty","subscriptionType":"max"}"#.as_slice(),
            br#"{"loggedIn":true,"authMethod":"claude.ai","apiProvider":"thirdParty","subscriptionType":"max"}"#.as_slice(),
            br#"{"loggedIn":true,"authMethod":"claude.ai","apiProvider":"firstParty","subscriptionType":"  "}"#.as_slice(),
            br#"{"loggedIn":true,"authMethod":"claude.ai","apiProvider":"firstParty"}"#.as_slice(),
            b"not json".as_slice(),
        ] {
            assert!(validate_cli_auth_status(true, invalid).is_err());
        }
        assert!(validate_cli_auth_status(false, valid).is_err());
    }

    #[test]
    fn rejects_malformed_tokens() {
        for value in ["", "sk-ant-oat01-short", "sk-ant-oat01-bad value"] {
            assert!(validate_token(value).is_err(), "{value}");
        }
        assert!(validate_token("sk-ant-oat01-AbCd.1234_5678-+/=~Token").is_ok());
    }

    #[test]
    fn explicit_effort_removes_the_higher_precedence_environment_override() {
        let mut cmd = Command::new("claude");
        cmd.env(EFFORT_ENV, "low");
        prefer_cli_effort(&mut cmd);
        assert!(cmd
            .get_envs()
            .any(|(key, value)| key == EFFORT_ENV && value.is_none()));
    }

    #[test]
    fn finds_root_project_instructions_for_restricted_setting_sources() {
        let dir = std::env::temp_dir().join(format!("claude-instructions-{}", nanoid::nanoid!()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("CLAUDE.md"), "project rules").unwrap();
        let mut cmd = Command::new("claude");
        cmd.current_dir(&dir);
        assert_eq!(project_instructions(&cmd), Some(dir.join("CLAUDE.md")));
        std::fs::remove_dir_all(dir).unwrap();
    }
}
