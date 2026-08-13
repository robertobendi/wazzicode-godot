//! Onboarding commands: everything the first-run wizard drives.
//!
//! - `onboarding_status` — one call the wizard uses to pick its starting step.
//! - `onboarding_check_cli` / `onboarding_install_cli` — detect / install the
//!   selected agent's CLI, Claude or Codex (streaming progress on
//!   `onboarding:progress`).
//! - `onboarding_setup_project` — one app-managed "prepare this project"
//!   sequence: initialize, install the Godot addon, build the project
//!   knowledge base, configure access and the agent connection, tidy scratch paths,
//!   then verify.
//!
//! Sub-processes reuse `mcpconfig::resolve_gvibe` so the wizard runs the SAME
//! gvibe binary the chat/loop MCP server will (bundled sidecar in release, the
//! monorepo CLI in dev).

use crate::agent::Backend;
use crate::error::{AppError, AppResult};
use crate::proc;
use crate::state::AppState;
use serde::Serialize;
use std::io::{BufRead, Read};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, State};

// --- Public payloads (serde camelCase; mirrored in src/types/onboarding.ts) ---

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CliStatus {
    pub found: bool,
    pub path: Option<String>,
    pub version: Option<String>,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NodeSidecar {
    /// True in a packaged build (bundled node + gvibe.cjs present).
    pub bundled: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OnboardingStatus {
    /// The agent the user has chosen. The wizard gates the CLI + sign-in steps
    /// on this, so only the selected backend has to be installed.
    pub agent_backend: Backend,
    pub claude_cli: CliStatus,
    pub codex_cli: CliStatus,
    pub node_sidecar: NodeSidecar,
    pub current_project: Option<String>,
    /// Inspection of `current_project` (if any), so the wizard can pre-fill.
    pub project_ready: Option<crate::commands::project::ProjectInfo>,
    /// This machine has connected at least once (persisted `paired_ok`).
    /// Claude-only; Codex readiness is `codexAuth.loggedIn` (polled separately).
    pub paired_ok: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SetupStep {
    pub id: String,
    pub ok: bool,
    pub detail: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DoctorSummary {
    pub project_valid: bool,
    pub config_ok: bool,
    pub addon_detected: bool,
    pub addon_enabled: bool,
    pub brain_ready: bool,
    pub bridge_reachable: bool,
    pub ok: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SetupResult {
    pub steps: Vec<SetupStep>,
    pub summary: Option<DoctorSummary>,
}

// --- Commands ---

/// Everything the wizard needs to decide where to start. Cheap; safe to poll.
#[tauri::command]
pub async fn onboarding_status(
    app: AppHandle,
    state: State<'_, AppState>,
) -> AppResult<OnboardingStatus> {
    let (current_project, paired_ok, agent_backend) = {
        let s = state.settings.read().await;
        (s.current_project.clone(), s.paired_ok, s.agent_backend)
    };
    let bundled = crate::mcpconfig::has_bundled_sidecar(&app);

    let cur = current_project.clone();
    let (claude_cli, codex_cli, project_ready) = tokio::task::spawn_blocking(move || {
        let claude = check_cli_blocking(Backend::Claude);
        let codex = check_cli_blocking(Backend::Codex);
        let pr = cur.map(crate::commands::project::inspect_project);
        (claude, codex, pr)
    })
    .await
    .map_err(|e| AppError::Other(format!("status task failed: {e}")))?;

    Ok(OnboardingStatus {
        agent_backend,
        claude_cli,
        codex_cli,
        node_sidecar: NodeSidecar { bundled },
        current_project,
        project_ready,
        paired_ok,
    })
}

/// Is `backend`'s CLI installed, and what version? Blocking probe under the hood.
#[tauri::command]
pub async fn onboarding_check_cli(backend: Backend) -> AppResult<CliStatus> {
    tokio::task::spawn_blocking(move || check_cli_blocking(backend))
        .await
        .map_err(|e| AppError::Other(format!("cli check task failed: {e}")))
}

/// Install `backend`'s CLI via its official installer, streaming progress lines
/// on `onboarding:progress` ({step:"install_cli", line}). Re-checks afterwards
/// and returns the resulting status; errors with a copy-able manual command on
/// failure. Requires network. Long timeout — installers can be slow.
#[tauri::command]
pub async fn onboarding_install_cli(
    app: AppHandle,
    backend: Backend,
    state: State<'_, AppState>,
) -> AppResult<CliStatus> {
    let permit = state.executions.try_acquire_cli_install().ok_or_else(|| {
        AppError::Other(
            "busy: wait for the current task or CLI install to finish before installing".into(),
        )
    })?;
    tokio::task::spawn_blocking(move || {
        let _permit = permit;
        install_cli_blocking(&app, backend)
    })
    .await
    .map_err(|e| AppError::Other(format!("install task failed: {e}")))?
}

/// Prepare a Godot project for the app. Each step emits friendly progress and
/// contributes a `SetupStep` to the aggregated result.
#[tauri::command]
pub async fn onboarding_setup_project(
    app: AppHandle,
    project: String,
    state: State<'_, AppState>,
) -> AppResult<SetupResult> {
    let project_path = PathBuf::from(&project);
    let permit = state
        .executions
        .try_acquire(&project_path)
        .ok_or_else(|| AppError::Other("busy: another task is using this project".into()))?;
    let config_dir = state.config_dir.clone();
    // Resolve the gvibe invocation + addon source on the main thread (needs the
    // Tauri path resolver), then do the blocking sub-spawns off-runtime.
    let (gvibe_cmd, gvibe_prefix) = crate::mcpconfig::resolve_gvibe(&app);
    let addon_source = crate::mcpconfig::godot_addon_source(&app);

    tokio::task::spawn_blocking(move || {
        let _permit = permit;
        setup_blocking(
            app,
            project_path,
            config_dir,
            gvibe_cmd,
            gvibe_prefix,
            addon_source,
        )
    })
    .await
    .map_err(|e| AppError::Other(format!("setup task failed: {e}")))?
}

// --- CLI detection / install ---

fn check_cli_blocking(backend: Backend) -> CliStatus {
    let bin = backend.bin();
    match proc::resolve(bin) {
        None => CliStatus {
            found: false,
            path: None,
            version: None,
            error: None,
        },
        Some(p) => {
            let path = p.to_string_lossy().into_owned();
            let mut cmd = match proc::command(bin) {
                Ok(cmd) => cmd,
                Err(e) => return cli_probe_failed(backend, path, e.to_string()),
            };
            cmd.arg("--version");
            match proc::output_with_timeout(cmd, Duration::from_secs(10)) {
                Ok(out) if out.status.success() => {
                    let version =
                        first_nonempty(&out.stdout).or_else(|| first_nonempty(&out.stderr));
                    match version {
                        Some(version) => match check_cli_capabilities(backend) {
                            Ok(()) => CliStatus {
                                found: true,
                                path: Some(path),
                                version: Some(version),
                                error: None,
                            },
                            Err(detail) => cli_probe_failed(backend, path, detail),
                        },
                        None => cli_probe_failed(
                            backend,
                            path,
                            format!("`{bin} --version` returned no version"),
                        ),
                    }
                }
                Ok(out) => {
                    let detail = first_nonempty(&out.stderr)
                        .or_else(|| first_nonempty(&out.stdout))
                        .map(|line| format!("`{bin} --version` failed: {line}"))
                        .unwrap_or_else(|| format!("`{bin} --version` failed"));
                    cli_probe_failed(backend, path, detail)
                }
                Err(e) => cli_probe_failed(backend, path, e.to_string()),
            }
        }
    }
}

fn check_cli_capabilities(backend: Backend) -> Result<(), String> {
    let (primary_args, secondary_args): (&[&str], Option<&[&str]>) = match backend {
        Backend::Claude => (&["--help"], None),
        Backend::Codex => (&["exec", "--help"], Some(&["debug", "models", "--help"])),
    };
    let primary = cli_help(backend.bin(), primary_args)?;
    let secondary = secondary_args
        .map(|args| cli_help(backend.bin(), args))
        .transpose()?
        .unwrap_or_default();
    if capabilities_supported(backend, &primary, &secondary) {
        Ok(())
    } else {
        Err(format!(
            "this version is missing features foundry-godot needs; update the {} CLI",
            backend.label()
        ))
    }
}

fn cli_help(bin: &str, args: &[&str]) -> Result<String, String> {
    let mut cmd = proc::command(bin).map_err(|error| error.to_string())?;
    cmd.args(args);
    let out = proc::output_with_timeout(cmd, Duration::from_secs(10))
        .map_err(|error| error.to_string())?;
    if !out.status.success() {
        return Err(format!("`{bin} {}` failed", args.join(" ")));
    }
    Ok(format!(
        "{}\n{}",
        String::from_utf8_lossy(&out.stdout),
        String::from_utf8_lossy(&out.stderr)
    ))
}

fn capabilities_supported(backend: Backend, primary: &str, secondary: &str) -> bool {
    match backend {
        Backend::Claude => ["--effort", "--settings", "--setting-sources", "setup-token"]
            .iter()
            .all(|feature| primary.contains(feature)),
        Backend::Codex => {
            ["--ignore-user-config", "--json", "resume"]
                .iter()
                .all(|feature| primary.contains(feature))
                && secondary.contains("--bundled")
        }
    }
}

fn first_nonempty(bytes: &[u8]) -> Option<String> {
    String::from_utf8_lossy(bytes)
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .map(str::to_string)
}

fn cli_probe_failed(backend: Backend, path: String, detail: String) -> CliStatus {
    CliStatus {
        found: false,
        path: Some(path),
        version: None,
        error: Some(format!(
            "Found the {} CLI, but it isn't runnable: {detail}. Reinstall it with:\n  {}",
            backend.label(),
            manual_install_command(backend)
        )),
    }
}

fn install_cli_blocking(app: &AppHandle, backend: Backend) -> AppResult<CliStatus> {
    let label = backend.label();
    let plan = install_plan(backend);
    let mut cmd = proc::command(plan.program)?;
    cmd.args(&plan.args);
    for (name, value) in plan.env {
        cmd.env(name, value);
    }
    emit_line(
        app,
        "install_cli",
        &format!("Installing the {label} CLI ({})…", plan.program),
    );
    // Some installers exit nonzero yet still install; re-check regardless.
    let install = stream_process(app, "install_cli", cmd, proc::INSTALL_TIMEOUT);

    let status = check_cli_blocking(backend);
    if status.found {
        emit_line(app, "install_cli", &format!("{label} CLI is ready."));
        return Ok(status);
    }
    let stream_detail = match install {
        Ok((true, _)) => None,
        Ok((false, output)) => last_line(&output),
        Err(error) => Some(error.to_string()),
    };
    let detail = status
        .error
        .as_deref()
        .map(str::to_string)
        .or(stream_detail)
        .map(|line| format!("\n\n{line}"))
        .unwrap_or_default();
    Err(AppError::Other(format!(
        "Couldn't install the {label} CLI automatically. Run this in a terminal, then check again:\n  {}{detail}",
        manual_install_command(backend),
    )))
}

/// The installer invocation per backend + OS. Pure (branches on target_os) so
/// it's unit-testable on the host.
struct InstallPlan {
    program: &'static str,
    args: Vec<&'static str>,
    env: Vec<(&'static str, &'static str)>,
}

fn install_plan(backend: Backend) -> InstallPlan {
    match backend {
        Backend::Codex => {
            #[cfg(target_os = "windows")]
            {
                InstallPlan {
                    program: "powershell",
                    args: vec![
                        "-NoProfile",
                        "-Command",
                        "irm https://chatgpt.com/codex/install.ps1 | iex",
                    ],
                    env: vec![("CODEX_NON_INTERACTIVE", "1")],
                }
            }
            #[cfg(not(target_os = "windows"))]
            {
                InstallPlan {
                    program: "sh",
                    args: vec![
                        "-c",
                        "curl -fsSL https://chatgpt.com/codex/install.sh | CODEX_NON_INTERACTIVE=1 sh",
                    ],
                    env: vec![("CODEX_NON_INTERACTIVE", "1")],
                }
            }
        }
        Backend::Claude => {
            #[cfg(target_os = "windows")]
            {
                InstallPlan {
                    program: "powershell",
                    args: vec![
                        "-NoProfile",
                        "-Command",
                        "irm https://claude.ai/install.ps1 | iex",
                    ],
                    env: Vec::new(),
                }
            }
            #[cfg(not(target_os = "windows"))]
            {
                InstallPlan {
                    program: "bash",
                    args: vec!["-c", "curl -fsSL https://claude.ai/install.sh | bash"],
                    env: Vec::new(),
                }
            }
        }
    }
}

fn manual_install_command(backend: Backend) -> &'static str {
    match backend {
        Backend::Codex => {
            #[cfg(target_os = "windows")]
            {
                "$env:CODEX_NON_INTERACTIVE=1; irm https://chatgpt.com/codex/install.ps1 | iex"
            }
            #[cfg(not(target_os = "windows"))]
            {
                "curl -fsSL https://chatgpt.com/codex/install.sh | CODEX_NON_INTERACTIVE=1 sh"
            }
        }
        Backend::Claude => {
            #[cfg(target_os = "windows")]
            {
                "irm https://claude.ai/install.ps1 | iex"
            }
            #[cfg(not(target_os = "windows"))]
            {
                "curl -fsSL https://claude.ai/install.sh | bash"
            }
        }
    }
}

// --- Project setup sequence ---

fn setup_blocking(
    app: AppHandle,
    project: PathBuf,
    config_dir: PathBuf,
    gvibe_cmd: String,
    gvibe_prefix: Vec<String>,
    addon_source: Option<PathBuf>,
) -> AppResult<SetupResult> {
    let proj = project.to_string_lossy().to_string();
    let mut steps: Vec<SetupStep> = Vec::new();

    // (a) gvibe init — .godot-vibe/ scaffold + CLAUDE.md block.
    let init = run_gvibe_step(
        &app,
        "init",
        &gvibe_cmd,
        &gvibe_prefix,
        &["init", "--project", &proj, "--json"],
    );
    let init_ok = init.ok;
    steps.push(init);
    if !init_ok {
        return Ok(SetupResult {
            steps,
            summary: None,
        });
    }

    // (b) Install/update the editor addon from the exact source bundled with
    // this app build. `gvibe install-addon` owns the copy and enable semantics.
    if let Some(source) = addon_source.as_deref() {
        let source_arg = format!("--source={}", source.to_string_lossy());
        steps.push(run_gvibe_step(
            &app,
            "install_addon",
            &gvibe_cmd,
            &gvibe_prefix,
            &["install-addon", "--project", &proj, &source_arg],
        ));
    } else {
        emit_line(
            &app,
            "install_addon",
            "Couldn't find the Godot Vibe OS addon to install.",
        );
        steps.push(SetupStep {
            id: "install_addon".into(),
            ok: false,
            detail: "godot/addons/godot_vibe_os source not found".into(),
        });
    }

    // (c) Build the canonical project map after addon setup.
    steps.push(run_gvibe_step(
        &app,
        "brain",
        &gvibe_cmd,
        &gvibe_prefix,
        &["brain", "--project", &proj],
    ));

    // (d) Repair access internally. This is intentionally not a CLI task in
    // the UI: users should only see that Studio is finishing setup.
    emit_line(&app, "access", "Finishing AI setup…");
    match crate::commands::project::ensure_project_access(&project) {
        Ok(_) => steps.push(SetupStep {
            id: "access".into(),
            ok: true,
            detail: "ready".into(),
        }),
        Err(e) => steps.push(SetupStep {
            id: "access".into(),
            ok: false,
            detail: e.to_string(),
        }),
    }

    // (e) App-managed MCP config for chat and autonomous-loop runs.
    emit_line(&app, "mcp_config", "Writing the agent connection…");
    match crate::mcpconfig::ensure_mcp_config(&app, &config_dir, &project) {
        Ok(p) => steps.push(SetupStep {
            id: "mcp_config".into(),
            ok: true,
            detail: p.to_string_lossy().into_owned(),
        }),
        Err(e) => steps.push(SetupStep {
            id: "mcp_config".into(),
            ok: false,
            detail: e.to_string(),
        }),
    }

    // (f) .gitignore the app's scratch dirs (the loop does `git add -A`).
    emit_line(&app, "gitignore", "Updating .gitignore…");
    match patch_gitignore_file(&project) {
        Ok(true) => steps.push(SetupStep {
            id: "gitignore".into(),
            ok: true,
            detail: "ignored Godot cache and generated Foundry state".into(),
        }),
        Ok(false) => steps.push(SetupStep {
            id: "gitignore".into(),
            ok: true,
            detail: "already ignored".into(),
        }),
        Err(e) => steps.push(SetupStep {
            id: "gitignore".into(),
            ok: false,
            detail: e.to_string(),
        }),
    }

    // (g) Verify with doctor --json.
    let summary = run_doctor_summary(&app, &gvibe_cmd, &gvibe_prefix, &proj, &mut steps);

    Ok(SetupResult { steps, summary })
}

fn run_gvibe_step(
    app: &AppHandle,
    id: &str,
    cmd: &str,
    prefix: &[String],
    sub: &[&str],
) -> SetupStep {
    emit_line(app, id, &format!("gvibe {}", sub.join(" ")));
    let args = sub.iter().map(|s| s.to_string()).collect::<Vec<_>>();
    let command = match crate::mcpconfig::resolved_gvibe_command(cmd, prefix, &args) {
        Ok(c) => c,
        Err(e) => {
            return SetupStep {
                id: id.into(),
                ok: false,
                detail: e.to_string(),
            }
        }
    };
    // The project scan can take materially longer than the small setup commands.
    let timeout = if id == "brain" {
        Duration::from_secs(600)
    } else {
        Duration::from_secs(120)
    };
    match stream_process(app, id, command, timeout) {
        Ok((ok, tail)) => SetupStep {
            id: id.into(),
            ok,
            detail: last_line(&tail).unwrap_or_else(|| {
                if ok {
                    "done".into()
                } else {
                    "failed".into()
                }
            }),
        },
        Err(e) => SetupStep {
            id: id.into(),
            ok: false,
            detail: e.to_string(),
        },
    }
}

fn run_doctor_summary(
    app: &AppHandle,
    cmd: &str,
    prefix: &[String],
    proj: &str,
    steps: &mut Vec<SetupStep>,
) -> Option<DoctorSummary> {
    emit_line(app, "doctor", "Verifying setup…");
    let args = ["doctor", "--project", proj, "--json"]
        .iter()
        .map(|s| s.to_string())
        .collect::<Vec<_>>();
    let command = match crate::mcpconfig::resolved_gvibe_command(cmd, prefix, &args) {
        Ok(c) => c,
        Err(e) => {
            steps.push(SetupStep {
                id: "doctor".into(),
                ok: false,
                detail: e.to_string(),
            });
            return None;
        }
    };
    // Capture the full JSON (don't stream — it must parse whole).
    let out = match proc::output_with_timeout(command, Duration::from_secs(60)) {
        Ok(o) => o,
        Err(e) => {
            steps.push(SetupStep {
                id: "doctor".into(),
                ok: false,
                detail: e.to_string(),
            });
            return None;
        }
    };
    let stdout = String::from_utf8_lossy(&out.stdout);
    match serde_json::from_str::<serde_json::Value>(&stdout) {
        Ok(v) => {
            let b = |ptr: &str| v.pointer(ptr).and_then(|x| x.as_bool()).unwrap_or(false);
            let summary = DoctorSummary {
                project_valid: b("/project/valid"),
                config_ok: b("/config/exists"),
                addon_detected: b("/godotAddon/detected"),
                addon_enabled: b("/godotAddon/enabled"),
                brain_ready: b("/brain/exists") && !b("/brain/stale"),
                bridge_reachable: b("/bridge/reachable"),
                ok: b("/ok"),
            };
            emit_line(
                app,
                "doctor",
                &format!(
                    "project={} config={} addon={}/{} map={} bridge={}",
                    summary.project_valid,
                    summary.config_ok,
                    summary.addon_detected,
                    summary.addon_enabled,
                    summary.brain_ready,
                    summary.bridge_reachable
                ),
            );
            steps.push(SetupStep {
                id: "doctor".into(),
                ok: summary.project_valid
                    && summary.config_ok
                    && summary.addon_detected
                    && summary.addon_enabled
                    && summary.brain_ready,
                detail: "verified".into(),
            });
            Some(summary)
        }
        Err(_) => {
            steps.push(SetupStep {
                id: "doctor".into(),
                ok: false,
                detail: "couldn't parse doctor output".into(),
            });
            None
        }
    }
}

// --- Pure helpers (unit-tested) ---

/// Idempotently ensure `.gitignore` ignores the app's scratch dirs. `existing`
/// is the current file content (or `None` if absent). Returns the new content
/// when a change is needed, else `None`.
pub fn patch_gitignore(existing: Option<&str>) -> Option<String> {
    const ENTRIES: [&str; 9] = [
        ".godot/",
        ".godot-vibe/action_log.jsonl",
        ".godot-vibe/brain/",
        ".godot-vibe/inbox/",
        ".godot-vibe/loop/",
        ".godot-vibe/snapshots/",
        ".godot-vibe/studio/",
        ".godot-vibe/brain.lock*/",
        ".godot-vibe/write.lock*/",
    ];
    let current = existing.unwrap_or("");
    let present = |needle: &str| current.lines().any(|l| l.trim() == needle);
    let missing: Vec<&str> = ENTRIES.iter().copied().filter(|e| !present(e)).collect();
    if missing.is_empty() {
        return None;
    }
    let mut out = current.to_string();
    if !out.is_empty() && !out.ends_with('\n') {
        out.push('\n');
    }
    if !current.contains("foundry-godot scratch") && !current.contains("Foundry for Godot scratch")
    {
        if !out.is_empty() {
            out.push('\n');
        }
        out.push_str("# foundry-godot scratch (safe to ignore)\n");
    }
    for e in missing {
        out.push_str(e);
        out.push('\n');
    }
    Some(out)
}

fn patch_gitignore_file(project: &Path) -> AppResult<bool> {
    let path = crate::commands::project::contained_project_path(project, Path::new(".gitignore"))?;
    let existing = match std::fs::read_to_string(&path) {
        Ok(existing) => Some(existing),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
        Err(error) => return Err(error.into()),
    };
    match patch_gitignore(existing.as_deref()) {
        Some(next) => {
            std::fs::write(&path, next)?;
            Ok(true)
        }
        None => Ok(false),
    }
}

// --- Process plumbing ---

/// Run `cmd` to completion with a deadline, emitting each stdout/stderr line as
/// `onboarding:progress` {step, line}. Returns `(success, tail)` where `tail` is
/// the (capped) collected output for the step detail.
fn stream_process(
    app: &AppHandle,
    step: &str,
    mut cmd: Command,
    timeout: Duration,
) -> AppResult<(bool, String)> {
    cmd.stdout(Stdio::piped());
    cmd.stderr(Stdio::piped());
    configure_process_tree(&mut cmd);
    let mut child = cmd
        .spawn()
        .map_err(|e| AppError::Other(format!("could not start {step}: {e}")))?;

    let out_handle = std::thread::spawn(stream_reader(
        app.clone(),
        step.to_string(),
        child.stdout.take(),
    ));
    let err_handle = std::thread::spawn(stream_reader(
        app.clone(),
        step.to_string(),
        child.stderr.take(),
    ));

    let deadline = Instant::now() + timeout;
    let status = loop {
        match child.try_wait() {
            Ok(Some(s)) => break s,
            Ok(None) => {
                if Instant::now() >= deadline {
                    terminate_process_tree(&mut child);
                    let _ = out_handle.join();
                    let _ = err_handle.join();
                    return Err(AppError::Other(format!("{step} timed out and was stopped")));
                }
                std::thread::sleep(Duration::from_millis(50));
            }
            Err(e) => {
                terminate_process_tree(&mut child);
                let _ = out_handle.join();
                let _ = err_handle.join();
                return Err(AppError::Other(format!("waiting on {step} failed: {e}")));
            }
        }
    };

    let mut tail = out_handle.join().unwrap_or_default();
    let err_tail = err_handle.join().unwrap_or_default();
    if !err_tail.is_empty() {
        if !tail.is_empty() {
            tail.push('\n');
        }
        tail.push_str(&err_tail);
    }
    Ok((status.success(), tail))
}

fn configure_process_tree(cmd: &mut Command) {
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        cmd.process_group(0);
    }
    #[cfg(not(unix))]
    {
        let _ = cmd;
    }
}

/// Stop the installer and every process it launched. Shell installers are
/// pipelines, so killing only the shell can leave curl or an install script
/// alive with the progress pipes held open.
fn terminate_process_tree(child: &mut std::process::Child) {
    let pid = child.id();

    #[cfg(unix)]
    {
        unsafe {
            libc::kill(-(pid as i32), libc::SIGTERM);
        }
        let deadline = Instant::now() + Duration::from_secs(2);
        while Instant::now() < deadline {
            match child.try_wait() {
                // The group leader can exit while a descendant that ignored
                // SIGTERM remains. Still send SIGKILL to the group below.
                Ok(Some(_)) => break,
                Ok(None) => std::thread::sleep(Duration::from_millis(25)),
                Err(_) => break,
            }
        }
        unsafe {
            libc::kill(-(pid as i32), libc::SIGKILL);
        }
    }

    #[cfg(windows)]
    {
        let mut taskkill = Command::new("taskkill");
        taskkill.args(["/T", "/F", "/PID", &pid.to_string()]);
        taskkill
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        proc::no_window(&mut taskkill);
        let _ = taskkill.status();
    }

    let _ = child.kill();
    let _ = child.wait();
}

/// A closure that drains a child pipe line-by-line, emitting each line and
/// returning the (capped) collected text. Returned as an `FnOnce` for
/// `thread::spawn`.
fn stream_reader<R: Read + Send + 'static>(
    app: AppHandle,
    step: String,
    pipe: Option<R>,
) -> impl FnOnce() -> String {
    move || {
        let Some(pipe) = pipe else {
            return String::new();
        };
        let mut collected = String::new();
        for line in std::io::BufReader::new(pipe).lines() {
            let Ok(line) = line else { break };
            let _ = app.emit(
                "onboarding:progress",
                serde_json::json!({ "step": step, "line": line }),
            );
            if collected.len() < 8192 {
                collected.push_str(&line);
                collected.push('\n');
            }
        }
        collected
    }
}

fn emit_line(app: &AppHandle, step: &str, line: &str) {
    let _ = app.emit(
        "onboarding:progress",
        serde_json::json!({ "step": step, "line": line }),
    );
}

fn last_line(s: &str) -> Option<String> {
    s.lines()
        .rev()
        .find(|l| !l.trim().is_empty())
        .map(|l| l.trim().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn gitignore_patch_adds_all_entries_to_empty() {
        let out = patch_gitignore(None).expect("should add entries");
        assert!(out.contains("# foundry-godot scratch (safe to ignore)"));
        assert!(out.contains(".godot-vibe/inbox/"));
        assert!(out.contains(".godot-vibe/loop/"));
        assert!(out.contains(".godot-vibe/studio/"));
        assert!(out.contains(".godot/"));
        assert!(out.contains(".godot-vibe/action_log.jsonl"));
        assert!(out.contains(".godot-vibe/brain/"));
        assert!(out.contains(".godot-vibe/snapshots/"));
        assert!(out.contains(".godot-vibe/write.lock*/"));
        assert!(out.contains(".godot-vibe/brain.lock*/"));
    }

    #[test]
    fn gitignore_patch_is_idempotent() {
        let first = patch_gitignore(None).unwrap();
        // Applying again over the produced content is a no-op.
        assert!(patch_gitignore(Some(&first)).is_none());
    }

    #[test]
    fn gitignore_patch_preserves_legacy_heading_without_adding_a_second_heading() {
        let existing = "# Foundry for Godot scratch (safe to ignore)\n.godot-vibe/inbox/\n";
        let out = patch_gitignore(Some(existing)).expect("loop/ still missing");
        assert!(out.contains("# Foundry for Godot scratch (safe to ignore)"));
        assert!(!out.contains("# foundry-godot scratch (safe to ignore)"));
    }

    #[test]
    fn gitignore_patch_preserves_existing_and_appends_missing() {
        let existing = ".godot/\nTemp/\n.godot-vibe/inbox/\n";
        let out = patch_gitignore(Some(existing)).expect("loop/ still missing");
        assert!(out.starts_with(".godot/\nTemp/\n.godot-vibe/inbox/\n"));
        assert!(out.contains(".godot-vibe/loop/"));
        // inbox not duplicated.
        assert_eq!(out.matches(".godot-vibe/inbox/").count(), 1);
    }

    #[test]
    fn gitignore_patch_handles_missing_trailing_newline() {
        let out = patch_gitignore(Some(".godot/")).unwrap();
        assert!(out.contains(".godot/\n"));
        assert!(out.contains(".godot-vibe/loop/"));
    }

    #[cfg(unix)]
    #[test]
    fn gitignore_file_rejects_symlink_outside_project() {
        use std::os::unix::fs::symlink;

        let root =
            std::env::temp_dir().join(format!("godot-vibe-gitignore-{}", nanoid::nanoid!(10)));
        let project = root.join("project");
        let outside = root.join("outside-gitignore");
        std::fs::create_dir_all(&project).unwrap();
        std::fs::write(&outside, "keep-me\n").unwrap();
        symlink(&outside, project.join(".gitignore")).unwrap();

        let error = patch_gitignore_file(&project).expect_err("outside symlink must be rejected");
        assert!(error.to_string().contains("outside project"));
        assert_eq!(std::fs::read_to_string(&outside).unwrap(), "keep-me\n");

        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn install_plan_matches_host_os() {
        let plan = install_plan(Backend::Claude);
        #[cfg(target_os = "windows")]
        {
            assert_eq!(plan.program, "powershell");
            assert!(plan.args.iter().any(|a| a.contains("install.ps1")));
        }
        #[cfg(not(target_os = "windows"))]
        {
            assert_eq!(plan.program, "bash");
            assert!(plan.args.iter().any(|a| a.contains("install.sh")));
        }
        assert!(plan.env.is_empty());
    }

    #[test]
    fn codex_uses_official_native_noninteractive_installer() {
        let plan = install_plan(Backend::Codex);
        assert!(plan
            .args
            .iter()
            .any(|arg| arg.contains("chatgpt.com/codex/install.")));
        assert_eq!(plan.env, vec![("CODEX_NON_INTERACTIVE", "1")]);
        assert!(manual_install_command(Backend::Codex).contains("CODEX_NON_INTERACTIVE=1"));
        assert!(!plan.args.iter().any(|arg| arg.contains("npm")));
    }

    #[test]
    fn failed_version_probe_is_not_ready_and_is_actionable() {
        let status = cli_probe_failed(
            Backend::Claude,
            "/usr/local/bin/claude".into(),
            "version probe failed".into(),
        );

        assert!(!status.found);
        assert_eq!(status.path.as_deref(), Some("/usr/local/bin/claude"));
        let error = status.error.expect("actionable error");
        assert!(error.contains("version probe failed"));
        assert!(error.contains(manual_install_command(Backend::Claude)));
    }

    #[test]
    fn readiness_requires_the_features_used_by_task_execution() {
        assert!(capabilities_supported(
            Backend::Claude,
            "--effort --settings --setting-sources setup-token",
            ""
        ));
        assert!(!capabilities_supported(
            Backend::Claude,
            "--settings setup-token",
            ""
        ));
        assert!(capabilities_supported(
            Backend::Codex,
            "resume --json --ignore-user-config",
            "--bundled"
        ));
        assert!(!capabilities_supported(
            Backend::Codex,
            "resume --json",
            "--bundled"
        ));
    }

    #[cfg(unix)]
    #[test]
    fn timeout_cleanup_stops_installer_descendants() {
        let marker =
            std::env::temp_dir().join(format!("godot-vibe-installer-tree-{}", nanoid::nanoid!(10)));
        let mut cmd = Command::new("/bin/sh");
        cmd.args([
            "-c",
            "(trap '' TERM; sleep 1; touch \"$1\") & wait",
            "tree-test",
        ])
        .arg(&marker)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
        configure_process_tree(&mut cmd);
        let mut child = cmd.spawn().expect("spawn process tree");

        std::thread::sleep(Duration::from_millis(100));
        terminate_process_tree(&mut child);
        std::thread::sleep(Duration::from_millis(1100));

        assert!(
            !marker.exists(),
            "installer descendant survived process-tree cleanup"
        );
        let _ = std::fs::remove_file(marker);
    }
}
