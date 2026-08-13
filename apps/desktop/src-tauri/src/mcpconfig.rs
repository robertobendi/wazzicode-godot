//! App-managed MCP server wiring + uvibe CLI resolution.
//!
//! Mirrors `apps/cli/src/commands/mcpConfig.ts:buildEntry`: the entry runs the
//! uvibe CLI's `serve` command via Node with `UVIBE_PROJECT` pointing at the
//! Unity project, so a headless agent run gets the `unity-vibe-os` MCP server
//! without touching the game repo's own `.mcp.json`.
//!
//! The two backends consume that entry differently:
//!   - **Claude** reads a JSON file passed as `--mcp-config` (written here, keyed
//!     by a stable hash of the project path so projects don't collide, rewritten
//!     on every send — cheap and self-healing).
//!   - **Codex** has no equivalent flag; it takes `-c` TOML overrides on the
//!     command line (see `agent::codex`), built from the same [`McpEntry`].
//!
//! Both paths therefore describe one server, from one source of truth.

use crate::error::AppResult;
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use tauri::{AppHandle, Manager};

/// The `unity-vibe-os` MCP server as a backend-neutral triple. Rendered to JSON
/// for Claude ([`ensure_mcp_config`]) or to TOML `-c` overrides for Codex.
#[derive(Debug, Clone)]
pub struct McpEntry {
    pub command: String,
    pub args: Vec<String>,
    /// Value for the server's `UVIBE_PROJECT` env var — the Unity project path.
    pub project: String,
}

/// Resolve the uvibe CLI and describe the MCP server entry for `project`.
pub fn mcp_entry(app: &AppHandle, project: &Path) -> McpEntry {
    let (command, mut args) = resolve_uvibe(app);
    args.push("serve".into());
    McpEntry {
        command,
        args,
        project: project.to_string_lossy().into_owned(),
    }
}

/// Write `<config_dir>/mcp/<projectHash>.json` (Claude's `--mcp-config`) and
/// return its path. `config_dir` is the app's config dir (already
/// `.../unity-vibe-studio`). `app` is needed to resolve the bundled sidecar +
/// uvibe.cjs in release builds.
pub fn ensure_mcp_config(app: &AppHandle, config_dir: &Path, project: &Path) -> AppResult<PathBuf> {
    let dir = config_dir.join("mcp");
    std::fs::create_dir_all(&dir)?;
    let file = dir.join(format!("{}.json", project_hash(project)));

    let entry = mcp_entry(app, project);
    let config = serde_json::json!({
        "mcpServers": {
            "unity-vibe-os": {
                "command": entry.command,
                "args": entry.args,
                "env": { "UVIBE_PROJECT": entry.project }
            }
        }
    });
    std::fs::write(&file, serde_json::to_vec_pretty(&config)?)?;
    Ok(file)
}

/// First 16 hex chars of SHA-256 over the project path — short but collision-
/// safe enough to name a per-project file (mcp config, capture image, …).
pub fn project_hash(project: &Path) -> String {
    let mut hasher = Sha256::new();
    hasher.update(project.to_string_lossy().as_bytes());
    let digest = hasher.finalize();
    let mut hex = String::with_capacity(16);
    for b in digest.iter().take(8) {
        hex.push_str(&format!("{b:02x}"));
    }
    hex
}

/// Resolve how to invoke the uvibe CLI, as `(command, prefix_args)` — everything
/// before the subcommand. Callers append the subcommand + its flags (e.g.
/// `"serve"`, or `["init", "--project", …]`).
///
// B6: prefer the bundled sidecar — a Node 20 `externalBin` plus the esbuild-
// bundled `uvibe.cjs` shipped as a Tauri resource, version-locking the MCP
// server to the app release. Fall back to the monorepo CLI (dev builds) via the
// system `node`, then to `uvibe` on PATH.
pub fn resolve_uvibe(app: &AppHandle) -> (String, Vec<String>) {
    if let Some(entry) = bundled_uvibe(app) {
        return entry;
    }
    if let Some(entry) = dev_uvibe_base() {
        return entry;
    }
    log::warn!("uvibe CLI not found (no bundled sidecar, not in monorepo); falling back to `uvibe` on PATH");
    ("uvibe".into(), Vec::new())
}

/// Build a subprocess for a previously resolved uvibe command/prefix.
///
/// Resolution stays on the Tauri thread because it may use app resources;
/// callers can then move the returned command into a blocking worker. Absolute
/// bundled/dev commands and the PATH fallback receive the same augmented PATH
/// and non-interactive stdin behavior as the rest of Studio's subprocesses.
pub fn resolved_uvibe_command(
    command: &str,
    prefix: &[String],
    args: &[String],
) -> AppResult<Command> {
    let mut cmd = if command.contains('/') || command.contains('\\') {
        let mut cmd = Command::new(command);
        cmd.env("PATH", crate::proc::search_path());
        cmd.stdin(Stdio::null());
        crate::proc::no_window(&mut cmd);
        cmd
    } else {
        crate::proc::command(command)?
    };
    cmd.args(prefix).args(args);
    Ok(cmd)
}

/// Source folder of the `UnityVibeOS` UPM package to install into a project:
/// the bundled Tauri resource in release, or the monorepo `unity/UnityVibeOS`
/// in dev. `None` if neither is present.
pub fn unity_package_source(app: &AppHandle) -> Option<PathBuf> {
    if let Ok(res) = app.path().resource_dir() {
        let bundled = res.join("resources").join("UnityVibeOS");
        if bundled.join("package.json").is_file() {
            return Some(bundled);
        }
    }
    dev_repo_path(&["unity", "UnityVibeOS"]).filter(|p| p.join("package.json").is_file())
}

/// True when both bundled pieces (sidecar node + uvibe.cjs) are present — i.e.
/// this is a packaged build, not `tauri dev`. Surfaced in onboarding status.
pub fn has_bundled_sidecar(app: &AppHandle) -> bool {
    bundled_uvibe(app).is_some()
}

/// Release resolution: the `node` sidecar (bundled next to the app binary by
/// Tauri's `externalBin`, target-triple suffix stripped) + `resources/uvibe.cjs`.
/// Both must exist or we return `None` so callers fall through to dev/PATH.
fn bundled_uvibe(app: &AppHandle) -> Option<(String, Vec<String>)> {
    let exe = std::env::current_exe().ok()?;
    let bin_dir = exe.parent()?;
    let node = bin_dir.join(if cfg!(windows) { "node.exe" } else { "node" });

    let res = app.path().resource_dir().ok()?;
    let cjs = res.join("resources").join("uvibe.cjs");

    if node.is_file() && cjs.is_file() {
        return Some((
            node.to_string_lossy().into_owned(),
            vec![cjs.to_string_lossy().into_owned()],
        ));
    }
    None
}

/// Dev resolution: the monorepo CLI (`apps/cli/bin/uvibe`) run via the system
/// `node`. Returns `(node, [uvibe])`. Tries walking up from the running exe
/// (covers `tauri dev`, binary under `target/`), then the compile-time manifest
/// dir.
fn dev_uvibe_base() -> Option<(String, Vec<String>)> {
    let node = crate::proc::resolve("node")?.to_string_lossy().into_owned();
    let uvibe = dev_repo_path(&["apps", "cli", "bin", "uvibe"]).filter(|p| p.is_file())?;
    Some((node, vec![uvibe.to_string_lossy().into_owned()]))
}

/// Locate a path under the monorepo root for dev builds. Walks up from the
/// running exe first, then falls back to the compile-time manifest dir
/// (`apps/desktop/src-tauri` → repo root).
fn dev_repo_path(rel: &[&str]) -> Option<PathBuf> {
    let join_rel = |base: &Path| {
        let mut p = base.to_path_buf();
        for seg in rel {
            p.push(seg);
        }
        p
    };

    // 1. Walk up from the current exe, testing `<dir>/<rel>` at each level.
    if let Ok(exe) = std::env::current_exe() {
        let mut dir = exe.parent().map(Path::to_path_buf);
        while let Some(d) = dir {
            let candidate = join_rel(&d);
            if candidate.exists() {
                return Some(candidate);
            }
            dir = d.parent().map(Path::to_path_buf);
        }
    }

    // 2. Compile-time manifest dir: apps/desktop/src-tauri → ../../.. = repo root.
    let root = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("..")
        .join("..");
    let candidate = join_rel(&root);
    if candidate.exists() {
        return Some(candidate);
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hash_is_stable_and_short() {
        let a = project_hash(Path::new("/Users/x/Game"));
        let b = project_hash(Path::new("/Users/x/Game"));
        let c = project_hash(Path::new("/Users/x/Other"));
        assert_eq!(a, b);
        assert_ne!(a, c);
        assert_eq!(a.len(), 16);
    }

    #[test]
    fn dev_repo_path_finds_monorepo_cli() {
        // The manifest-dir fallback should locate the CLI shim in this checkout.
        let uvibe = dev_repo_path(&["apps", "cli", "bin", "uvibe"]);
        assert!(
            uvibe.is_some(),
            "expected to find apps/cli/bin/uvibe in the monorepo"
        );
        assert!(uvibe.unwrap().is_file());
    }
}
