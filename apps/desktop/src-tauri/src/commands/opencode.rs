//! OpenCode provider credential + custom-provider management.
//!
//! OpenCode keeps provider auth in its XDG data directory. Studio edits that
//! same file so a key added in Settings is immediately available to an
//! `opencode run` child, without putting the secret in shell history or
//! injecting it into unrelated processes.
//!
//! OpenAI-compatible custom providers additionally need a `provider` entry in
//! OpenCode's global config (`~/.config/opencode/opencode.json`), and the
//! chosen default model is written to the same config's `model` key so plain
//! `opencode` uses it too. We merge there, only ever touching the matching
//! provider's `npm`, `name` and `options.baseURL` keys — every other setting is
//! left exactly as it is.

use crate::error::{AppError, AppResult};
use serde::Serialize;
use serde_json::{json, Map, Value};
use std::path::{Path, PathBuf};

const AUTH_FILE: &str = "auth.json";
const CONFIG_FILE: &str = "opencode.json";
const OPENAI_COMPAT_NPM: &str = "@ai-sdk/openai-compatible";

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct OpenCodeCredential {
    pub provider_id: String,
    pub auth_type: String,
    /// A non-secret suffix such as `••••1234`; the full key is never returned.
    pub key_hint: Option<String>,
    /// Display name from an OpenAI-compatible provider entry we configured.
    pub display_name: Option<String>,
    /// Base URL from an OpenAI-compatible provider entry we configured.
    pub base_url: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct OpenCodeAuthStatus {
    pub path: String,
    /// Where non-standard (custom) providers + the default model are configured.
    pub config_path: Option<String>,
    /// The `model` key currently in the global config, if any.
    pub default_model: Option<String>,
    pub credentials: Vec<OpenCodeCredential>,
}

#[tauri::command]
pub fn get_opencode_credentials() -> AppResult<OpenCodeAuthStatus> {
    let config_path = opencode_config_path()?;
    status_at(&opencode_auth_path()?, &config_path)
}

#[tauri::command]
pub fn set_opencode_api_key(provider_id: String, api_key: String) -> AppResult<OpenCodeAuthStatus> {
    let config_path = opencode_config_path()?;
    let path = opencode_auth_path()?;
    set_api_key_at(&path, &provider_id, &api_key)?;
    status_at(&path, &config_path)
}

/// Add an OpenAI-compatible provider: an API key in OpenCode's auth store plus
/// the `provider.<id>` entry (npm/name/baseURL) in its global config so the
/// endpoint is actually reachable. Same contract as `set_opencode_api_key` for
/// the key — never returned, only masked suffixes.
#[tauri::command]
pub fn set_opencode_compatible_provider(
    provider_id: String,
    name: String,
    base_url: String,
    api_key: String,
) -> AppResult<OpenCodeAuthStatus> {
    let auth_path = opencode_auth_path()?;
    let config_path = opencode_config_path()?;
    set_compatible_provider_at(
        &auth_path,
        &config_path,
        &provider_id,
        &name,
        &base_url,
        &api_key,
    )?;
    status_at(&auth_path, &config_path)
}

#[tauri::command]
pub fn remove_opencode_credential(provider_id: String) -> AppResult<OpenCodeAuthStatus> {
    let config_path = opencode_config_path()?;
    let path = opencode_auth_path()?;
    remove_credential_at(&path, &provider_id)?;
    status_at(&path, &config_path)
}

/// Set (or clear, with an empty string) OpenCode's global default model, in
/// `provider/model` form. This is what makes "choose a provider" stick for a
/// plain `opencode` invocation, not just Studio's own runs.
#[tauri::command]
pub fn set_opencode_default_model(model: String) -> AppResult<OpenCodeAuthStatus> {
    let auth_path = opencode_auth_path()?;
    let config_path = opencode_config_path()?;
    let model = model.trim();
    if !model.is_empty() {
        if model.len() > 200 || !model.contains('/') || model.chars().any(char::is_control) {
            return Err(AppError::Other(
                "model must be a `provider/model` id, e.g. deepseek/deepseek-v4-pro".into(),
            ));
        }
    }
    let mut config = read_config_for_edit(&config_path)?;
    if model.is_empty() {
        config.remove("model");
    } else {
        config.insert("model".into(), Value::String(model.to_string()));
    }
    write_json_atomic(&config_path, &Value::Object(config))?;
    status_at(&auth_path, &config_path)
}

/// Match OpenCode's `Global.Path.data`: `$XDG_DATA_HOME/opencode`, falling
/// back to `~/.local/share/opencode` on every desktop platform (including
/// Windows).
fn opencode_auth_path() -> AppResult<PathBuf> {
    xdg_path("XDG_DATA_HOME", ".local/share", "data directory")
        .map(|dir| dir.join("opencode").join(AUTH_FILE))
}

/// OpenCode's global config location: `$XDG_CONFIG_HOME/opencode/opencode.json`
/// (`~/.config/opencode/opencode.json` by default).
fn opencode_config_path() -> AppResult<PathBuf> {
    xdg_path("XDG_CONFIG_HOME", ".config", "config directory")
        .map(|dir| dir.join("opencode").join(CONFIG_FILE))
}

fn xdg_path(env: &str, fallback: &str, what: &str) -> AppResult<PathBuf> {
    let explicit = std::env::var_os(env)
        .filter(|v| !v.is_empty())
        .map(PathBuf::from)
        .filter(|p| p.is_absolute())
        .map(Ok)
        .unwrap_or_else(|| {
            dirs::home_dir()
                .map(|home| home.join(fallback))
                .ok_or_else(|| AppError::Other(format!("could not resolve the OpenCode {what}")))
        })?;
    Ok(explicit)
}

fn status_at(auth_path: &Path, config_path: &Path) -> AppResult<OpenCodeAuthStatus> {
    let auth = read_auth(auth_path)?;
    let configured = read_compatible_providers(config_path);
    let default_model = read_default_model(config_path);
    let mut credentials: Vec<OpenCodeCredential> = auth
        .iter()
        .map(|(provider_id, value)| {
            let entry = configured.get(provider_id);
            let auth_type = value
                .get("type")
                .and_then(Value::as_str)
                .unwrap_or("unknown")
                .to_string();
            let key_hint = value.get("key").and_then(Value::as_str).map(mask_key);
            OpenCodeCredential {
                provider_id: provider_id.clone(),
                auth_type,
                key_hint,
                display_name: entry
                    .and_then(|p| p.get("name"))
                    .and_then(Value::as_str)
                    .map(String::from),
                base_url: entry
                    .and_then(|p| p.get("options"))
                    .and_then(|o| o.get("baseURL"))
                    .and_then(Value::as_str)
                    .map(String::from),
            }
        })
        .collect();
    credentials.sort_by(|a, b| a.provider_id.cmp(&b.provider_id));
    Ok(OpenCodeAuthStatus {
        path: auth_path.display().to_string(),
        config_path: Some(config_path.display().to_string()),
        default_model,
        credentials,
    })
}

fn set_api_key_at(path: &Path, provider_id: &str, api_key: &str) -> AppResult<()> {
    let provider_id = validate_provider_id(provider_id)?;
    let api_key = api_key.trim();
    if api_key.is_empty() {
        return Err(AppError::Other("API key cannot be empty".into()));
    }
    if api_key.len() > 16 * 1024 || api_key.contains(['\r', '\n', '\0']) {
        return Err(AppError::Other("API key contains invalid data".into()));
    }

    let mut auth = read_auth(path)?;
    auth.insert(provider_id, json!({ "type": "api", "key": api_key }));
    write_json_atomic(path, &Value::Object(auth))
}

fn set_compatible_provider_at(
    auth_path: &Path,
    config_path: &Path,
    provider_id: &str,
    name: &str,
    base_url: &str,
    api_key: &str,
) -> AppResult<()> {
    let provider_id = validate_provider_id(provider_id)?;
    validate_name(name)?;
    let base_url = validate_base_url(base_url)?;
    // Config first: if it can't be edited (JSONC, permissions), nothing has
    // been written anywhere yet — no orphan key in the auth store.
    upsert_compatible_provider(config_path, &provider_id, name, &base_url)?;
    set_api_key_at(auth_path, &provider_id, api_key)
}

fn remove_credential_at(path: &Path, provider_id: &str) -> AppResult<()> {
    let provider_id = validate_provider_id(provider_id)?;
    let mut auth = read_auth(path)?;
    if auth.remove(&provider_id).is_some() {
        write_json_atomic(path, &Value::Object(auth))?;
    }
    Ok(())
}

/// Merge a minimal OpenAI-compatible provider entry into the global config.
/// The `provider.<id>` object's other keys (`models`, custom headers, …) are
/// preserved; existing `npm`/`name`/`baseURL` are overwritten so the entry
/// stays a working OpenAI-compatible endpoint.
fn upsert_compatible_provider(
    config_path: &Path,
    provider_id: &str,
    name: &str,
    base_url: &str,
) -> AppResult<()> {
    let mut config = read_config_for_edit(config_path)?;

    let providers = config
        .entry("provider".to_string())
        .or_insert_with(|| json!({}));
    let providers_map = providers
        .as_object_mut()
        .ok_or_else(|| AppError::Other("opencode.json `provider` is not an object".into()))?;

    let entry = providers_map
        .entry(provider_id.to_string())
        .or_insert_with(|| json!({}));
    let entry_map = entry.as_object_mut().ok_or_else(|| {
        AppError::Other(format!(
            "opencode.json provider `{provider_id}` is not an object"
        ))
    })?;

    entry_map.insert("npm".to_string(), json!(OPENAI_COMPAT_NPM));
    entry_map.insert("name".to_string(), json!(name));

    let options = entry_map
        .entry("options".to_string())
        .or_insert_with(|| json!({}));
    let options_map = options.as_object_mut().ok_or_else(|| {
        AppError::Other(format!(
            "opencode.json provider `{provider_id}` options is not an object"
        ))
    })?;
    options_map.insert("baseURL".to_string(), json!(base_url));

    write_json_atomic(config_path, &Value::Object(config))
}

fn validate_provider_id(raw: &str) -> AppResult<String> {
    let id = raw.trim();
    let valid = !id.is_empty()
        && id.len() <= 100
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'));
    if !valid {
        return Err(AppError::Other(
            "provider id may only contain letters, numbers, dots, dashes, and underscores".into(),
        ));
    }
    Ok(id.to_string())
}

fn validate_name(raw: &str) -> AppResult<String> {
    let name = raw.trim();
    let valid = !name.is_empty()
        && name.len() <= 80
        && !name.contains(['\r', '\n', '\0'])
        && name.chars().all(|c| !c.is_control());
    if !valid {
        return Err(AppError::Other(
            "display name must be 1–80 printable characters".into(),
        ));
    }
    Ok(name.to_string())
}

/// Minimal http(s) URL check — avoids pulling in a full URL parser for one
/// validation the OpenCode CLI would reject anyway.
fn validate_base_url(raw: &str) -> AppResult<String> {
    let value = raw.trim();
    let rest = value
        .strip_prefix("https://")
        .or_else(|| value.strip_prefix("http://"));
    let Some(host) = rest else {
        return Err(AppError::Other(
            "base URL must start with http:// or https://, e.g. https://api.example.com/v1".into(),
        ));
    };
    if host.is_empty()
        || host.chars().any(char::is_whitespace)
        || value.chars().any(char::is_control)
    {
        return Err(AppError::Other(
            "base URL must be a valid URL, e.g. https://api.example.com/v1".into(),
        ));
    }
    Ok(value.to_string())
}

fn mask_key(key: &str) -> String {
    let tail: String = key
        .chars()
        .rev()
        .take(4)
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .collect();
    format!("••••{tail}")
}

fn read_auth(path: &Path) -> AppResult<Map<String, Value>> {
    match read_json_object(path) {
        Ok(map) => Ok(map),
        Err(AppError::Io(error)) if error.kind() == std::io::ErrorKind::NotFound => Ok(Map::new()),
        Err(other) => Err(other),
    }
}

/// Best-effort read of the `provider` map from the global config for display
/// purposes only. A missing or unparseable file (e.g. JSONC) simply yields no
/// custom-provider decorations.
fn read_compatible_providers(config_path: &Path) -> Map<String, Value> {
    match serde_json::from_slice::<Value>(&std::fs::read(config_path).unwrap_or_default()) {
        Ok(Value::Object(root)) => root
            .get("provider")
            .and_then(Value::as_object)
            .cloned()
            .unwrap_or_default(),
        _ => Map::new(),
    }
}

fn read_default_model(config_path: &Path) -> Option<String> {
    let root: Value =
        serde_json::from_slice(&std::fs::read(config_path).ok()?).ok()?;
    root.get("model")
        .and_then(Value::as_str)
        .map(str::to_string)
        .filter(|model| !model.is_empty())
}

/// Read a config file that we're about to edit. Unlike auth, JSONC configs
/// can't be round-tripped by `serde_json`, and silently rewriting one would
/// destroy the user's comments — so we refuse rather than clobber.
fn read_config_for_edit(path: &Path) -> AppResult<Map<String, Value>> {
    let default_schema: Map<String, Value> = [(
        "$schema".to_string(),
        Value::String("https://opencode.ai/config.json".to_string()),
    )]
    .into_iter()
    .collect();

    if !path.exists() || std::fs::read(path)?.iter().all(u8::is_ascii_whitespace) {
        return Ok(default_schema);
    }
    match serde_json::from_slice::<Value>(&std::fs::read(path)?) {
        Ok(Value::Object(map)) => Ok(map),
        Ok(_) => Err(AppError::Other(format!(
            "opencode global config is not a JSON object: {}",
            path.display()
        ))),
        Err(_) => Err(AppError::Other(format!(
            "opencode global config {} is not strict JSON. If it's a JSONC file (comments allowed), move it to {} — a JSONC file can't be edited safely.",
            path.display(),
            path.with_file_name(format!("{CONFIG_FILE}.min.json")).display()
        ))),
    }
}

fn read_json_object(path: &Path) -> AppResult<Map<String, Value>> {
    if path.exists() {
        let bytes = std::fs::read(path)?;
        if !bytes.iter().all(u8::is_ascii_whitespace) {
            match serde_json::from_slice::<Value>(&bytes)? {
                Value::Object(auth) => return Ok(auth),
                _ => {
                    return Err(AppError::Other(format!(
                        "OpenCode credential file is not a JSON object: {}",
                        path.display()
                    )))
                }
            }
        }
    }
    Err(std::io::Error::new(
        std::io::ErrorKind::NotFound,
        "no OpenCode auth file",
    )
    .into())
}

fn write_json_atomic(path: &Path, value: &Value) -> AppResult<()> {
    let parent = path
        .parent()
        .ok_or_else(|| AppError::Other("path has no parent".into()))?;
    std::fs::create_dir_all(parent)?;

    let tmp = parent.join(format!(
        ".{}.gvibe-{}.tmp",
        path.file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("opencode"),
        nanoid::nanoid!(8)
    ));
    let mut bytes = serde_json::to_vec_pretty(value)?;
    bytes.push(b'\n');
    if let Err(error) = std::fs::write(&tmp, bytes) {
        let _ = std::fs::remove_file(&tmp);
        return Err(error.into());
    }

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if let Err(error) = std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o600)) {
            let _ = std::fs::remove_file(&tmp);
            return Err(error.into());
        }
    }

    if let Err(error) = std::fs::rename(&tmp, path) {
        let _ = std::fs::remove_file(&tmp);
        return Err(error.into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(name: &str) -> PathBuf {
        std::env::temp_dir().join(format!("gvibe-opencode-{name}-{}", nanoid::nanoid!(8)))
    }

    fn cleanup(dir: &Path) {
        let _ = std::fs::remove_dir_all(dir);
    }

    fn auth_path(dir: &Path) -> PathBuf {
        dir.join(AUTH_FILE)
    }

    fn config_path(dir: &Path) -> PathBuf {
        dir.join(CONFIG_FILE)
    }

    #[test]
    fn adds_api_keys_without_disturbing_existing_auth() {
        let dir = scratch("preserve");
        let auth = auth_path(&dir);
        let mut existing = Map::new();
        existing.insert(
            "anthropic".into(),
            json!({ "type": "oauth", "access": "secret", "refresh": "also-secret", "expires": 1 }),
        );
        write_json_atomic(&auth, &Value::Object(existing.clone())).unwrap();

        set_api_key_at(&auth, "openrouter", "test-key-1234").unwrap();
        let saved = read_auth(&auth).unwrap();
        assert_eq!(saved.get("anthropic"), existing.get("anthropic"));
        assert_eq!(saved["openrouter"]["type"], "api");
        assert_eq!(saved["openrouter"]["key"], "test-key-1234");

        let status = status_at(&auth, &config_path(&dir)).unwrap();
        let openrouter = status
            .credentials
            .iter()
            .find(|credential| credential.provider_id == "openrouter")
            .unwrap();
        assert_eq!(openrouter.key_hint.as_deref(), Some("••••1234"));
        cleanup(&dir);
    }

    #[test]
    fn removes_only_the_requested_provider() {
        let dir = scratch("remove");
        let auth = auth_path(&dir);
        set_api_key_at(&auth, "openrouter", "one").unwrap();
        set_api_key_at(&auth, "openai", "two").unwrap();
        remove_credential_at(&auth, "openrouter").unwrap();

        let saved = read_auth(&auth).unwrap();
        assert!(!saved.contains_key("openrouter"));
        assert!(saved.contains_key("openai"));
        cleanup(&dir);
    }

    #[test]
    fn rejects_unsafe_provider_ids_and_keys() {
        let dir = scratch("invalid");
        let auth = auth_path(&dir);
        assert!(set_api_key_at(&auth, "../openrouter", "key").is_err());
        assert!(set_api_key_at(&auth, "openrouter", "line\nbreak").is_err());
        assert!(!auth.exists());
        cleanup(&dir);
    }

    #[test]
    fn writes_compatible_provider_into_global_config() {
        let dir = scratch("compat");
        let auth = auth_path(&dir);
        let config = config_path(&dir);

        let mut root = Map::new();
        root.insert("$schema".to_string(), json!("https://opencode.ai/config.json"));
        root.insert(
            "provider".to_string(),
            json!({
                "anthropic": { "options": { "baseURL": "https://api.anthropic.com/v1" } },
                "myproxy": { "models": { "my-model": {} } },
            }),
        );
        write_json_atomic(&config, &Value::Object(root)).unwrap();

        set_compatible_provider_at(
            &auth,
            &config,
            "myproxy",
            "My Proxy",
            "https://proxy.example.com/v1",
            "sk-secret",
        )
        .unwrap();

        let saved: Value = serde_json::from_slice(&std::fs::read(&config).unwrap()).unwrap();
        assert_eq!(
            saved["provider"]["anthropic"]["options"]["baseURL"],
            "https://api.anthropic.com/v1"
        );
        assert!(saved["provider"]["myproxy"]["models"].is_object());
        assert_eq!(
            saved["provider"]["myproxy"]["npm"],
            "@ai-sdk/openai-compatible"
        );
        assert_eq!(saved["provider"]["myproxy"]["name"], "My Proxy");
        assert_eq!(
            saved["provider"]["myproxy"]["options"]["baseURL"],
            "https://proxy.example.com/v1"
        );

        let key = read_auth(&auth).unwrap();
        assert_eq!(key["myproxy"]["key"], "sk-secret");
        let status = status_at(&auth, &config).unwrap();
        let myproxy = status
            .credentials
            .iter()
            .find(|c| c.provider_id == "myproxy")
            .unwrap();
        assert_eq!(myproxy.display_name.as_deref(), Some("My Proxy"));
        assert_eq!(
            myproxy.base_url.as_deref(),
            Some("https://proxy.example.com/v1")
        );
        cleanup(&dir);
    }

    #[test]
    fn status_reports_the_global_default_model() {
        let dir = scratch("model");
        let auth = auth_path(&dir);
        let config = config_path(&dir);

        let mut config_map = read_config_for_edit(&config).unwrap();
        config_map.insert("model".into(), json!("deepseek/deepseek-v4-pro"));
        write_json_atomic(&config, &Value::Object(config_map)).unwrap();

        let status = status_at(&auth, &config).unwrap();
        assert_eq!(
            status.default_model.as_deref(),
            Some("deepseek/deepseek-v4-pro")
        );
        cleanup(&dir);
    }

    #[test]
    fn validates_base_url_without_a_url_parser() {
        assert_eq!(
            validate_base_url("https://api.example.com/v1").unwrap(),
            "https://api.example.com/v1"
        );
        assert_eq!(
            validate_base_url("http://localhost:8000/v1").unwrap(),
            "http://localhost:8000/v1"
        );
        assert!(validate_base_url("ftp://x").is_err());
        assert!(validate_base_url("api.example.com/v1").is_err());
        assert!(validate_base_url("https://").is_err());
        assert!(validate_base_url("https://a b/v1").is_err());
    }
}
