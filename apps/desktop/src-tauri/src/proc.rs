//! External-CLI spawn helpers.
//!
//! macOS apps launched from the GUI (Finder, Dock, Spotlight, `open -a`)
//! inherit a stripped PATH — typically just `/usr/bin:/bin:/usr/sbin:/sbin`.
//! That excludes Homebrew (`/opt/homebrew/bin`, `/usr/local/bin`), MacPorts
//! (`/opt/local/bin`), Cargo (`~/.cargo/bin`), and user-local installs
//! (`~/.local/bin`). The result: `Command::new("gh").spawn()` fails with
//! `No such file or directory` even though `gh` works fine in the user's
//! terminal.
//!
//! This module solves it once for all spawn sites by:
//!  1. Computing an augmented PATH (user's PATH + well-known extras) once
//!     per process via `OnceLock`. We do NOT mutate the parent process's
//!     environment — `std::env::set_var` is unsound across threads and
//!     `unsafe` in the Rust 2024 edition.
//!  2. Resolving the binary to an absolute path against that PATH.
//!  3. Returning a pre-configured `Command` that sets the child's PATH to
//!     the augmented one (so the child can find its own subprocess deps —
//!     e.g. `gh` shelling out to `git` during `auth setup-git`).
//!
//! If the binary genuinely isn't installed, we return an `AppError::Other`
//! whose message embeds a per-OS install hint. The frontend surfaces those
//! messages verbatim, so users get an actionable error instead of the raw
//! `os error 2`.

use crate::error::AppError;
use std::ffi::OsString;
use std::path::PathBuf;
use std::process::{Command, Output, Stdio};
use std::sync::OnceLock;
use std::time::{Duration, Instant};

/// Deadline for git/gh subprocesses that talk to the network (fetch, pull,
/// push, clone-less gh calls). Generous — a cold fetch of a big repo on slow
/// wifi is legitimate — but finite, so a stalled credential helper or dead
/// remote can never hang a bulk op or the auto-fetch loop forever.
pub const NETWORK_TIMEOUT: Duration = Duration::from_secs(300);

/// Deadline for purely local git subprocesses (status, diff, merge --ff-only,
/// commit). These finish in milliseconds normally; minutes means wedged.
pub const LOCAL_TIMEOUT: Duration = Duration::from_secs(120);

/// Deadline for package-manager installs (brew/winget/scoop). Downloads can
/// genuinely take a while; cap them so the UI's install button can't spin
/// forever on a stuck mirror.
pub const INSTALL_TIMEOUT: Duration = Duration::from_secs(900);

static AUGMENTED_PATH: OnceLock<OsString> = OnceLock::new();

/// PATH used to resolve binaries and exported to children. Built once,
/// cached for the process lifetime.
fn augmented_path() -> &'static OsString {
    AUGMENTED_PATH.get_or_init(build_augmented_path)
}

fn build_augmented_path() -> OsString {
    let current = std::env::var_os("PATH").unwrap_or_default();
    let mut parts: Vec<PathBuf> = std::env::split_paths(&current).collect();

    // Static, platform-specific install dirs. Ordered so the most likely
    // location is checked first.
    #[cfg(target_os = "macos")]
    const STATIC_EXTRAS: &[&str] = &[
        "/opt/homebrew/bin",
        "/opt/homebrew/sbin",
        "/usr/local/bin",
        "/usr/local/sbin",
        "/opt/local/bin", // MacPorts
        "/opt/local/sbin",
    ];
    #[cfg(target_os = "linux")]
    const STATIC_EXTRAS: &[&str] = &[
        "/snap/bin",
        "/var/lib/flatpak/exports/bin",
        "/usr/local/bin",
    ];
    #[cfg(target_os = "windows")]
    const STATIC_EXTRAS: &[&str] = &[];

    let mut additions = Vec::new();

    // The native Claude and Codex installers use `~/.local/bin`, so prefer a
    // fresh app-installed CLI over an older package-manager copy.
    if let Some(home) = dirs::home_dir() {
        additions.push(home.join(".local").join("bin"));
    }
    additions.extend(STATIC_EXTRAS.iter().map(PathBuf::from));
    // Keep Cargo-installed shims available, but behind the native and system
    // package-manager locations above.
    if let Some(home) = dirs::home_dir() {
        additions.push(home.join(".cargo").join("bin"));
    }

    // Windows GUI-launched processes inherit a PATH that omits App Execution
    // Aliases (`WindowsApps` — where `winget` itself lives) and per-user
    // package shims. Seed them here; `late_dirs()` re-checks them live too.
    #[cfg(target_os = "windows")]
    additions.extend(windows_dynamic_dirs());

    prepend_search_dirs(&mut parts, additions);

    std::env::join_paths(parts).unwrap_or(current)
}

/// Add known install locations even when they do not exist yet. Installers can
/// create (notably) `~/.local/bin` after this process-wide PATH is cached; the
/// cached entry then becomes usable immediately without an app restart.
fn prepend_search_dirs(parts: &mut Vec<PathBuf>, additions: impl IntoIterator<Item = PathBuf>) {
    let additions = additions.into_iter().collect::<Vec<_>>();
    for p in additions.into_iter().rev() {
        if !parts.contains(&p) {
            // Prepend: user-installed CLIs should win over anything the
            // system might shim under `/usr/bin` (e.g. macOS's stub `git`).
            parts.insert(0, p);
        }
    }
}

/// Windows install/shim directories that the GUI-inherited PATH often
/// omits — and some that don't exist until a tool is installed (winget
/// creates `WinGet\Links` on its first package install). Listed
/// most-likely-first. Used both to seed the cached PATH and, via
/// `late_dirs()`, re-checked on every `resolve()` so a CLI installed
/// mid-session is found without an app restart.
#[cfg(target_os = "windows")]
fn windows_dynamic_dirs() -> Vec<PathBuf> {
    let mut v = Vec::new();
    if let Some(local) = dirs::data_local_dir() {
        // App Execution Aliases — `winget` itself + Store-installed CLIs.
        v.push(local.join("Microsoft").join("WindowsApps"));
        // winget's per-user shim dir for installed packages.
        v.push(local.join("Microsoft").join("WinGet").join("Links"));
        // User-scope installs.
        v.push(local.join("Programs").join("GitHub CLI"));
        v.push(local.join("Programs").join("Git").join("cmd"));
        // Official Codex standalone installer (per-user default).
        v.push(
            local
                .join("Programs")
                .join("OpenAI")
                .join("Codex")
                .join("bin"),
        );
    }
    if let Some(home) = dirs::home_dir() {
        v.push(home.join("scoop").join("shims"));
    }
    // Machine-scope installs under Program Files.
    for var in ["ProgramFiles", "ProgramFiles(x86)", "ProgramW6432"] {
        if let Some(pf) = std::env::var_os(var) {
            let pf = PathBuf::from(pf);
            v.push(pf.join("Git").join("cmd"));
            v.push(pf.join("GitHub CLI"));
            v.push(pf.join("GitLab").join("glab"));
        }
    }
    v
}

/// Directories probed on every `resolve()` in addition to the cached PATH.
/// On Windows these include dirs that may be created *after* the PATH
/// snapshot (e.g. winget's `WinGet\Links` on first install), so a CLI
/// installed during this session resolves without a restart. Empty
/// elsewhere — those platforms' static extras are already in the cache.
fn late_dirs() -> Vec<PathBuf> {
    #[cfg(target_os = "windows")]
    {
        windows_dynamic_dirs()
    }
    #[cfg(not(target_os = "windows"))]
    {
        Vec::new()
    }
}

/// Resolve `bin` to an absolute path. Checks the cached augmented PATH
/// first, then any `late_dirs()` (dirs that may have appeared since the
/// PATH was cached). Returns `None` if no matching executable exists.
pub fn resolve(bin: &str) -> Option<PathBuf> {
    for dir in std::env::split_paths(augmented_path()) {
        if let Some(found) = probe_dir(&dir, bin) {
            return Some(found);
        }
    }
    for dir in late_dirs() {
        if let Some(found) = probe_dir(&dir, bin) {
            return Some(found);
        }
    }
    None
}

/// Augmented PATH plus any live `late_dirs()` not already in it. Exported
/// to spawned children so a freshly-installed CLI — and that CLI's own
/// subprocess lookups — resolve without an app restart.
fn full_search_path() -> OsString {
    let mut parts: Vec<PathBuf> = std::env::split_paths(augmented_path()).collect();
    for d in late_dirs() {
        if !parts.contains(&d) && d.is_dir() {
            parts.push(d);
        }
    }
    std::env::join_paths(parts).unwrap_or_else(|_| augmented_path().clone())
}

/// The augmented PATH (plus any live `late_dirs()`) as it would be exported to
/// a spawned child. Exposed for spawn sites that build their own command rather
/// than going through `command()` — e.g. the pairing PTY, which uses
/// portable-pty's `CommandBuilder` and must set the child PATH itself.
pub fn search_path() -> OsString {
    full_search_path()
}

fn probe_dir(dir: &std::path::Path, bin: &str) -> Option<PathBuf> {
    #[cfg(windows)]
    {
        // Honor PATHEXT — Windows resolves `gh` to `gh.exe`/`gh.cmd`/etc.
        let pathext = std::env::var("PATHEXT").unwrap_or_else(|_| ".COM;.EXE;.BAT;.CMD".into());
        // Exact name first in case the caller passed `gh.exe`.
        let direct = dir.join(bin);
        if direct.is_file() {
            return Some(direct);
        }
        for ext in pathext.split(';').filter(|s| !s.is_empty()) {
            let mut name = bin.to_string();
            name.push_str(ext);
            let p = dir.join(&name);
            if p.is_file() {
                return Some(p);
            }
        }
        None
    }
    #[cfg(not(windows))]
    {
        let p = dir.join(bin);
        if p.is_file() && is_executable(&p) {
            Some(p)
        } else {
            None
        }
    }
}

#[cfg(unix)]
fn is_executable(p: &std::path::Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    std::fs::metadata(p)
        .map(|m| m.permissions().mode() & 0o111 != 0)
        .unwrap_or(false)
}

#[cfg(all(not(unix), not(windows)))]
fn is_executable(_p: &std::path::Path) -> bool {
    true
}

/// Build a `Command` for `bin`, ready to spawn. The command:
///   - uses the absolute resolved path (immune to GUI-launch PATH stripping);
///   - exports the augmented PATH to the child;
///   - nulls stdin so we don't accidentally inherit the parent's TTY.
///
/// Returns `AppError::Other` with an OS-appropriate install hint if the
/// binary isn't installed. The frontend renders the message verbatim, so
/// the user gets a real fix-it suggestion rather than `os error 2`.
pub fn command(bin: &str) -> Result<Command, AppError> {
    let Some(abs) = resolve(bin) else {
        return Err(AppError::Other(missing_message(bin)));
    };
    let mut cmd = Command::new(abs);
    cmd.env("PATH", full_search_path());
    cmd.stdin(Stdio::null());
    no_window(&mut cmd);
    Ok(cmd)
}

/// True if `bin` is on PATH. Cheap — same probe as `resolve`, just discards
/// the path. Use for "is the user's environment set up?" checks where we
/// don't actually need to spawn.
pub fn is_installed(bin: &str) -> bool {
    resolve(bin).is_some()
}

/// Suppress the console window Windows would otherwise pop for every
/// console-subsystem child (git, gh, winget, …). We capture their output,
/// so no window is ever needed — without this flag the app flashes a black
/// window per subprocess, which is especially ugly during the startup
/// fetch-all storm. No-op on non-Windows.
pub fn no_window(cmd: &mut Command) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    #[cfg(not(windows))]
    {
        let _ = cmd;
    }
}

/// Apply the standard "non-interactive network git" env to a Command:
///   - `GIT_TERMINAL_PROMPT=0` — disable git's own stdin prompts.
///   - `GCM_INTERACTIVE=Never` — block Git Credential Manager GUI dialogs
///     on Windows. No-op on platforms without GCM, so it's safe to set
///     unconditionally.
///   - `GIT_ASKPASS` / `SSH_ASKPASS` — point at a noop that exits 0
///     with no output, so any helper that falls back to askpass treats
///     the prompt as cancelled and bubbles a clean "no creds" error.
///
/// Bulk operations spawn dozens of git subprocesses concurrently — popping
/// a GUI cred dialog per repo would be unusable. We'd rather fail fast and
/// surface a single "run `gh auth setup-git`" message.
pub fn apply_no_prompt_env(cmd: &mut Command) {
    cmd.env("GIT_TERMINAL_PROMPT", "0")
        .env("GCM_INTERACTIVE", "Never");
    if let Some(p) = noop_askpass() {
        cmd.env("GIT_ASKPASS", &p).env("SSH_ASKPASS", &p);
    }
}

/// Path to a no-op askpass program. `/bin/true` on Unix; on Windows we
/// lazily materialize a tiny `.cmd` under the app's local data dir.
///
/// Returning `Option` rather than panicking: if we can't write the .cmd
/// (read-only profile, disk full, etc.) we'd rather skip the askpass env
/// vars than fail the whole git command. `GIT_TERMINAL_PROMPT=0` +
/// `GCM_INTERACTIVE=Never` still cover most prompt paths.
#[cfg(unix)]
fn noop_askpass() -> Option<PathBuf> {
    let p = PathBuf::from("/bin/true");
    if p.is_file() {
        Some(p)
    } else {
        None
    }
}

#[cfg(windows)]
fn noop_askpass() -> Option<PathBuf> {
    static CACHED: OnceLock<Option<PathBuf>> = OnceLock::new();
    CACHED
        .get_or_init(|| {
            // Git for Windows is mingw-built and its `spawnvpe` happily
            // invokes a `.cmd` via cmd.exe under the hood — no need for a
            // real .exe. The script ignores the prompt-text arg git passes
            // and just exits 0, which git interprets as "user cancelled".
            let dir = dirs::data_local_dir()?.join("Unity Vibe Studio");
            std::fs::create_dir_all(&dir).ok()?;
            let path = dir.join("noop_askpass.cmd");
            // Rewrite every run is cheap and self-heals a corrupted file.
            std::fs::write(&path, b"@exit /b 0\r\n").ok()?;
            Some(path)
        })
        .clone()
}

#[cfg(not(any(unix, windows)))]
fn noop_askpass() -> Option<PathBuf> {
    None
}

/// Run `cmd` to completion with a hard deadline, capturing stdout/stderr.
///
/// Drop-in replacement for `Command::output()` at every spawn site that
/// can't afford to hang (network git, credential helpers, package managers).
/// stdout/stderr are drained on dedicated threads so a chatty child can't
/// deadlock on a full pipe while we wait. On timeout the child is killed and
/// reaped — no zombies — and the caller gets a clear error naming the binary.
pub fn output_with_timeout(mut cmd: Command, timeout: Duration) -> Result<Output, AppError> {
    cmd.stdout(Stdio::piped());
    cmd.stderr(Stdio::piped());
    let name = cmd
        .get_program()
        .to_string_lossy()
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or("process")
        .to_string();

    let mut child = cmd
        .spawn()
        .map_err(|e| AppError::Other(format!("running {name} failed: {e}")))?;

    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    let out_handle = std::thread::spawn(move || read_to_end_capped(stdout));
    let err_handle = std::thread::spawn(move || read_to_end_capped(stderr));

    let deadline = Instant::now() + timeout;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) => {
                if Instant::now() >= deadline {
                    let _ = child.kill();
                    let _ = child.wait(); // reap — no zombie
                                          // Join the readers so their pipes close cleanly.
                    let _ = out_handle.join();
                    let _ = err_handle.join();
                    return Err(AppError::Other(format!(
                        "{name} timed out after {}s and was stopped",
                        timeout.as_secs()
                    )));
                }
                std::thread::sleep(Duration::from_millis(25));
            }
            Err(e) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(AppError::Other(format!("waiting on {name} failed: {e}")));
            }
        }
    };

    let stdout = out_handle.join().unwrap_or_default();
    let stderr = err_handle.join().unwrap_or_default();
    Ok(Output {
        status,
        stdout,
        stderr,
    })
}

/// Drain a child pipe to EOF, keeping at most the first 4 MiB. Output past
/// the cap is read and discarded (so the child never blocks on a full pipe)
/// but not stored — protects against a runaway child flooding memory.
fn read_to_end_capped<R: std::io::Read>(pipe: Option<R>) -> Vec<u8> {
    const CAP: usize = 4 * 1024 * 1024;
    let Some(mut pipe) = pipe else {
        return Vec::new();
    };
    let mut out = Vec::new();
    let mut buf = [0u8; 8192];
    loop {
        match pipe.read(&mut buf) {
            Ok(0) | Err(_) => break,
            Ok(n) => {
                if out.len() < CAP {
                    let take = n.min(CAP - out.len());
                    out.extend_from_slice(&buf[..take]);
                }
            }
        }
    }
    out
}

fn missing_message(bin: &str) -> String {
    format!(
        "{bin} is not installed or not on PATH — {}",
        install_hint(bin)
    )
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;

    #[test]
    fn known_search_dirs_are_kept_before_an_installer_creates_them() {
        let original = PathBuf::from("/system/bin");
        let future = PathBuf::from("/definitely/not/created/yet/.local/bin");
        let mut parts = vec![original.clone()];

        prepend_search_dirs(&mut parts, [future.clone()]);

        assert_eq!(parts, vec![future, original]);
    }

    #[test]
    fn known_search_dirs_are_not_duplicated() {
        let existing = PathBuf::from("/known/bin");
        let mut parts = vec![existing.clone()];

        prepend_search_dirs(&mut parts, [existing.clone()]);

        assert_eq!(parts, vec![existing]);
    }

    #[test]
    fn known_search_dirs_keep_their_declared_priority() {
        let first = PathBuf::from("/first/bin");
        let second = PathBuf::from("/second/bin");
        let original = PathBuf::from("/system/bin");
        let mut parts = vec![original.clone()];

        prepend_search_dirs(&mut parts, [first.clone(), second.clone()]);

        assert_eq!(parts, vec![first, second, original]);
    }

    #[test]
    fn output_with_timeout_captures_both_streams() {
        let mut cmd = Command::new("/bin/sh");
        cmd.args(["-c", "echo out; echo err >&2"]);
        let out = output_with_timeout(cmd, Duration::from_secs(5)).unwrap();
        assert!(out.status.success());
        assert_eq!(String::from_utf8_lossy(&out.stdout).trim(), "out");
        assert_eq!(String::from_utf8_lossy(&out.stderr).trim(), "err");
    }

    #[test]
    fn output_with_timeout_kills_on_deadline() {
        let mut cmd = Command::new("/bin/sh");
        cmd.args(["-c", "sleep 30"]);
        let start = Instant::now();
        let res = output_with_timeout(cmd, Duration::from_millis(200));
        assert!(res.is_err(), "expected timeout error");
        assert!(
            start.elapsed() < Duration::from_secs(5),
            "child was not killed promptly"
        );
        assert!(res.unwrap_err().to_string().contains("timed out"));
    }

    #[test]
    fn output_with_timeout_reports_failure_status() {
        let mut cmd = Command::new("/bin/sh");
        cmd.args(["-c", "exit 3"]);
        let out = output_with_timeout(cmd, Duration::from_secs(5)).unwrap();
        assert!(!out.status.success());
    }
}

fn install_hint(bin: &str) -> &'static str {
    match bin {
        "gh" => {
            #[cfg(target_os = "macos")]
            {
                "install with `brew install gh`"
            }
            #[cfg(target_os = "linux")]
            {
                "see https://github.com/cli/cli#installation"
            }
            #[cfg(target_os = "windows")]
            {
                "install with `winget install GitHub.cli`"
            }
        }
        "glab" => {
            #[cfg(target_os = "macos")]
            {
                "install with `brew install glab`"
            }
            #[cfg(target_os = "linux")]
            {
                "see https://gitlab.com/gitlab-org/cli#installation"
            }
            #[cfg(target_os = "windows")]
            {
                "install with `winget install glab.glab`"
            }
        }
        "git" => {
            #[cfg(target_os = "macos")]
            {
                "install Xcode Command Line Tools (`xcode-select --install`) or run `brew install git`"
            }
            #[cfg(target_os = "linux")]
            {
                "install via your package manager (e.g. `apt install git`)"
            }
            #[cfg(target_os = "windows")]
            {
                "install with `winget install Git.Git`"
            }
        }
        _ => "please install it and make sure it's on your PATH",
    }
}
