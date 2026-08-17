//! Hidden-PTY driver for the company-account pairing flow.
//!
//! We run
//! `claude setup-token` in a hidden PTY (it refuses to run without a TTY), scan
//! its output for the OAuth URL, show the employee a "send this link to your
//! admin" screen, take back the one-time code the admin returns, and type it
//! into the PTY. The command prints (but does not save) a long-lived OAuth token,
//! so we store it in the OS credential store and inject it only into app-launched
//! Claude processes. It is never emitted or logged.
//!
//! Observed `claude setup-token` output (CLI 2.1.198, macOS), which drove the
//! parser design:
//!   - Auth URL host is **`claude.com`** (`https://claude.com/cai/oauth/authorize
//!     ?…&redirect_uri=https%3A%2F%2Fplatform.claude.com%2F…`) — NOT claude.ai.
//!   - The CLI hard-wraps the URL at the PTY width. We therefore open a very
//!     wide PTY (1000 cols) so the ~230-char URL lands on ONE line; extraction
//!     then only trusts a URL on a newline-terminated (complete) line, so a URL
//!     split across two `read()`s is never captured half-formed.
//!   - It prints "Paste code here if prompted >" — matched for `prompt_seen`.
//!   - It tries to auto-open a browser ("Opening browser to sign in…"); we set
//!     `BROWSER` to a no-op on unix to discourage that (best-effort; macOS may
//!     still open it — harmless, the employee is told to forward the link).
//!
//! Threading mirrors the terminal manager: one reader thread owns the whole
//! lifecycle (read loop → child exit → outcome), a watchdog thread enforces the
//! 10-minute cap, and writes go through a per-session locked writer. At most one
//! pairing is active at a time.

use crate::error::{AppError, AppResult};
use portable_pty::{native_pty_system, CommandBuilder, PtySize};
use serde::Serialize;
use std::io::{Read, Write};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{AppHandle, Emitter};

mod parse;
pub use parse::verify_subscription_status;
use parse::{
    failure_reason, find_oauth_url, find_token, looks_like_prompt, redact_tokens, strip_ansi, tail,
};

/// A very wide PTY so the CLI never wraps the (~230 char) OAuth URL across
/// lines — see module docs. Height is irrelevant for a hidden PTY.
const PTY_COLS: u16 = 1000;
const PTY_ROWS: u16 = 50;

/// Overall pairing deadline. The admin has to open the link, approve, and send
/// a code back — generous, but finite so a walked-away pairing can't leak a
/// child process forever.
const OVERALL_TIMEOUT: Duration = Duration::from_secs(600);

/// How long we wait for the CLI's *first byte* before giving up. A child that
/// dies during process startup (Windows blocking it, a damaged install) can
/// leave the pty silent but open, and `OVERALL_TIMEOUT` is far too long to sit
/// on a "Preparing…" spinner that is never going to move.
const STARTUP_TIMEOUT: Duration = Duration::from_secs(45);

/// How long after code submission we let `claude setup-token` linger before
/// killing it on purpose and letting the candidate-token check decide. The CLI keeps
/// its TUI open after a successful login (observed live), so "wait for exit"
/// alone would hang until OVERALL_TIMEOUT and then wrongly report failure.
const POST_SUBMIT_GRACE_SECS: u64 = 90;

/// The way out when this machine can't run `claude setup-token` at all: the
/// CLI's own sign-in works from a normal terminal, and Studio accepts that
/// login on its next start (`verify_cli_subscription`).
const MANUAL_SIGN_IN_HINT: &str =
    "You can sign in without this screen: run `claude auth login --claudeai` in a terminal, then reopen the app.";

const SILENT_START_MESSAGE: &str = "Claude started but never responded, so pairing was stopped.";

/// Bytes of ANSI-stripped tail kept for the "Show details" escape hatch on a
/// failed pairing.
const RAW_TAIL_BYTES: usize = 2048;

/// Transcript cap — we only ever need the URL/token/prompt, which appear early,
/// but the accumulated buffer must stay bounded against a chatty CLI.
const TRANSCRIPT_CAP: usize = 64 * 1024;

/// The pairing state machine, mirrored to the UI on every transition via the
/// `pairing:update` event (and readable on demand via `snapshot()`).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PairingState {
    pub phase: Phase,
    /// The OAuth URL to forward to the admin (set at `AwaitingAdmin`).
    pub oauth_url: Option<String>,
    /// `"app_managed_oauth"` on success. The token is never exposed to the
    /// webview.
    pub mode: Option<String>,
    /// Friendly failure message (set at `Failed`).
    pub error: Option<String>,
    /// Last ~2KB of ANSI-stripped output, for the failure "Show details" pane.
    pub raw_tail: Option<String>,
    /// True once the CLI has prompted for the code — lets the UI enable the
    /// input deterministically (belt-and-suspenders; it's enabled on URL too).
    pub prompt_seen: bool,
    /// Id of the active pairing, echoed back in `submit_code`.
    pub pairing_id: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Phase {
    Idle,
    Starting,
    AwaitingAdmin,
    Submitting,
    Verifying,
    Paired,
    Failed,
}

impl PairingState {
    fn idle() -> Self {
        Self {
            phase: Phase::Idle,
            oauth_url: None,
            mode: None,
            error: None,
            raw_tail: None,
            prompt_seen: false,
            pairing_id: None,
        }
    }
}

/// One live pairing: the locked writer and killable child.
struct Active {
    id: String,
    writer: Arc<Mutex<Box<dyn Write + Send>>>,
    child: Arc<Mutex<Box<dyn portable_pty::Child + Send + Sync>>>,
    cancelled: Arc<AtomicBool>,
    finished: Arc<AtomicBool>,
    /// We killed the child ON PURPOSE (token already captured, or post-submit
    /// grace expired) — resolve the outcome via the verify probe instead of the
    /// exit status. `claude setup-token` keeps its TUI open after a successful
    /// login (observed live, CLI 2.1.198), so waiting for a clean exit hangs.
    intentional: Arc<AtomicBool>,
}

/// Shared behind an `Arc` so the reader/watchdog threads can publish state and
/// deregister themselves. Held in `AppState`.
#[derive(Clone, Default)]
pub struct PairingManager {
    shared: Arc<Shared>,
}

#[derive(Default)]
struct Shared {
    active: Mutex<Option<Active>>,
    state: Mutex<Option<PairingState>>,
}

impl Shared {
    /// Mutate the canonical state and emit the snapshot. Single publish path so
    /// the on-demand `snapshot()` and the event stream can never disagree.
    fn publish(&self, app: &AppHandle, next: PairingState) {
        *self.state.lock().unwrap_or_else(|e| e.into_inner()) = Some(next.clone());
        let _ = app.emit("pairing:update", &next);
    }

    fn clear_active_if(&self, id: &str) {
        let mut active = self.active.lock().unwrap_or_else(|e| e.into_inner());
        take_if(&mut active, |candidate| candidate.id == id);
    }

    fn publish_if_active(&self, app: &AppHandle, id: &str, next: PairingState) -> bool {
        let active = self.active.lock().unwrap_or_else(|e| e.into_inner());
        if !active.as_ref().is_some_and(|candidate| candidate.id == id) {
            return false;
        }
        self.publish(app, next);
        true
    }

    fn finish_if_active(&self, app: &AppHandle, id: &str, next: PairingState) -> bool {
        let mut active = self.active.lock().unwrap_or_else(|e| e.into_inner());
        if !active.as_ref().is_some_and(|candidate| candidate.id == id) {
            return false;
        }
        self.publish(app, next);
        active.take();
        true
    }

    fn store_token_if_active(&self, id: &str, token: &str) -> AppResult<bool> {
        let active = self.active.lock().unwrap_or_else(|e| e.into_inner());
        if !active.as_ref().is_some_and(|candidate| candidate.id == id) {
            return Ok(false);
        }
        crate::claudeauth::store_oauth_token(token)?;
        Ok(true)
    }
}

impl PairingManager {
    /// Start a pairing. Kills any pre-existing one (start-over safety), spawns
    /// `claude setup-token` in a hidden wide PTY, and returns the pairing id.
    pub fn start(&self, app: AppHandle) -> AppResult<String> {
        // At most one active pairing — replace any leftover.
        self.kill_active();

        let pty = native_pty_system();
        let pair = pty
            .openpty(PtySize {
                rows: PTY_ROWS,
                cols: PTY_COLS,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| AppError::Other(format!("openpty: {e}")))?;

        let Some(claude) = crate::proc::resolve("claude") else {
            return Err(AppError::Other(
                "The Claude CLI couldn't be found. Please install it, then try again.".into(),
            ));
        };

        let mut cmd = CommandBuilder::new(claude);
        cmd.arg("--setting-sources");
        cmd.arg("");
        cmd.arg("--settings");
        cmd.arg(crate::claudeauth::pairing_settings_json()?);
        cmd.arg("setup-token");
        if let Some(home) = dirs::home_dir() {
            cmd.cwd(home);
        }
        // CommandBuilder clears env on Windows; pass the parent env through as-is,
        // then override only the terminal setup. We skip COLUMNS/LINES so a stray
        // parent value can't re-introduce URL wrapping (we rely on the wide PTY
        // winsize below).
        for (k, v) in std::env::vars() {
            if matches!(
                k.as_str(),
                "TERM" | "PATH" | "BROWSER" | "COLUMNS" | "LINES"
            ) || crate::claudeauth::is_isolated_var(&k)
            {
                continue;
            }
            cmd.env(k, v);
        }
        // CommandBuilder seeds a base environment before the loop above, so
        // explicitly remove provider keys as well as skipping manual copies.
        crate::claudeauth::scrub_pty_credentials(&mut cmd);
        cmd.env("TERM", "xterm-256color");
        cmd.env("PATH", crate::proc::search_path());
        // Discourage the CLI from auto-opening a browser on the employee's box
        // (best-effort; see module docs).
        #[cfg(unix)]
        cmd.env("BROWSER", "/usr/bin/true");

        let child = pair
            .slave
            .spawn_command(cmd)
            .map_err(|e| AppError::Other(format!("could not start Claude: {e}")))?;
        // Slave dropped here so the master reader sees EOF when the child exits.

        let reader = pair
            .master
            .try_clone_reader()
            .map_err(|e| AppError::Other(format!("clone reader: {e}")))?;
        let writer = pair
            .master
            .take_writer()
            .map_err(|e| AppError::Other(format!("take writer: {e}")))?;

        let id = nanoid::nanoid!(10);
        let cancelled = Arc::new(AtomicBool::new(false));
        let timed_out = Arc::new(AtomicBool::new(false));
        let never_started = Arc::new(AtomicBool::new(false));
        let saw_output = Arc::new(AtomicBool::new(false));
        let finished = Arc::new(AtomicBool::new(false));
        let intentional = Arc::new(AtomicBool::new(false));
        let child = Arc::new(Mutex::new(child));

        *self.shared.active.lock().unwrap_or_else(|e| e.into_inner()) = Some(Active {
            id: id.clone(),
            writer: Arc::new(Mutex::new(writer)),
            child: child.clone(),
            cancelled: cancelled.clone(),
            finished: finished.clone(),
            intentional: intentional.clone(),
        });

        let mut starting = PairingState::idle();
        starting.phase = Phase::Starting;
        starting.pairing_id = Some(id.clone());
        self.shared.publish_if_active(&app, &id, starting);
        log::info!("pairing {id}: started setup-token");

        spawn_watchdog(
            child.clone(),
            finished.clone(),
            timed_out.clone(),
            saw_output.clone(),
            never_started.clone(),
        );
        self.spawn_reader(
            app,
            reader,
            child,
            id.clone(),
            cancelled,
            timed_out,
            never_started,
            saw_output,
            finished,
            intentional,
        );

        Ok(id)
    }

    /// Type the admin's one-time code into the PTY. Appends the platform newline
    /// so the CLI's line-reader accepts it, then moves to `Submitting`.
    pub fn submit_code(&self, app: AppHandle, pairing_id: &str, code: &str) -> AppResult<()> {
        let (writer, child, cancelled, finished, intentional) = {
            let guard = self.shared.active.lock().unwrap_or_else(|e| e.into_inner());
            match guard.as_ref() {
                Some(a) if a.id == pairing_id => (
                    a.writer.clone(),
                    a.child.clone(),
                    a.cancelled.clone(),
                    a.finished.clone(),
                    a.intentional.clone(),
                ),
                _ => return Err(AppError::Other("This pairing is no longer active.".into())),
            }
        };
        // ConPTY wants CRLF; a real pty on unix takes CR as Enter.
        #[cfg(windows)]
        let line = format!("{}\r\n", code.trim());
        #[cfg(not(windows))]
        let line = format!("{}\r", code.trim());

        let mut w = writer.lock().unwrap_or_else(|e| e.into_inner());
        w.write_all(line.as_bytes())
            .map_err(|e| AppError::Other(format!("could not submit code: {e}")))?;
        w.flush()
            .map_err(|e| AppError::Other(format!("could not submit code: {e}")))?;
        drop(w);

        // Preserve the URL/prompt fields already in state.
        if let Some(mut st) = self.snapshot() {
            st.phase = Phase::Submitting;
            self.shared.publish_if_active(&app, pairing_id, st);
        }
        log::info!("pairing {pairing_id}: code submitted");

        // The CLI accepts the code, prints the setup token, and can keep the TUI
        // open rather than exiting. The reader resolves as soon as it captures
        // that token; this watchdog prevents a changed or malformed CLI output
        // from leaving pairing stuck indefinitely.
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_secs(POST_SUBMIT_GRACE_SECS));
            if !finished.load(Ordering::SeqCst) && !cancelled.load(Ordering::SeqCst) {
                log::info!("pairing: post-submit grace expired; resolving via verify probe");
                intentional.store(true, Ordering::SeqCst);
                let _ = child.lock().unwrap_or_else(|e| e.into_inner()).kill();
            }
        });
        Ok(())
    }

    /// Cancel the active pairing (kills the child; the reader exits quietly) and
    /// return to `Idle`.
    pub fn cancel(&self, app: AppHandle) {
        self.kill_active();
        self.shared.publish(&app, PairingState::idle());
    }

    /// Latest known state, for the UI to reconcile after a reload/reopen.
    pub fn snapshot(&self) -> Option<PairingState> {
        self.shared
            .state
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone()
    }

    /// Kill and forget any active pairing. Marks it cancelled first so its
    /// reader emits nothing on the resulting EOF.
    fn kill_active(&self) {
        let active = self
            .shared
            .active
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .take();
        if let Some(active) = active {
            active.cancelled.store(true, Ordering::SeqCst);
            let mut child = active.child.lock().unwrap_or_else(|e| e.into_inner());
            let _ = child.kill();
        }
    }

    #[allow(clippy::too_many_arguments)]
    fn spawn_reader(
        &self,
        app: AppHandle,
        mut reader: Box<dyn Read + Send>,
        child: Arc<Mutex<Box<dyn portable_pty::Child + Send + Sync>>>,
        id: String,
        cancelled: Arc<AtomicBool>,
        timed_out: Arc<AtomicBool>,
        never_started: Arc<AtomicBool>,
        saw_output: Arc<AtomicBool>,
        finished: Arc<AtomicBool>,
        intentional: Arc<AtomicBool>,
    ) {
        let shared = self.shared.clone();
        std::thread::spawn(move || {
            let mut buf = [0u8; 8192];
            let mut pending: Vec<u8> = Vec::new();
            let mut transcript = String::new();
            let mut url_seen = false;
            let mut prompt_seen = false;
            let mut token_seen = false;
            let mut captured_token: Option<SetupTokenCandidate> = None;
            let mut oauth_url: Option<String> = None;

            loop {
                match reader.read(&mut buf) {
                    Ok(0) => break,
                    Ok(n) => {
                        // A cancel / start-over already published a fresh state
                        // (or Idle) — stop so this dying reader can't clobber it.
                        if cancelled.load(Ordering::SeqCst) {
                            break;
                        }
                        saw_output.store(true, Ordering::SeqCst);
                        pending.extend_from_slice(&buf[..n]);
                        // Emit only the longest valid-UTF-8 prefix; keep any
                        // trailing partial codepoint for the next read.
                        let valid = match std::str::from_utf8(&pending) {
                            Ok(_) => pending.len(),
                            Err(e) => e.valid_up_to(),
                        };
                        if valid > 0 {
                            transcript.push_str(&String::from_utf8_lossy(&pending[..valid]));
                            pending.drain(..valid);
                        }
                        // Safety net for a stream that never forms valid UTF-8.
                        if pending.len() > 16 * 1024 {
                            transcript.push_str(&String::from_utf8_lossy(&pending));
                            pending.clear();
                        }
                        cap_front(&mut transcript, TRANSCRIPT_CAP);

                        if !url_seen {
                            if let Some(url) = find_oauth_url(&transcript) {
                                url_seen = true;
                                oauth_url = Some(url.clone());
                                let mut st = PairingState::idle();
                                st.phase = Phase::AwaitingAdmin;
                                st.pairing_id = Some(id.clone());
                                st.oauth_url = Some(url);
                                st.prompt_seen = prompt_seen;
                                shared.publish_if_active(&app, &id, st);
                            }
                        }
                        if !prompt_seen && looks_like_prompt(&transcript) {
                            prompt_seen = true;
                            // Only surface once we already have a URL to show.
                            if url_seen {
                                let mut st = PairingState::idle();
                                st.phase = Phase::AwaitingAdmin;
                                st.pairing_id = Some(id.clone());
                                st.oauth_url = oauth_url.clone();
                                st.prompt_seen = true;
                                shared.publish_if_active(&app, &id, st);
                            }
                        }
                        if !token_seen {
                            let Some(token) = find_token(&transcript) else {
                                continue;
                            };
                            token_seen = true;
                            captured_token = Some(SetupTokenCandidate::captured(token));
                            log::info!("pairing {id}: exchange succeeded; resolving early");
                            intentional.store(true, Ordering::SeqCst);
                            let mut st = PairingState::idle();
                            st.phase = Phase::Verifying;
                            st.pairing_id = Some(id.clone());
                            st.oauth_url = oauth_url.clone();
                            st.prompt_seen = prompt_seen;
                            shared.publish_if_active(&app, &id, st);
                            let _ = child.lock().unwrap_or_else(|e| e.into_inner()).kill();
                        }
                    }
                    Err(_) => break,
                }
            }

            finished.store(true, Ordering::SeqCst);
            let status = child.lock().unwrap_or_else(|e| e.into_inner()).wait();
            let exit_code = status.as_ref().ok().map(|s| s.exit_code());

            // A cancel/start-over already published Idle — say nothing more.
            if cancelled.load(Ordering::SeqCst) {
                shared.clear_active_if(&id);
                return;
            }

            let stripped = redact_tokens(&strip_ansi(&transcript));
            let raw_tail = tail(&stripped, RAW_TAIL_BYTES);
            let did_timeout = timed_out.load(Ordering::SeqCst);
            // An intentional kill (token captured, or post-submit grace) is a
            // success path: the candidate-token check is the honest arbiter, not the
            // exit status of a child we killed ourselves.
            let intentional_finish = intentional.load(Ordering::SeqCst);
            let exit_ok = intentional_finish
                || (status.map(|s| s.success()).unwrap_or(false) && !did_timeout);

            let outcome = if exit_ok {
                captured_token
                    .as_ref()
                    .map(|token| resolve_outcome(token, &shared, &id))
                    .unwrap_or_else(|| {
                        Outcome::Failed("Claude finished pairing without returning a token.".into())
                    })
            } else if never_started.load(Ordering::SeqCst) {
                Outcome::Failed(format!("{SILENT_START_MESSAGE} {MANUAL_SIGN_IN_HINT}"))
            } else if did_timeout {
                Outcome::Failed("Pairing timed out. Please start over.".into())
            } else {
                // A launch failure is definitive and leaves no output to quote,
                // so it outranks whatever the transcript happens to contain.
                Outcome::Failed(
                    exit_code
                        .and_then(|code| crate::proc::launch_failure("Claude", code))
                        .map(|reason| format!("{reason} {MANUAL_SIGN_IN_HINT}"))
                        .or_else(|| failure_reason(&stripped))
                        .unwrap_or_else(|| "Pairing didn't complete. Please try again.".into()),
                )
            };

            let mut st = PairingState::idle();
            st.pairing_id = Some(id.clone());
            st.raw_tail = Some(raw_tail);
            match outcome {
                Outcome::Paired => {
                    st.phase = Phase::Paired;
                    st.mode = Some("app_managed_oauth".into());
                    st.oauth_url = oauth_url;
                }
                Outcome::Failed(reason) => {
                    st.phase = Phase::Failed;
                    st.error = Some(reason);
                    st.oauth_url = oauth_url;
                }
            }
            shared.finish_if_active(&app, &id, st);
        });
    }
}

fn take_if<T>(slot: &mut Option<T>, predicate: impl FnOnce(&T) -> bool) -> Option<T> {
    if slot.as_ref().is_some_and(predicate) {
        slot.take()
    } else {
        None
    }
}

enum Outcome {
    Paired,
    Failed(String),
}

/// A credential seen only in the stdout of the exact `claude setup-token`
/// child launched above. Keeping the constructor private makes subscription
/// provenance a code invariant for the one inference-based token check.
struct SetupTokenCandidate(String);

impl SetupTokenCandidate {
    fn captured(token: String) -> Self {
        Self(token)
    }

    fn expose(&self) -> &str {
        &self.0
    }
}

/// Verify the candidate directly, then promote it. A bad re-pair never
/// overwrites the last working credential.
fn resolve_outcome(token: &SetupTokenCandidate, shared: &Shared, pairing_id: &str) -> Outcome {
    if parse::verify_setup_token_candidate(token.expose()).is_err() {
        return Outcome::Failed(
            "Pairing finished but the account check didn't pass. Please try again.".into(),
        );
    }

    match shared.store_token_if_active(pairing_id, token.expose()) {
        Ok(true) => Outcome::Paired,
        Ok(false) => Outcome::Failed("This pairing is no longer active.".into()),
        Err(error) => Outcome::Failed(format!("The token couldn't be saved securely: {error}")),
    }
}

/// Watchdog for both deadlines: `STARTUP_TIMEOUT` with no output at all (the
/// CLI never really started), then `OVERALL_TIMEOUT` for the whole pairing. It
/// kills the child if the reader hasn't already finished, and flags which
/// deadline fired so the outcome says something specific instead of "failed".
fn spawn_watchdog(
    child: Arc<Mutex<Box<dyn portable_pty::Child + Send + Sync>>>,
    finished: Arc<AtomicBool>,
    timed_out: Arc<AtomicBool>,
    saw_output: Arc<AtomicBool>,
    never_started: Arc<AtomicBool>,
) {
    std::thread::spawn(move || {
        let started_at = std::time::Instant::now();
        loop {
            if finished.load(Ordering::SeqCst) {
                return;
            }
            let elapsed = started_at.elapsed();
            let expired = if !saw_output.load(Ordering::SeqCst) && elapsed >= STARTUP_TIMEOUT {
                &never_started
            } else if elapsed >= OVERALL_TIMEOUT {
                &timed_out
            } else {
                std::thread::sleep(Duration::from_millis(500));
                continue;
            };
            expired.store(true, Ordering::SeqCst);
            let _ = child.lock().unwrap_or_else(|e| e.into_inner()).kill();
            return;
        }
    });
}

/// Keep only the last `cap` bytes of the transcript (the URL/token appear early
/// and are captured incrementally, so dropping the front is safe). Trims to a
/// char boundary so the `String` stays valid UTF-8.
fn cap_front(s: &mut String, cap: usize) {
    if s.len() <= cap {
        return;
    }
    let mut cut = s.len() - cap;
    while cut < s.len() && !s.is_char_boundary(cut) {
        cut += 1;
    }
    s.replace_range(..cut, "");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cap_front_trims_to_char_boundary() {
        let mut s = "α".repeat(100); // 2 bytes each => 200 bytes
        cap_front(&mut s, 50);
        assert!(s.len() <= 50);
        assert!(s.chars().all(|c| c == 'α')); // never split a codepoint
    }

    #[test]
    fn stale_pairing_cleanup_does_not_take_a_newer_active_value() {
        let mut active = Some("new");
        assert_eq!(take_if(&mut active, |id| *id == "old"), None);
        assert_eq!(active, Some("new"));
        assert_eq!(take_if(&mut active, |id| *id == "new"), Some("new"));
        assert_eq!(active, None);
    }
}
