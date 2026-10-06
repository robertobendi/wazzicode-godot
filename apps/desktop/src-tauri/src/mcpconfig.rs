//! App-managed Godot MCP server wiring and `gvibe` CLI resolution.
//!
//! Mirrors `apps/cli/src/commands/mcpConfig.ts:buildEntry`: the entry runs the
//! CLI's `serve` command via Node with `GVIBE_PROJECT` pointing at the
//! Godot project, so a headless agent run gets the `godot-vibe-os` MCP server
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

/// The `godot-vibe-os` MCP server as a backend-neutral triple. Rendered to JSON
/// for Claude ([`ensure_mcp_config`]) or to TOML `-c` overrides for Codex.
#[derive(Debug, Clone)]
pub struct McpEntry {
    pub command: String,
    pub args: Vec<String>,
    /// Value for the server's `GVIBE_PROJECT` environment variable.
    pub project: String,
    /// Optional companion servers registered alongside the primary one (Pyrite).
    pub companions: Vec<CompanionServer>,
}

/// A companion MCP server registered next to `godot-vibe-os` — currently Pyrite,
/// the AI block modeler whose generated GLB assets the agent then imports into
/// the project. Optional: when it isn't installed, runs are unchanged.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CompanionServer {
    /// Server key in the Claude/OpenCode JSON; also a bare TOML key for Codex,
    /// so it must stay `[a-z_]`.
    pub name: String,
    pub command: String,
    pub args: Vec<String>,
}

/// The user's Pyrite choices from Settings, mirrored here so every place that
/// renders the MCP config (chat, auto mode, onboarding, Ask) sees the same
/// answer without threading `Settings` through each call. Updated whenever
/// settings load or save.
#[derive(Debug, Clone, Default)]
struct PyritePrefs {
    disabled: bool,
    linked: Option<PathBuf>,
}

static PYRITE_PREFS: std::sync::RwLock<PyritePrefs> = std::sync::RwLock::new(PyritePrefs {
    disabled: false,
    linked: None,
});

/// Adopt the Pyrite part of `settings` for subsequent runs.
pub fn set_pyrite_prefs(settings: &crate::store::settings::Settings) {
    let prefs = PyritePrefs {
        disabled: !settings.pyrite_enabled,
        linked: settings
            .pyrite_path
            .as_deref()
            .map(str::trim)
            .filter(|p| !p.is_empty())
            .map(PathBuf::from),
    };
    if let Ok(mut slot) = PYRITE_PREFS.write() {
        *slot = prefs;
    }
}

/// Where a Pyrite launcher was found, for the Settings card.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "lowercase")]
pub enum PyriteSource {
    /// Linked by hand in Settings.
    Linked,
    /// `PYRITE_MCP` in the environment.
    Env,
    /// Pyrite's own `mcp-entry.json`, rewritten by every `pyrite` command.
    Discovered,
}

/// A located Pyrite install: how to start its MCP server, and where from.
#[derive(Debug, Clone)]
pub struct PyriteInstall {
    pub server: CompanionServer,
    pub source: PyriteSource,
    /// The `pyrite.mjs` bundle the server runs.
    pub script: PathBuf,
    pub version: Option<String>,
}

/// `<PYRITE_HOME | ~/Pyrite>`: Pyrite's workspace and discovery directory.
pub fn pyrite_home() -> Option<PathBuf> {
    std::env::var_os("PYRITE_HOME")
        .map(PathBuf::from)
        .or_else(|| dirs::home_dir().map(|h| h.join("Pyrite")))
}

/// The companion server agent runs get, or `None` when Pyrite is switched off
/// in Settings or isn't installed (runs are then exactly as before).
pub fn pyrite_server() -> Option<CompanionServer> {
    let prefs = PYRITE_PREFS.read().map(|p| p.clone()).unwrap_or_default();
    if prefs.disabled {
        return None;
    }
    locate_pyrite(prefs.linked.as_deref()).ok().map(|i| i.server)
}

/// Locate Pyrite, most explicit first: a path linked in Settings, then
/// `PYRITE_MCP` (a path to `pyrite.mjs`), then Pyrite's discovery file. A
/// linked path that no longer resolves is an error rather than a silent
/// fallback, so the Settings card can say what is wrong with it.
pub fn locate_pyrite(linked: Option<&Path>) -> Result<PyriteInstall, String> {
    if let Some(path) = linked {
        let script = pyrite_script(path).ok_or_else(|| {
            format!(
                "No Pyrite build at {}. Pick the Pyrite folder (after `pnpm build`) or its dist/pyrite.mjs.",
                path.display()
            )
        })?;
        return node_launcher(script, PyriteSource::Linked);
    }
    if let Some(script) = std::env::var_os("PYRITE_MCP")
        .map(PathBuf::from)
        .filter(|p| p.is_file())
    {
        return node_launcher(script, PyriteSource::Env);
    }
    let file = pyrite_home()
        .ok_or("No home directory to look for Pyrite in.")?
        .join("mcp-entry.json");
    let text = std::fs::read_to_string(&file).map_err(|_| {
        "Run any `pyrite` command once so it registers itself, or link its folder.".to_string()
    })?;
    parse_pyrite_discovery(&text).ok_or_else(|| {
        "Pyrite's registration points at a build that no longer exists. Run `pyrite doctor` once, or link it here.".into()
    })
}

/// Accept the bundle itself or a checkout containing `dist/pyrite.mjs`.
fn pyrite_script(path: &Path) -> Option<PathBuf> {
    if path.is_file() {
        return Some(path.to_path_buf());
    }
    let bundled = path.join("dist").join("pyrite.mjs");
    bundled.is_file().then_some(bundled)
}

fn node_launcher(script: PathBuf, source: PyriteSource) -> Result<PyriteInstall, String> {
    let node = crate::proc::resolve("node")
        .ok_or("Pyrite needs Node.js 20+, and `node` isn't on PATH.")?;
    // dist/pyrite.mjs → the checkout's package.json carries the version.
    let version = script
        .parent()
        .and_then(Path::parent)
        .and_then(|root| std::fs::read_to_string(root.join("package.json")).ok())
        .and_then(|text| serde_json::from_str::<serde_json::Value>(&text).ok())
        .filter(|pkg| pkg.get("name").and_then(|n| n.as_str()) == Some("pyrite"))
        .and_then(|pkg| pkg.get("version")?.as_str().map(str::to_string));
    Ok(PyriteInstall {
        server: CompanionServer {
            name: "pyrite".into(),
            command: node.to_string_lossy().into_owned(),
            args: vec![script.to_string_lossy().into_owned(), "mcp".into()],
        },
        source,
        script,
        version,
    })
}

fn parse_pyrite_discovery(text: &str) -> Option<PyriteInstall> {
    let v: serde_json::Value = serde_json::from_str(text).ok()?;
    let command = v.get("command")?.as_str()?.to_string();
    if !Path::new(&command).is_file() {
        return None;
    }
    let args = v
        .get("args")?
        .as_array()?
        .iter()
        .map(|a| a.as_str().map(str::to_string))
        .collect::<Option<Vec<_>>>()?;
    // The bundle is the argument just before the `mcp` subcommand; it must
    // still exist (a moved checkout), or the server would die on start.
    let mcp = args.iter().rposition(|a| a == "mcp")?;
    let script = PathBuf::from(args.get(mcp.checked_sub(1)?)?);
    if !script.is_file() {
        return None;
    }
    Some(PyriteInstall {
        server: CompanionServer {
            name: "pyrite".into(),
            command,
            args,
        },
        source: PyriteSource::Discovered,
        script,
        version: v.get("version").and_then(|x| x.as_str()).map(str::to_string),
    })
}

/// Resolve the `gvibe` CLI and describe the MCP server entry for `project`.
pub fn mcp_entry(app: &AppHandle, project: &Path) -> McpEntry {
    let (command, mut args) = resolve_gvibe(app);
    args.push("serve".into());
    McpEntry {
        command,
        args,
        project: project.to_string_lossy().into_owned(),
        companions: pyrite_server().into_iter().collect(),
    }
}

/// Write `<config_dir>/mcp/<projectHash>.json` (Claude's `--mcp-config`) and
/// return its path. `config_dir` is the app's config dir (already
/// `.../foundry-godot`). `app` resolves the bundled sidecar and CLI bundle.
pub fn ensure_mcp_config(app: &AppHandle, config_dir: &Path, project: &Path) -> AppResult<PathBuf> {
    let dir = config_dir.join("mcp");
    std::fs::create_dir_all(&dir)?;
    let file = dir.join(format!("{}.json", project_hash(project)));

    let entry = mcp_entry(app, project);
    std::fs::write(&file, serde_json::to_vec_pretty(&claude_config(&entry))?)?;
    Ok(file)
}

/// Render Claude's `--mcp-config` JSON: `godot-vibe-os` plus any companions.
fn claude_config(entry: &McpEntry) -> serde_json::Value {
    let mut servers = serde_json::Map::new();
    servers.insert(
        "godot-vibe-os".into(),
        serde_json::json!({
            "command": entry.command,
            "args": entry.args,
            "env": { "GVIBE_PROJECT": entry.project }
        }),
    );
    for c in &entry.companions {
        servers.insert(
            c.name.clone(),
            serde_json::json!({ "command": c.command, "args": c.args }),
        );
    }
    serde_json::json!({ "mcpServers": servers })
}

/// Write `<config_dir>/mcp/<projectHash>.opencode.json` and return its path.
///
/// `opencode run` has no `--mcp-config` flag, so this file — handed to the child
/// as `OPENCODE_CONFIG` (see `agent::spawn`) — is the only way to give an
/// OpenCode run the same `godot-vibe-os` server Claude and Codex get. It also
/// defines the `godot-reader` primary agent used by answer-only runs: write,
/// edit, shell, web and every `godot-vibe-os` tool are denied, so the project
/// map's Ask box physically cannot change the project.
pub fn ensure_opencode_config(app: &AppHandle, project: &Path) -> AppResult<PathBuf> {
    let dir = crate::store::config_dir()?.join("mcp");
    std::fs::create_dir_all(&dir)?;
    let file = dir.join(format!("{}.opencode.json", project_hash(project)));

    let entry = mcp_entry(app, project);
    std::fs::write(&file, serde_json::to_vec_pretty(&opencode_config(&entry))?)?;
    Ok(file)
}

/// Render the OpenCode config value for one MCP `entry`. Pure so the shape (and
/// the read-only agent's denials) can be asserted without a Tauri `AppHandle`.
fn opencode_config(entry: &McpEntry) -> serde_json::Value {
    let mut command = vec![entry.command.clone()];
    command.extend(entry.args.iter().cloned());

    let mut config = serde_json::json!({
        "$schema": "https://opencode.ai/config.json",
        "mcp": {
            "godot-vibe-os": {
                "type": "local",
                "command": command,
                "environment": { "GVIBE_PROJECT": entry.project },
                "enabled": true
            }
        },
        "agent": {
            "godot-reader": {
                "description": "Read-only Godot project Q&A. Denies every write, shell, web and bridge tool.",
                "mode": "primary",
                "tools": {
                    "write": false,
                    "edit": false,
                    "bash": false,
                    "webfetch": false,
                    "websearch": false,
                    "godot-vibe-os*": false
                },
                "permission": {
                    "edit": "deny",
                    "bash": "deny",
                    "webfetch": "deny"
                }
            }
        }
    });
    for c in &entry.companions {
        let mut cmd = vec![c.command.clone()];
        cmd.extend(c.args.iter().cloned());
        config["mcp"][&c.name] = serde_json::json!({ "type": "local", "command": cmd, "enabled": true });
        // The read-only reader must not reach companion tools either.
        config["agent"]["godot-reader"]["tools"][format!("{}*", c.name)] = serde_json::json!(false);
    }
    config
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

/// Resolve how to invoke the `gvibe` CLI, as `(command, prefix_args)` — everything
/// before the subcommand. Callers append the subcommand + its flags (e.g.
/// `"serve"`, or `["init", "--project", …]`).
///
// B6: prefer the bundled sidecar — a Node 20 `externalBin` plus the esbuild-
// bundled `gvibe.cjs` shipped as a Tauri resource, version-locking the MCP
// server to the app release. Fall back to the monorepo CLI (dev builds) via the
// system `node`, then to `gvibe` on PATH.
pub fn resolve_gvibe(app: &AppHandle) -> (String, Vec<String>) {
    if let Some(entry) = bundled_gvibe(app) {
        return entry;
    }
    if let Some(entry) = dev_gvibe_base() {
        return entry;
    }
    log::warn!("gvibe CLI not found (no bundled sidecar, not in monorepo); falling back to `gvibe` on PATH");
    ("gvibe".into(), Vec::new())
}

/// Build a subprocess for a previously resolved gvibe command/prefix.
///
/// Resolution stays on the Tauri thread because it may use app resources;
/// callers can then move the returned command into a blocking worker. Absolute
/// bundled/dev commands and the PATH fallback receive the same augmented PATH
/// and non-interactive stdin behavior as the rest of Studio's subprocesses.
pub fn resolved_gvibe_command(
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

/// Source folder of the Godot editor addon bundled with this checkout/app.
pub fn godot_addon_source(app: &AppHandle) -> Option<PathBuf> {
    if let Ok(res) = app.path().resource_dir() {
        let bundled = res.join("resources").join("godot_vibe_os");
        if bundled.join("plugin.cfg").is_file() {
            return Some(bundled);
        }
    }
    dev_repo_path(&["godot", "addons", "godot_vibe_os"])
        .filter(|path| path.join("plugin.cfg").is_file())
}

/// True when both bundled pieces (sidecar node + gvibe.cjs) are present — i.e.
/// this is a packaged build, not `tauri dev`. Surfaced in onboarding status.
pub fn has_bundled_sidecar(app: &AppHandle) -> bool {
    bundled_gvibe(app).is_some()
}

/// Release resolution: the `node` sidecar (bundled next to the app binary by
/// Tauri's `externalBin`, target-triple suffix stripped) + `resources/gvibe.cjs`.
/// Both must exist or we return `None` so callers fall through to dev/PATH.
fn bundled_gvibe(app: &AppHandle) -> Option<(String, Vec<String>)> {
    let exe = std::env::current_exe().ok()?;
    let bin_dir = exe.parent()?;
    let node = bin_dir.join(if cfg!(windows) { "node.exe" } else { "node" });

    let res = app.path().resource_dir().ok()?;
    let cjs = res.join("resources").join("gvibe.cjs");

    if node.is_file() && cjs.is_file() {
        return Some((
            node.to_string_lossy().into_owned(),
            vec![cjs.to_string_lossy().into_owned()],
        ));
    }
    None
}

/// Dev resolution: the monorepo CLI (`apps/cli/bin/gvibe`) run via system Node.
/// (covers `tauri dev`, binary under `target/`), then the compile-time manifest
/// dir.
fn dev_gvibe_base() -> Option<(String, Vec<String>)> {
    let node = crate::proc::resolve("node")?.to_string_lossy().into_owned();
    let gvibe = dev_repo_path(&["apps", "cli", "bin", "gvibe"]).filter(|p| p.is_file())?;
    Some((node, vec![gvibe.to_string_lossy().into_owned()]))
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

    fn test_entry() -> McpEntry {
        McpEntry {
            command: "node".into(),
            args: vec!["/opt/cli.cjs".into(), "serve".into()],
            project: "/Users/x/Game".into(),
            companions: vec![],
        }
    }

    fn pyrite() -> CompanionServer {
        CompanionServer {
            name: "pyrite".into(),
            command: "node".into(),
            args: vec!["/opt/pyrite.mjs".into(), "mcp".into()],
        }
    }

    #[test]
    fn pyrite_discovery_requires_a_live_launcher() {
        let exe = std::env::current_exe().unwrap().to_string_lossy().into_owned();
        // Any existing file stands in for the bundle.
        let ok = serde_json::json!({ "version": "0.1.0", "command": exe, "args": [exe, "mcp"] }).to_string();
        let found = parse_pyrite_discovery(&ok).expect("valid discovery");
        assert_eq!(found.server.name, "pyrite");
        assert_eq!(found.server.args, vec![exe.clone(), "mcp".to_string()]);
        assert_eq!(found.source, PyriteSource::Discovered);
        assert_eq!(found.version.as_deref(), Some("0.1.0"));
        let stale = serde_json::json!({ "command": "/nope/node", "args": ["mcp"] }).to_string();
        assert!(parse_pyrite_discovery(&stale).is_none());
        // A live node whose bundle was deleted (checkout moved) is stale too.
        let moved = serde_json::json!({ "command": exe, "args": ["/gone/pyrite.mjs", "mcp"] }).to_string();
        assert!(parse_pyrite_discovery(&moved).is_none());
        assert!(parse_pyrite_discovery("not json").is_none());
    }

    #[test]
    fn a_linked_folder_resolves_to_its_bundle_and_a_bad_link_says_why() {
        let root = std::env::temp_dir().join(format!("pyrite-link-{}", std::process::id()));
        let dist = root.join("dist");
        std::fs::create_dir_all(&dist).unwrap();
        std::fs::write(dist.join("pyrite.mjs"), "").unwrap();
        assert_eq!(pyrite_script(&root), Some(dist.join("pyrite.mjs")));
        assert_eq!(pyrite_script(&dist.join("pyrite.mjs")), Some(dist.join("pyrite.mjs")));
        assert_eq!(pyrite_script(&dist), None);
        let err = locate_pyrite(Some(&root.join("missing"))).unwrap_err();
        assert!(err.contains("No Pyrite build"), "{err}");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn claude_config_registers_companions_next_to_the_engine_server() {
        let mut entry = test_entry();
        entry.companions = vec![pyrite()];
        let c = claude_config(&entry);
        assert_eq!(c["mcpServers"]["godot-vibe-os"]["env"]["GVIBE_PROJECT"], "/Users/x/Game");
        assert_eq!(c["mcpServers"]["pyrite"]["args"][0], "/opt/pyrite.mjs");
        entry.companions.clear();
        assert!(claude_config(&entry)["mcpServers"].get("pyrite").is_none());
    }

    #[test]
    fn companion_servers_join_the_opencode_config_and_stay_off_the_reader() {
        let mut entry = test_entry();
        entry.companions = vec![pyrite()];
        let oc = opencode_config(&entry);
        assert_eq!(oc["mcp"]["pyrite"]["command"][1], "/opt/pyrite.mjs");
        assert_eq!(oc["agent"]["godot-reader"]["tools"]["pyrite*"], false);
        entry.companions.clear();
        assert!(opencode_config(&entry)["mcp"].get("pyrite").is_none());
    }


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
    fn opencode_config_carries_the_mcp_server_and_a_locked_down_reader() {
        let entry = McpEntry {
            command: "node".into(),
            args: vec!["/opt/gvibe.cjs".into(), "serve".into()],
            project: "/Users/x/Game".into(),
            companions: vec![],
        };
        let config = opencode_config(&entry);
        assert_eq!(config["mcp"]["godot-vibe-os"]["type"], "local");
        assert_eq!(
            config["mcp"]["godot-vibe-os"]["command"][0],
            serde_json::json!("node")
        );
        assert_eq!(
            config["mcp"]["godot-vibe-os"]["environment"]["GVIBE_PROJECT"],
            "/Users/x/Game"
        );
        let reader = &config["agent"]["godot-reader"];
        assert_eq!(reader["mode"], "primary");
        assert_eq!(reader["tools"]["write"], false);
        assert_eq!(reader["tools"]["edit"], false);
        assert_eq!(reader["tools"]["bash"], false);
        assert_eq!(reader["tools"]["godot-vibe-os*"], false);
        assert_eq!(reader["permission"]["edit"], "deny");
        assert_eq!(reader["permission"]["bash"], "deny");
    }

    #[test]
    fn dev_repo_path_finds_monorepo_cli() {
        // The manifest-dir fallback should locate the CLI shim in this checkout.
        let gvibe = dev_repo_path(&["apps", "cli", "bin", "gvibe"]);
        assert!(
            gvibe.is_some(),
            "expected to find apps/cli/bin/gvibe in the monorepo"
        );
        assert!(gvibe.unwrap().is_file());
    }
}
