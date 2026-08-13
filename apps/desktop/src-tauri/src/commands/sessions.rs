//! Session history — persist and resume past chats.
//!
//! After each completed turn (and on chat reset / project switch) the webview
//! serializes its conversation and calls [`save_session`], which writes it to
//! `<project>/.unity-vibe/studio/sessions/<sessionId>.json`. The left rail lists
//! them via [`list_sessions`] (a cheap header-only index), opens one with
//! [`load_session`], and removes one with [`delete_session`].
//!
//! The full payload shape is owned by the frontend (it round-trips its own
//! `ChatMessage[]`), so save/load pass a `serde_json::Value` through verbatim;
//! Rust only validates the `sessionId` (used as the filename) and pulls the
//! lightweight fields for the index. Every path is guarded to stay inside the
//! project's own sessions dir.

use crate::error::{AppError, AppResult};
use serde::Serialize;
use std::path::{Path, PathBuf};

/// One row in the session rail — everything shown without loading the full chat.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionIndexEntry {
    pub session_id: String,
    pub title: String,
    /// Unix milliseconds of the last update, for newest-first sorting.
    pub updated_at: i64,
    pub total_cost_usd: f64,
    pub message_count: usize,
}

/// Save (atomically overwrite) a session's full payload.
#[tauri::command]
pub async fn save_session(project: String, payload: serde_json::Value) -> AppResult<()> {
    tokio::task::spawn_blocking(move || save_session_blocking(&project, &payload))
        .await
        .map_err(|e| AppError::Other(format!("save task failed: {e}")))?
}

/// List saved sessions, newest-first. Header-only: reads each file but returns
/// just the index fields.
#[tauri::command]
pub async fn list_sessions(project: String) -> AppResult<Vec<SessionIndexEntry>> {
    tokio::task::spawn_blocking(move || list_sessions_blocking(&project))
        .await
        .map_err(|e| AppError::Other(format!("list task failed: {e}")))?
}

/// Load one session's full payload.
#[tauri::command]
pub async fn load_session(project: String, session_id: String) -> AppResult<serde_json::Value> {
    tokio::task::spawn_blocking(move || load_session_blocking(&project, &session_id))
        .await
        .map_err(|e| AppError::Other(format!("load task failed: {e}")))?
}

/// Delete one session file. A missing file is a no-op.
#[tauri::command]
pub async fn delete_session(project: String, session_id: String) -> AppResult<()> {
    tokio::task::spawn_blocking(move || delete_session_blocking(&project, &session_id))
        .await
        .map_err(|e| AppError::Other(format!("delete task failed: {e}")))?
}

// --- blocking cores (unit-testable, no Tauri types) -----------------------

fn save_session_blocking(project: &str, payload: &serde_json::Value) -> AppResult<()> {
    let session_id = payload
        .get("sessionId")
        .and_then(|v| v.as_str())
        .ok_or_else(|| AppError::Other("session payload is missing a sessionId".into()))?;
    let dir = sessions_dir(Path::new(project));
    let path = session_file(&dir, session_id)?;
    std::fs::create_dir_all(&dir)?;

    // Atomic write: temp file + rename, so a crash mid-write can't corrupt a
    // saved conversation.
    let tmp = path.with_extension("json.tmp");
    let bytes = serde_json::to_vec_pretty(payload)?;
    std::fs::write(&tmp, bytes)?;
    std::fs::rename(&tmp, &path)?;
    Ok(())
}

fn list_sessions_blocking(project: &str) -> AppResult<Vec<SessionIndexEntry>> {
    let dir = sessions_dir(Path::new(project));
    let entries = match std::fs::read_dir(&dir) {
        Ok(e) => e,
        // No sessions yet (dir absent) → empty list, not an error.
        Err(_) => return Ok(Vec::new()),
    };

    let mut out: Vec<SessionIndexEntry> = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("json") {
            continue;
        }
        let Ok(bytes) = std::fs::read(&path) else {
            continue;
        };
        let Ok(value) = serde_json::from_slice::<serde_json::Value>(&bytes) else {
            // Skip a corrupt file rather than fail the whole listing.
            log::warn!("skipping unreadable session file: {}", path.display());
            continue;
        };
        if let Some(index) = index_from_value(&value) {
            out.push(index);
        }
    }
    // Newest-first.
    out.sort_by_key(|item| std::cmp::Reverse(item.updated_at));
    Ok(out)
}

fn load_session_blocking(project: &str, session_id: &str) -> AppResult<serde_json::Value> {
    let dir = sessions_dir(Path::new(project));
    let path = session_file(&dir, session_id)?;
    let bytes = std::fs::read(&path)
        .map_err(|_| AppError::Other("That conversation could not be found.".into()))?;
    let value = serde_json::from_slice::<serde_json::Value>(&bytes)?;
    Ok(value)
}

fn delete_session_blocking(project: &str, session_id: &str) -> AppResult<()> {
    let dir = sessions_dir(Path::new(project));
    let path = session_file(&dir, session_id)?;
    match std::fs::remove_file(&path) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e.into()),
    }
}

// --- helpers ---------------------------------------------------------------

fn sessions_dir(project: &Path) -> PathBuf {
    project.join(".unity-vibe").join("studio").join("sessions")
}

/// Build the on-disk path for `session_id`, refusing any id that isn't a plain
/// slug (letters, digits, `-`, `_`). This keeps `..` / path separators from
/// escaping the sessions dir — the ids we write are UUIDs / nanoids, so a
/// well-behaved client always passes this.
fn session_file(dir: &Path, session_id: &str) -> AppResult<PathBuf> {
    if !is_safe_session_id(session_id) {
        return Err(AppError::InvalidPath(format!(
            "unsafe session id: {session_id:?}"
        )));
    }
    Ok(dir.join(format!("{session_id}.json")))
}

/// A session id is safe when it's non-empty and every char is ASCII
/// alphanumeric, `-`, or `_` (covers UUIDs and nanoids). No dots, slashes, or
/// separators — so it can't traverse out of the sessions dir.
fn is_safe_session_id(id: &str) -> bool {
    !id.is_empty()
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_'))
}

/// Pull the lightweight index fields off a full session payload. `None` when the
/// payload has no usable `sessionId`.
fn index_from_value(value: &serde_json::Value) -> Option<SessionIndexEntry> {
    let session_id = value.get("sessionId")?.as_str()?.to_string();
    let title = value
        .get("title")
        .and_then(|v| v.as_str())
        .unwrap_or("Untitled")
        .to_string();
    let updated_at = value.get("updatedAt").and_then(|v| v.as_i64()).unwrap_or(0);
    let total_cost_usd = value
        .get("totalCostUsd")
        .and_then(|v| v.as_f64())
        .unwrap_or(0.0);
    let message_count = value
        .get("messages")
        .and_then(|v| v.as_array())
        .map(|a| a.len())
        .unwrap_or(0);
    Some(SessionIndexEntry {
        session_id,
        title,
        updated_at,
        total_cost_usd,
        message_count,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn tmp_project() -> PathBuf {
        let d = std::env::temp_dir().join(format!("uvibe-sess-{}", nanoid::nanoid!(8)));
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn safe_session_id_accepts_uuids_rejects_traversal() {
        assert!(is_safe_session_id("3f9a-1b2c-4d5e"));
        assert!(is_safe_session_id("abc_DEF123"));
        assert!(!is_safe_session_id(""));
        assert!(!is_safe_session_id("../secret"));
        assert!(!is_safe_session_id("a/b"));
        assert!(!is_safe_session_id("a.b"));
        assert!(!is_safe_session_id("..\\win"));
    }

    #[test]
    fn session_file_rejects_unsafe_id() {
        let dir = tmp_project();
        assert!(session_file(&dir, "good-id").is_ok());
        assert!(session_file(&dir, "../../etc/passwd").is_err());
    }

    #[test]
    fn save_list_load_delete_round_trip() {
        let project = tmp_project();
        let proj = project.to_str().unwrap();

        let payload = json!({
            "sessionId": "sess-abc-123",
            "title": "Make the coins spin",
            "createdAt": 1000_i64,
            "updatedAt": 2000_i64,
            "totalCostUsd": 0.0123,
            "messages": [
                {"id": "m1", "role": "user", "text": "hi"},
                {"id": "m2", "role": "assistant", "text": "done"}
            ]
        });

        save_session_blocking(proj, &payload).unwrap();

        // Index is header-only but correct.
        let index = list_sessions_blocking(proj).unwrap();
        assert_eq!(index.len(), 1);
        assert_eq!(index[0].session_id, "sess-abc-123");
        assert_eq!(index[0].title, "Make the coins spin");
        assert_eq!(index[0].updated_at, 2000);
        assert_eq!(index[0].message_count, 2);
        assert!((index[0].total_cost_usd - 0.0123).abs() < 1e-9);

        // Full load returns the messages verbatim.
        let loaded = load_session_blocking(proj, "sess-abc-123").unwrap();
        assert_eq!(loaded["messages"].as_array().unwrap().len(), 2);

        // Delete removes it; a second delete is a no-op.
        delete_session_blocking(proj, "sess-abc-123").unwrap();
        assert!(list_sessions_blocking(proj).unwrap().is_empty());
        delete_session_blocking(proj, "sess-abc-123").unwrap();

        std::fs::remove_dir_all(&project).ok();
    }

    #[test]
    fn list_sorts_newest_first_and_skips_corrupt() {
        let project = tmp_project();
        let proj = project.to_str().unwrap();

        for (id, updated) in [("old", 100_i64), ("new", 900_i64), ("mid", 500_i64)] {
            let payload =
                json!({ "sessionId": id, "title": id, "updatedAt": updated, "messages": [] });
            save_session_blocking(proj, &payload).unwrap();
        }
        // A corrupt file must not break the listing.
        std::fs::write(sessions_dir(&project).join("broken.json"), b"{not json").unwrap();

        let index = list_sessions_blocking(proj).unwrap();
        let ids: Vec<&str> = index.iter().map(|e| e.session_id.as_str()).collect();
        assert_eq!(ids, vec!["new", "mid", "old"]);

        std::fs::remove_dir_all(&project).ok();
    }

    #[test]
    fn list_missing_dir_is_empty() {
        let project = tmp_project();
        assert!(list_sessions_blocking(project.to_str().unwrap())
            .unwrap()
            .is_empty());
        std::fs::remove_dir_all(&project).ok();
    }
}
