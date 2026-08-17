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
        additions.extend(node_manager_dirs(&home));
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

    // Dirs discovered from the live environment go last — after the static
    // extras have taken their priority above. They exist to add reach for
    // setups the static list can't predict, never to reorder what already
    // resolved: merging them earlier would let `/usr/bin`'s stub git outrank
    // Homebrew's, which is the precedence the prepend above exists to prevent.
    append_search_dirs(&mut parts, live_env_dirs());

    std::env::join_paths(parts).unwrap_or(current)
}

/// Node version managers put `claude`/`codex` — both npm packages — under a
/// per-user prefix that a GUI-launched process never inherits. None of these
/// need to exist; `prepend_search_dirs` keeps them so an install that happens
/// later in the session still resolves.
fn node_manager_dirs(home: &std::path::Path) -> Vec<PathBuf> {
    let mut v = nvm_bin_dirs(home);
    v.push(home.join(".volta").join("bin"));
    v.push(home.join(".asdf").join("shims"));
    v.push(home.join(".local").join("share").join("mise").join("shims"));
    v.push(home.join(".npm-global").join("bin"));
    // fnm's real PATH entry is a per-shell dir under `fnm_multishells` that is
    // gone the moment that shell exits, so aim at the stable `default` alias.
    #[cfg(target_os = "macos")]
    {
        v.push(
            home.join("Library")
                .join("Application Support")
                .join("fnm")
                .join("aliases")
                .join("default")
                .join("bin"),
        );
        v.push(home.join("Library").join("pnpm"));
    }
    v.push(
        home.join(".fnm")
            .join("aliases")
            .join("default")
            .join("bin"),
    );
    #[cfg(not(target_os = "macos"))]
    v.push(home.join(".local").join("share").join("pnpm"));
    v
}

/// nvm's per-version bin dirs, newest first — an upgrade must not leave us
/// pinned to whichever version happens to sort first as a string.
fn nvm_bin_dirs(home: &std::path::Path) -> Vec<PathBuf> {
    let Ok(entries) = std::fs::read_dir(home.join(".nvm").join("versions").join("node")) else {
        return Vec::new();
    };
    let mut versions: Vec<(Vec<u64>, PathBuf)> = entries
        .flatten()
        .map(|e| (version_key(&e.file_name().to_string_lossy()), e.path()))
        .collect();
    versions.sort_by(|a, b| b.0.cmp(&a.0));
    versions.into_iter().map(|(_, p)| p.join("bin")).collect()
}

/// `v22.11.0` → `[22, 11, 0]`, so versions compare numerically (`v9` < `v22`).
fn version_key(name: &str) -> Vec<u64> {
    name.trim_start_matches('v')
        .split('.')
        .map(|part| part.parse().unwrap_or(0))
        .collect()
}

/// Search dirs read out of the live environment rather than guessed. Kept to
/// existing directories: unlike our own static list these are parsed from
/// external output, so a malformed entry should be dropped, not carried.
fn live_env_dirs() -> Vec<PathBuf> {
    #[cfg(unix)]
    {
        login_shell_path()
    }
    #[cfg(target_os = "windows")]
    {
        registry_user_path()
    }
    #[cfg(not(any(unix, target_os = "windows")))]
    {
        Vec::new()
    }
}

/// The PATH the user's login shell builds. Static lists can't cover every
/// setup — custom npm prefixes, `direnv`, corporate dotfiles — and the shell is
/// the only thing that knows all of them. Best-effort: any failure or timeout
/// leaves us with the static list alone.
///
/// Runs once per process, on the first `resolve()`. `-l` (not `-i`) so profile
/// files run without an interactive shell's prompts or job control; a shell
/// that hangs anyway is killed at the deadline.
#[cfg(unix)]
fn login_shell_path() -> Vec<PathBuf> {
    const SHELL_PATH_TIMEOUT: Duration = Duration::from_secs(3);
    let shell = std::env::var_os("SHELL").unwrap_or_else(|| OsString::from("/bin/sh"));
    // fish joins "$PATH" with spaces, so it needs its own join; every POSIX
    // shell takes the printf form.
    let is_fish = PathBuf::from(&shell)
        .file_name()
        .is_some_and(|n| n == "fish");
    let script = if is_fish { "string join : $PATH" } else { "printf %s \"$PATH\"" };
    let mut cmd = Command::new(shell);
    cmd.args(["-lc", script]);
    cmd.stdin(Stdio::null());
    let Ok(out) = output_with_timeout(cmd, SHELL_PATH_TIMEOUT) else {
        return Vec::new();
    };
    if !out.status.success() {
        return Vec::new();
    }
    std::env::split_paths(String::from_utf8_lossy(&out.stdout).trim())
        .filter(|p| p.is_absolute() && p.is_dir())
        .collect()
}

/// The user's `Path` as the registry has it now. A Windows GUI process
/// inherits the environment Explorer held at login, so anything an installer
/// added since — however loudly it broadcast `WM_SETTINGCHANGE` — is invisible
/// to us until the user logs out. Shelled out to `reg` rather than taking a
/// registry crate for one read.
#[cfg(target_os = "windows")]
fn registry_user_path() -> Vec<PathBuf> {
    const REG_TIMEOUT: Duration = Duration::from_secs(3);
    let mut cmd = Command::new("reg");
    cmd.args(["query", "HKCU\\Environment", "/v", "Path"]);
    cmd.stdin(Stdio::null());
    no_window(&mut cmd);
    let Ok(out) = output_with_timeout(cmd, REG_TIMEOUT) else {
        return Vec::new();
    };
    if !out.status.success() {
        return Vec::new();
    }
    parse_reg_path_value(&String::from_utf8_lossy(&out.stdout))
}

/// Pull the value out of `reg query … /v Path` output, which looks like
/// `    Path    REG_EXPAND_SZ    C:\a;C:\b`. Values of type `REG_EXPAND_SZ`
/// keep their `%VAR%` placeholders unexpanded, so expand them here.
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
fn parse_reg_path_value(stdout: &str) -> Vec<PathBuf> {
    let Some(value) = stdout.lines().find_map(|line| {
        let (name, rest) = line.trim().split_once(char::is_whitespace)?;
        if !name.eq_ignore_ascii_case("Path") {
            return None;
        }
        let (_type, value) = rest.trim_start().split_once(char::is_whitespace)?;
        Some(value.trim())
    }) else {
        return Vec::new();
    };
    value
        .split(';')
        .map(str::trim)
        .filter(|entry| !entry.is_empty())
        .map(|entry| PathBuf::from(expand_env_placeholders(entry)))
        .filter(|p| p.is_dir())
        .collect()
}

/// Substitute `%VAR%` from the process environment. An unset or malformed
/// placeholder is left verbatim — the entry then fails the `is_dir` check
/// above rather than silently becoming a wrong path.
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
fn expand_env_placeholders(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    let mut rest = value;
    while let Some(start) = rest.find('%') {
        out.push_str(&rest[..start]);
        let after = &rest[start + 1..];
        match after.find('%').and_then(|end| {
            std::env::var(&after[..end])
                .ok()
                .map(|v| (v, &after[end + 1..]))
        }) {
            Some((expanded, tail)) => {
                out.push_str(&expanded);
                rest = tail;
            }
            None => {
                out.push('%');
                rest = after;
            }
        }
    }
    out.push_str(rest);
    out
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

/// Add dirs at the end, skipping any already present. The mirror of
/// `prepend_search_dirs`, for dirs that must extend the search without
/// outranking the install locations we know by name.
fn append_search_dirs(parts: &mut Vec<PathBuf>, additions: impl IntoIterator<Item = PathBuf>) {
    for p in additions {
        if !parts.contains(&p) {
            parts.push(p);
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
    if let Some(roaming) = dirs::data_dir() {
        // Where `npm install -g` writes its shims — including `claude.cmd` and
        // `codex.cmd` — for a per-user Node.
        v.push(roaming.join("npm"));
    }
    if let Some(home) = dirs::home_dir() {
        v.push(home.join("scoop").join("shims"));
    }
    // Machine-scope installs under Program Files.
    for var in ["ProgramFiles", "ProgramFiles(x86)", "ProgramW6432"] {
        if let Some(pf) = std::env::var_os(var) {
            let pf = PathBuf::from(pf);
            v.push(pf.join("nodejs"));
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

/// Windows reports a failed process *startup* as an NTSTATUS exit code: the
/// child never reached `main`, so it wrote nothing to stdout/stderr that could
/// explain itself. Translate the three we can act on; everything else is an
/// ordinary exit code and returns `None`.
///
/// `label` names the program for the message ("Claude Code", "Codex CLI").
pub fn launch_failure(label: &str, exit_code: u32) -> Option<String> {
    let cause = match exit_code {
        // STATUS_DLL_INIT_FAILED — a DLL's init refused, or (for a console
        // program) it could not attach to its console.
        0xC000_0142 => "Windows stopped it before it could start (0xC0000142)",
        // STATUS_DLL_NOT_FOUND
        0xC000_0135 => "a library it needs is missing (0xC0000135)",
        // STATUS_INVALID_IMAGE_FORMAT
        0xC000_007B => "its program file is damaged or built for another CPU (0xC000007B)",
        _ => return None,
    };
    Some(format!(
        "{label} is installed, but {cause}. Security software blocking it or a \
         damaged install are the usual causes."
    ))
}

/// Stop Windows popping a modal "Application Error" box when a child process
/// fails to initialize. Children inherit the parent's error mode, so without
/// this a broken CLI hangs — alive but blocked on a dialog behind our window —
/// and every deadline we have has to run out before the user learns anything.
/// With it the child dies immediately and we report its exit code ourselves.
///
/// Trade-off: this also suppresses the crash box for the app itself. Panics
/// already go to the log file via the panic hook, so nothing is lost.
pub fn fail_child_startup_errors_silently() {
    #[cfg(windows)]
    {
        const SEM_FAILCRITICALERRORS: u32 = 0x0001;
        const SEM_NOGPFAULTERRORBOX: u32 = 0x0002;
        // kernel32, already linked into every process.
        extern "system" {
            fn SetErrorMode(mode: u32) -> u32;
        }
        unsafe { SetErrorMode(SEM_FAILCRITICALERRORS | SEM_NOGPFAULTERRORBOX) };
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
            let dir = dirs::data_local_dir()?.join("Foundry for Godot");
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

#[cfg(test)]
mod launch_status_tests {
    use super::*;

    #[test]
    fn startup_failures_are_named_not_shown_as_an_exit_code() {
        let msg = launch_failure("Claude Code", 0xC000_0142).expect("dll-init is a launch failure");
        assert!(msg.contains("0xC0000142"));
        assert!(msg.contains("Claude Code"));
        assert!(launch_failure("Claude Code", 0xC000_0135).is_some());
        assert!(launch_failure("Claude Code", 0xC000_007B).is_some());
    }

    #[test]
    fn ordinary_exit_codes_are_left_alone() {
        for code in [0, 1, 2, 127] {
            assert!(launch_failure("Claude Code", code).is_none(), "{code}");
        }
    }
}

#[cfg(test)]
mod path_discovery_tests {
    use super::*;

    #[test]
    fn node_versions_compare_numerically_not_as_strings() {
        assert!(version_key("v22.11.0") > version_key("v9.9.9"));
        assert!(version_key("v20.1.0") > version_key("v20.0.9"));
    }

    #[test]
    fn nvm_dirs_are_offered_newest_version_first() {
        let home = std::env::temp_dir().join(format!("proc-nvm-{}", nanoid::nanoid!()));
        let root = home.join(".nvm").join("versions").join("node");
        for version in ["v9.9.9", "v22.11.0", "v20.1.0"] {
            std::fs::create_dir_all(root.join(version).join("bin")).unwrap();
        }

        assert_eq!(
            nvm_bin_dirs(&home),
            vec![
                root.join("v22.11.0").join("bin"),
                root.join("v20.1.0").join("bin"),
                root.join("v9.9.9").join("bin"),
            ]
        );
        std::fs::remove_dir_all(&home).unwrap();
    }

    #[test]
    fn a_registry_path_keeps_real_dirs_and_drops_the_rest() {
        let real = std::env::temp_dir();
        let stdout = format!(
            "\r\nHKEY_CURRENT_USER\\Environment\r\n    Path    REG_EXPAND_SZ    {};C:\\Nope\\Missing\r\n\r\n",
            real.display()
        );
        assert_eq!(parse_reg_path_value(&stdout), vec![real]);
        assert!(parse_reg_path_value("no value here").is_empty());
    }

    #[test]
    fn registry_placeholders_expand_only_when_the_variable_exists() {
        assert!(!expand_env_placeholders("%PATH%\\npm").contains("%PATH%"));
        assert_eq!(
            expand_env_placeholders("%NOT_A_REAL_VAR_9F2%\\npm"),
            "%NOT_A_REAL_VAR_9F2%\\npm"
        );
        assert_eq!(expand_env_placeholders("C:\\plain"), "C:\\plain");
    }

    #[test]
    fn a_missing_agent_cli_explains_the_terminal_only_install() {
        for bin in ["claude", "codex"] {
            let msg = missing_message(bin);
            assert!(msg.contains("npm install -g"), "{msg}");
            assert!(msg.contains("terminal"), "{msg}");
        }
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;

    #[test]
    fn the_login_shell_path_yields_only_usable_dirs() {
        // Runs the real `$SHELL`. We can't assert *which* dirs come back, but
        // every one of them must be something we could actually search.
        let dirs = login_shell_path();
        assert!(!dirs.is_empty(), "a login shell should report some PATH");
        assert!(dirs.iter().all(|p| p.is_absolute() && p.is_dir()));
    }

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
    fn dirs_found_in_the_environment_never_outrank_the_known_install_locations() {
        let homebrew = PathBuf::from("/opt/homebrew/bin");
        let system = PathBuf::from("/usr/bin");
        let custom = PathBuf::from("/custom/prefix/bin");
        let mut parts = vec![system.clone()];

        // The order `build_augmented_path` uses: static list first, then
        // whatever the login shell reported. The shell also lists Homebrew, and
        // that must not demote it below `/usr/bin` and its stub tools.
        prepend_search_dirs(&mut parts, [homebrew.clone()]);
        append_search_dirs(&mut parts, [homebrew.clone(), custom.clone()]);

        assert_eq!(parts, vec![homebrew, system, custom]);
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
        // Both agent CLIs ship as npm packages, so the hint is the same
        // everywhere. They are also the two binaries users most often have
        // installed already but only in a shell we can't see.
        "claude" => {
            "install with `npm install -g @anthropic-ai/claude-code`, or see \
             https://claude.com/claude-code. If it already works in your terminal, this app \
             isn't seeing the PATH your shell sets up — reinstalling it from a terminal usually fixes that"
        }
        "codex" => {
            "install with `npm install -g @openai/codex`. If it already works in your terminal, \
             this app isn't seeing the PATH your shell sets up — reinstalling it from a terminal \
             usually fixes that"
        }
        _ => "please install it and make sure it's on your PATH",
    }
}
