//! Resource funnel — stage dropped / pasted files into the project inbox.
//!
//! Drag-and-drop and clipboard paste bring in real OS file paths (or raw image
//! bytes). We copy them into `<project>/.unity-vibe/inbox/<ts>-<name>` so the
//! agent has a stable, in-project path to `Read` or `unity_import_asset`, and
//! so the file survives even if the user later moves/deletes the original.
//!
//! `kind` classification lives here (single source of truth); the frontend
//! mirrors only `kind → instruction` in `promptAssembly.ts`, never the ext list.

use crate::error::{AppError, AppResult};
use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};

/// Per-file cap. Unity assets (models/audio/PSDs) can be large; 200 MB is a
/// generous ceiling that still guards against a stray multi-GB file.
const MAX_BYTES: u64 = 200 * 1024 * 1024;

/// A file staged into the project inbox, ready to attach to a chat message.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StagedResource {
    pub id: String,
    /// image / model / audio / text / other — see `classify_kind`.
    pub kind: String,
    /// The file's original (pre-staging) name, for the chip label.
    pub original_name: String,
    /// Absolute path of the copy under `.unity-vibe/inbox/`.
    pub staged_path: String,
    pub byte_size: u64,
}

/// Copy each path into the project inbox and return the staged descriptors.
/// Paths already inside the inbox are returned as-is (no re-copy). Fails with a
/// clear message on a missing file or one over the size cap.
#[tauri::command]
pub async fn stage_paths(project: String, paths: Vec<String>) -> AppResult<Vec<StagedResource>> {
    tokio::task::spawn_blocking(move || stage_paths_blocking(&project, &paths))
        .await
        .map_err(|e| AppError::Other(format!("stage task failed: {e}")))?
}

/// Read the OS clipboard (file list first, then a raw image) and stage anything
/// found into the inbox. Returns an empty vec for a text-only / empty clipboard.
#[tauri::command]
pub async fn paste_clipboard(project: String) -> AppResult<Vec<StagedResource>> {
    tokio::task::spawn_blocking(move || paste_clipboard_blocking(&project))
        .await
        .map_err(|e| AppError::Other(format!("paste task failed: {e}")))?
}

/// Delete a staged file. Refuses any path not inside some project's
/// `.unity-vibe/inbox/` (canonicalize + component check), so a bad path can
/// never remove an arbitrary file. A path that no longer exists is a no-op.
#[tauri::command]
pub async fn remove_staged(path: String) -> AppResult<()> {
    tokio::task::spawn_blocking(move || remove_staged_blocking(Path::new(&path)))
        .await
        .map_err(|e| AppError::Other(format!("remove task failed: {e}")))?
}

// --- blocking cores (unit-testable, no Tauri types) -----------------------

fn stage_paths_blocking(project: &str, paths: &[String]) -> AppResult<Vec<StagedResource>> {
    let inbox = inbox_dir(Path::new(project));
    fs::create_dir_all(&inbox)?;
    let canon_inbox = crate::pathutil::canonicalize(&inbox).ok();
    let ts = timestamp();

    let mut out = Vec::with_capacity(paths.len());
    for p in paths {
        out.push(stage_one(
            &inbox,
            canon_inbox.as_deref(),
            Path::new(p),
            &ts,
        )?);
    }
    Ok(out)
}

fn paste_clipboard_blocking(project: &str) -> AppResult<Vec<StagedResource>> {
    let inbox = inbox_dir(Path::new(project));

    // 1. Files copied in the OS file manager — real, readable paths.
    if let Ok(paths) = clipboard_files::read() {
        let files: Vec<PathBuf> = paths
            .into_iter()
            .filter(|p| !p.as_os_str().is_empty())
            .collect();
        if !files.is_empty() {
            fs::create_dir_all(&inbox)?;
            let canon_inbox = crate::pathutil::canonicalize(&inbox).ok();
            let ts = timestamp();
            let mut out = Vec::with_capacity(files.len());
            for p in files {
                out.push(stage_one(&inbox, canon_inbox.as_deref(), &p, &ts)?);
            }
            return Ok(out);
        }
    }

    // 2. Raw image bytes (a screenshot / copied image) — encode to a PNG on disk.
    if let Ok(mut cb) = arboard::Clipboard::new() {
        if let Ok(img) = cb.get_image() {
            let bytes = encode_png(img.width, img.height, &img.bytes)?;
            fs::create_dir_all(&inbox)?;
            let ts = timestamp();
            let target = unique_target(&inbox, &format!("{ts}-pasted.png"));
            fs::write(&target, &bytes)?;
            return Ok(vec![StagedResource {
                id: nanoid::nanoid!(),
                kind: "image".to_string(),
                original_name: "pasted.png".to_string(),
                staged_path: crate::pathutil::simplified(&target)
                    .to_string_lossy()
                    .into_owned(),
                byte_size: bytes.len() as u64,
            }]);
        }
    }

    // 3. Text-only / empty clipboard — nothing to stage.
    Ok(Vec::new())
}

fn remove_staged_blocking(path: &Path) -> AppResult<()> {
    // Resolve to a real path so `..` / symlinks can't smuggle us out of the
    // inbox. If it's already gone, there's nothing to remove.
    let canon = match crate::pathutil::canonicalize(path) {
        Ok(c) => c,
        Err(_) => return Ok(()),
    };
    if !is_inside_inbox(&canon) {
        return Err(AppError::Other(format!(
            "refusing to delete a path outside an inbox: {}",
            canon.display()
        )));
    }
    fs::remove_file(&canon)?;
    Ok(())
}

// --- helpers ---------------------------------------------------------------

fn inbox_dir(project: &Path) -> PathBuf {
    project.join(".unity-vibe").join("inbox")
}

/// Copy one source file into the inbox (or return it as-is if already inside).
fn stage_one(
    inbox: &Path,
    canon_inbox: Option<&Path>,
    src: &Path,
    ts: &str,
) -> AppResult<StagedResource> {
    let meta = fs::metadata(src)
        .map_err(|e| AppError::Other(format!("can't read \"{}\": {e}", src.display())))?;
    if meta.len() > MAX_BYTES {
        return Err(AppError::Other(format!(
            "\"{}\" is {} — over the {} MB limit",
            src.display(),
            human_size(meta.len()),
            MAX_BYTES / (1024 * 1024)
        )));
    }

    let original_name = src
        .file_name()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| "file".to_string());
    let kind = classify_kind(&ext_of(src)).to_string();

    // Already staged inside this project's inbox — reference it, don't re-copy.
    if let Some(ci) = canon_inbox {
        if let Ok(canon_src) = crate::pathutil::canonicalize(src) {
            if canon_src.starts_with(ci) {
                return Ok(StagedResource {
                    id: nanoid::nanoid!(),
                    kind,
                    original_name,
                    staged_path: crate::pathutil::simplified(&canon_src)
                        .to_string_lossy()
                        .into_owned(),
                    byte_size: meta.len(),
                });
            }
        }
    }

    let target = unique_target(inbox, &format!("{ts}-{}", sanitize_name(&original_name)));
    fs::copy(src, &target)?;

    Ok(StagedResource {
        id: nanoid::nanoid!(),
        kind,
        original_name,
        staged_path: crate::pathutil::simplified(&target)
            .to_string_lossy()
            .into_owned(),
        byte_size: meta.len(),
    })
}

/// Extension classifier — the single source of truth for resource kinds.
fn classify_kind(ext: &str) -> &'static str {
    match ext {
        // PSD counts as an image — Unity imports it as a sprite/texture.
        "png" | "jpg" | "jpeg" | "gif" | "webp" | "bmp" | "psd" => "image",
        "fbx" | "obj" | "glb" | "gltf" | "blend" | "dae" => "model",
        "wav" | "mp3" | "ogg" | "aiff" => "audio",
        "txt" | "md" | "json" | "csv" | "cs" | "shader" => "text",
        _ => "other",
    }
}

/// Lowercased extension (no dot), or "" when there isn't one.
fn ext_of(path: &Path) -> String {
    path.extension()
        .map(|e| e.to_string_lossy().to_ascii_lowercase())
        .unwrap_or_default()
}

/// True if `.unity-vibe` then `inbox` appear as consecutive path components.
fn is_inside_inbox(path: &Path) -> bool {
    let comps: Vec<String> = path
        .components()
        .map(|c| c.as_os_str().to_string_lossy().into_owned())
        .collect();
    comps
        .windows(2)
        .any(|w| w[0] == ".unity-vibe" && w[1] == "inbox")
}

/// Pick a non-colliding path in `dir`: `<filename>`, then `<stem>-2.<ext>`, …
fn unique_target(dir: &Path, filename: &str) -> PathBuf {
    let first = dir.join(filename);
    if !first.exists() {
        return first;
    }
    let (stem, ext) = split_ext(filename);
    let mut n = 2u32;
    loop {
        let name = if ext.is_empty() {
            format!("{stem}-{n}")
        } else {
            format!("{stem}-{n}.{ext}")
        };
        let candidate = dir.join(name);
        if !candidate.exists() {
            return candidate;
        }
        n += 1;
    }
}

/// Split a filename into (stem, ext) on the last dot (ignoring a leading dot).
fn split_ext(filename: &str) -> (String, String) {
    match filename.rfind('.') {
        Some(i) if i > 0 => (filename[..i].to_string(), filename[i + 1..].to_string()),
        _ => (filename.to_string(), String::new()),
    }
}

/// Reduce an arbitrary original name to a safe single filename, preserving its
/// extension. Keeps alnum / dot / dash / underscore; everything else → `_`.
fn sanitize_name(raw: &str) -> String {
    let base = raw.rsplit(['/', '\\']).next().unwrap_or(raw).trim();
    let cleaned: String = base
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_') {
                c
            } else {
                '_'
            }
        })
        .collect();
    let cleaned = cleaned.trim_matches('_').to_string();
    if cleaned.is_empty() {
        "file".to_string()
    } else {
        cleaned
    }
}

/// `yyyymmdd-hhmmss` in local time — human-readable and sortable.
fn timestamp() -> String {
    chrono::Local::now().format("%Y%m%d-%H%M%S").to_string()
}

fn human_size(bytes: u64) -> String {
    let mb = bytes as f64 / (1024.0 * 1024.0);
    if mb >= 1.0 {
        format!("{mb:.0} MB")
    } else {
        format!("{} KB", bytes / 1024)
    }
}

/// Encode a raw RGBA buffer (arboard's clipboard image) into a PNG byte stream.
fn encode_png(width: usize, height: usize, rgba: &[u8]) -> AppResult<Vec<u8>> {
    let mut out = Vec::new();
    {
        let mut encoder = png::Encoder::new(&mut out, width as u32, height as u32);
        encoder.set_color(png::ColorType::Rgba);
        encoder.set_depth(png::BitDepth::Eight);
        let mut writer = encoder
            .write_header()
            .map_err(|e| AppError::Other(format!("png header: {e}")))?;
        writer
            .write_image_data(rgba)
            .map_err(|e| AppError::Other(format!("png data: {e}")))?;
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn classify_kind_covers_every_bucket() {
        assert_eq!(classify_kind("png"), "image");
        assert_eq!(classify_kind("psd"), "image"); // Unity imports PSDs
        assert_eq!(classify_kind("fbx"), "model");
        assert_eq!(classify_kind("glb"), "model");
        assert_eq!(classify_kind("wav"), "audio");
        assert_eq!(classify_kind("ogg"), "audio");
        assert_eq!(classify_kind("cs"), "text");
        assert_eq!(classify_kind("json"), "text");
        assert_eq!(classify_kind("exe"), "other");
        assert_eq!(classify_kind(""), "other");
    }

    #[test]
    fn ext_is_lowercased() {
        assert_eq!(ext_of(Path::new("/a/B.PNG")), "png");
        assert_eq!(ext_of(Path::new("/a/model.FBX")), "fbx");
        assert_eq!(ext_of(Path::new("/a/noext")), "");
    }

    #[test]
    fn split_ext_handles_dotfiles() {
        assert_eq!(split_ext("a.png"), ("a".into(), "png".into()));
        assert_eq!(split_ext("a.b.png"), ("a.b".into(), "png".into()));
        assert_eq!(split_ext("noext"), ("noext".into(), "".into()));
        assert_eq!(split_ext(".gitignore"), (".gitignore".into(), "".into()));
    }

    #[test]
    fn is_inside_inbox_requires_consecutive_components() {
        assert!(is_inside_inbox(Path::new("/p/.unity-vibe/inbox/a.png")));
        assert!(is_inside_inbox(Path::new(
            "/x/y/.unity-vibe/inbox/sub/deep.fbx"
        )));
        assert!(!is_inside_inbox(Path::new("/p/.unity-vibe/config.json")));
        assert!(!is_inside_inbox(Path::new("/p/inbox/a.png")));
        assert!(!is_inside_inbox(Path::new("/etc/passwd")));
    }

    #[test]
    fn remove_staged_deletes_inside_inbox_and_refuses_outside() {
        let tmp = std::env::temp_dir().join(format!("uvibe-test-{}", nanoid::nanoid!(8)));
        let inbox = tmp.join(".unity-vibe").join("inbox");
        fs::create_dir_all(&inbox).unwrap();

        // Inside the inbox: removed.
        let inside = inbox.join("staged.png");
        fs::write(&inside, b"x").unwrap();
        remove_staged_blocking(&inside).unwrap();
        assert!(!inside.exists());

        // Outside the inbox: refused, and the file survives.
        let outside = tmp.join("keepme.txt");
        fs::write(&outside, b"important").unwrap();
        assert!(remove_staged_blocking(&outside).is_err());
        assert!(outside.exists());

        // Missing path: no-op, not an error.
        remove_staged_blocking(&inbox.join("gone.png")).unwrap();

        fs::remove_dir_all(&tmp).ok();
    }

    #[test]
    fn stage_paths_copies_classifies_and_handles_collisions() {
        let tmp = std::env::temp_dir().join(format!("uvibe-stage-{}", nanoid::nanoid!(8)));
        let src_dir = tmp.join("src");
        let project = tmp.join("Game");
        fs::create_dir_all(&src_dir).unwrap();

        let a = src_dir.join("Hero.fbx");
        let b = src_dir.join("shot.png");
        fs::write(&a, b"model-bytes").unwrap();
        fs::write(&b, b"image-bytes").unwrap();

        let staged = stage_paths_blocking(
            project.to_str().unwrap(),
            &[
                a.to_string_lossy().into_owned(),
                b.to_string_lossy().into_owned(),
            ],
        )
        .unwrap();
        assert_eq!(staged.len(), 2);
        assert_eq!(staged[0].kind, "model");
        assert_eq!(staged[1].kind, "image");
        assert_eq!(staged[0].original_name, "Hero.fbx");
        for r in &staged {
            assert!(Path::new(&r.staged_path).exists());
            assert!(is_inside_inbox(Path::new(&r.staged_path)));
        }

        // A file already inside the inbox is referenced, not re-copied — both
        // descriptors resolve to the same file (compare canonically, since on
        // macOS /var is a symlink to /private/var).
        let existing = &staged[1].staged_path;
        let before = fs::read_dir(inbox_dir(&project)).unwrap().count();
        let again = stage_paths_blocking(project.to_str().unwrap(), std::slice::from_ref(existing))
            .unwrap();
        let after = fs::read_dir(inbox_dir(&project)).unwrap().count();
        assert_eq!(before, after, "re-staging must not create a new copy");
        assert_eq!(
            crate::pathutil::canonicalize(Path::new(&again[0].staged_path)).unwrap(),
            crate::pathutil::canonicalize(Path::new(existing)).unwrap(),
        );

        fs::remove_dir_all(&tmp).ok();
    }
}
