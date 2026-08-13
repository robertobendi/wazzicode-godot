//! Pure parsing helpers for the pairing stream, kept apart from the threading
//! so they're trivially unit-testable over fixture transcripts.
//!
//! Everything scans the *whole accumulated* (ANSI-stripped) transcript, so a
//! URL or token split across `read()` boundaries is handled by accumulation
//! alone. URL/token detection additionally only trusts a *complete* (newline-
//! terminated) line, so an in-flight, half-received URL is never captured
//! truncated — the single most important correctness property here.

use std::sync::OnceLock;
use std::time::Duration;

use regex::Regex;

const SETUP_TOKEN_PROBE_ARGS: &[&str] = &[
    "--setting-sources",
    "",
    "-p",
    "Reply with exactly OK",
    "--output-format",
    "json",
    "--max-turns",
    "1",
    "--tools",
    "",
    "--no-session-persistence",
];

/// Hosts we accept an OAuth URL from. Observed real host is `claude.com`
/// (redirecting via `platform.claude.com`); `claude.ai` / `anthropic.com`
/// (e.g. `console.anthropic.com`) are kept as belt-and-suspenders for CLI
/// drift. Matched as exact host or any subdomain.
const ALLOWED_HOSTS: &[&str] = &["claude.com", "claude.ai", "anthropic.com"];

/// ECMA-48 CSI (`ESC [ … final`), OSC (`ESC ] … BEL|ST`), and the common
/// two-byte / charset escapes (`ESC 7/8/=/>/M/c`, `ESC ( 0` …). The parameter
/// class is the full `0x30–0x3f` (so `ESC[>0q`, `ESC[?25h`, etc. all strip) —
/// the spec's narrower `[0-9;?]` would leave `<`, `=`, `>` bytes behind.
fn ansi_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(concat!(
            r"\x1b\[[\x30-\x3f]*[\x20-\x2f]*[\x40-\x7e]", // CSI
            r"|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)",        // OSC (BEL or ST terminated)
            r"|\x1b[78=>Mc]",                             // save/restore/keypad/index/reset
            r"|\x1b[()#%][0-9A-Za-z]",                    // charset / DEC selects
        ))
        .expect("ansi regex")
    })
}

/// `https://…` up to the first whitespace / quote / angle bracket / ESC.
fn url_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r#"https://[^\s"'<>\x1b]+"#).expect("url regex"))
}

/// The long-lived OAuth token the CLI prints on success.
fn token_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"sk-ant-oat01-[^\s\x1b]{20,512}").expect("token regex"))
}

/// The CLI's code prompt. NOTE: `setup-token` lays out prompt words with cursor
/// moves (`ESC[<n>G`), not spaces, so after ANSI-strip "Paste code here"
/// collapses to "Pastecodehere" — hence `\s*` (zero-or-more) between words.
fn prompt_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(r"(?i)paste\s*code|enter\s*code|authorization\s*code").expect("prompt regex")
    })
}

/// Potential-failure markers. Only consulted when the process actually failed
/// (never fail-fast on these alone — the CLI prints "Browser didn't open?" etc.
/// during normal operation).
fn failure_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"(?i)error|invalid|expired|denied").expect("failure regex"))
}

/// Remove ANSI/terminal control sequences.
pub fn strip_ansi(s: &str) -> String {
    ansi_re().replace_all(s, "").into_owned()
}

/// The prefix of `s` up to and excluding the last `\n` — i.e. only lines we've
/// fully received. Empty if no newline yet.
fn complete_lines(s: &str) -> &str {
    match s.rfind('\n') {
        Some(i) => &s[..i],
        None => "",
    }
}

/// First OAuth URL on a *complete* line whose host is allowed. Returns `None`
/// until the URL's line is newline-terminated, so a partially-streamed URL is
/// never returned truncated.
pub fn find_oauth_url(transcript: &str) -> Option<String> {
    let stripped = strip_ansi(transcript);
    let region = complete_lines(&stripped);
    for m in url_re().find_iter(region) {
        let url = m.as_str().trim_end_matches(['.', ',', ')', ']']);
        if host_allowed(url) {
            return Some(url.to_string());
        }
    }
    None
}

/// The captured token, if present on a complete line.
pub fn find_token(transcript: &str) -> Option<String> {
    let stripped = strip_ansi(transcript);
    let region = complete_lines(&stripped);
    token_re().find(region).map(|m| m.as_str().to_string())
}

pub fn redact_tokens(transcript: &str) -> String {
    token_re()
        .replace_all(transcript, "[redacted OAuth token]")
        .into_owned()
}

/// Whether the CLI has prompted for the code yet (substring match — safe on a
/// partial line since it's idempotent and only enables the input UI).
pub fn looks_like_prompt(transcript: &str) -> bool {
    prompt_re().is_match(&strip_ansi(transcript))
}

/// Host of `url` (already `https://`-prefixed) matches an allowed domain or a
/// subdomain of one. Strips any port / userinfo.
fn host_allowed(url: &str) -> bool {
    let Some(rest) = url.strip_prefix("https://") else {
        return false;
    };
    let authority = rest.split(['/', '?', '#']).next().unwrap_or("");
    let host = authority
        .rsplit('@')
        .next()
        .unwrap_or(authority)
        .split(':')
        .next()
        .unwrap_or("")
        .to_ascii_lowercase();
    ALLOWED_HOSTS
        .iter()
        .any(|d| host == *d || host.ends_with(&format!(".{d}")))
}

/// The last `max_bytes` bytes of `s`, trimmed to a char boundary.
pub fn tail(s: &str, max_bytes: usize) -> String {
    if s.len() <= max_bytes {
        return s.to_string();
    }
    let mut start = s.len() - max_bytes;
    while start < s.len() && !s.is_char_boundary(start) {
        start += 1;
    }
    s[start..].to_string()
}

/// First line matching a failure marker, for the failure message. `None` if
/// none — the caller falls back to a generic message.
pub fn failure_reason(stripped: &str) -> Option<String> {
    stripped
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty())
        .find(|l| failure_re().is_match(l))
        .map(|l| {
            // Keep it short and human for the UI's main failure line.
            let clipped: String = l.chars().take(200).collect();
            clipped
        })
}

/// Verify Studio's stored subscription credential without making an inference
/// request.
pub fn verify_subscription_status() -> Result<(), String> {
    crate::claudeauth::verify_subscription_access().map_err(|error| error.to_string())
}

/// Validate the one-time candidate captured from this module's
/// `claude setup-token` child. That command is subscription-only, but its opaque
/// token cannot be remotely validated by `auth status`, so this is the sole
/// minimal inference check before the candidate replaces a working credential.
pub(super) fn verify_setup_token_candidate(token: &str) -> Result<(), String> {
    let (cmd, credential_guard) = setup_token_probe_command(token)?;
    let out = crate::proc::output_with_timeout(cmd, Duration::from_secs(60))
        .map_err(|e| e.to_string())?;
    drop(credential_guard);
    if !out.status.success() {
        let tail = tail(&String::from_utf8_lossy(&out.stderr), 200);
        let tail = tail.trim();
        return Err(if tail.is_empty() {
            "the check command failed".into()
        } else {
            tail.to_string()
        });
    }
    let v: serde_json::Value = serde_json::from_slice(&out.stdout)
        .map_err(|_| "the check reply couldn't be read".to_string())?;
    if v.get("is_error").and_then(|b| b.as_bool()).unwrap_or(true)
        || v.get("result").and_then(|value| value.as_str()) != Some("OK")
    {
        return Err("the account check returned an error".into());
    }
    Ok(())
}

fn setup_token_probe_command(
    token: &str,
) -> Result<(std::process::Command, crate::claudeauth::CredentialGuard), String> {
    let cmd = crate::proc::command("claude").map_err(|e| e.to_string())?;
    configure_setup_token_probe(cmd, token)
}

fn configure_setup_token_probe(
    mut cmd: std::process::Command,
    token: &str,
) -> Result<(std::process::Command, crate::claudeauth::CredentialGuard), String> {
    cmd.args(SETUP_TOKEN_PROBE_ARGS);
    let credential_guard = crate::claudeauth::configure_child_with_token(&mut cmd, Some(token))
        .map_err(|e| e.to_string())?;
    if let Some(home) = dirs::home_dir() {
        cmd.current_dir(home);
    }
    Ok((cmd, credential_guard))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Realistic wide-PTY `claude setup-token` output (CLI 2.1.198), captured on
    /// a real machine and trimmed. URL host is claude.com; the URL is on one
    /// (newline-terminated) line thanks to the wide PTY; a redirect_uri points
    /// at platform.claude.com. Token is fictional. Heavy on ANSI: color runs,
    /// cursor moves, spinner frames, bracketed-paste/focus toggles, `ESC[>0q`.
    const REAL_TRANSCRIPT: &str = "\x1b7\x1b[r\x1b8\x1b[?25h\x1b[?25l\x1b[?2004h\x1b[?1004h\x1b[?2031h\x1b[38;2;215;119;87mWelcome\x1b[9Gto\x1b[12GClaude\x1b[19GCode\x1b[24G\x1b[38;2;153;153;153mv2.1.198\x1b[39m\r\n\r\n\x1b[>0q\x1b[c\x1b[2G\x1b[38;2;255;255;255m·\x1b[4G\x1b[39mOpening\x1b[12Gbrowser\x1b[20Gto\x1b[23Gsign\x1b[28Gin…\r\n\x1b[1C\x1b[1A\x1b[38;2;255;255;255m✢\x1b[39m\r\n\x1b[1C\x1b[1A\x1b[38;2;153;153;153mBrowser didn't open? Use the url below to sign in (c to copy)\x1b[39m\r\n\r\n\x1b[38;2;153;153;153mhttps://claude.com/cai/oauth/authorize?code=true&client_id=9d1c250a-e61b-44d9-88ed-5944d1962f5e&response_type=code&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback&scope=user%3Ainference&code_challenge=VB00AkEPo3K3Q5xceh8Gf_T-y3gIYQZDWoQPwSAilZY&code_challenge_method=S256&state=ZArUp-okDpfCU0RpaOE60XLGZgxdfTaE6kOzL-9n7a4\x1b[39m\r\n\r\n\r\n\x1b[2GPaste\x1b[8Gcode\x1b[13Ghere\x1b[18Gif\x1b[21Gprompted\x1b[30G>";

    #[test]
    fn strip_ansi_removes_all_escapes() {
        let out = strip_ansi(REAL_TRANSCRIPT);
        assert!(!out.contains('\x1b'), "ESC left behind: {out:?}");
        assert!(out.contains("Welcome"));
        assert!(out.contains("Paste"));
        assert!(out.contains("https://claude.com/"));
    }

    #[test]
    fn extracts_real_oauth_url_on_claude_com() {
        let url = find_oauth_url(REAL_TRANSCRIPT).expect("should find url");
        assert!(url.starts_with("https://claude.com/cai/oauth/authorize?"));
        assert!(url.ends_with("state=ZArUp-okDpfCU0RpaOE60XLGZgxdfTaE6kOzL-9n7a4"));
        // No trailing ANSI/CR leaked into the captured URL.
        assert!(!url.contains('\x1b') && !url.contains('\r') && !url.contains('\n'));
    }

    #[test]
    fn detects_code_prompt() {
        assert!(looks_like_prompt(REAL_TRANSCRIPT));
        assert!(!looks_like_prompt("just some spinner frames ✢✳✶"));
    }

    #[test]
    fn url_split_across_two_chunks_only_captured_when_line_completes() {
        // Chunk 1: URL arrives with no terminating newline yet.
        let c1 = "\x1b[38;2;153;153;153mhttps://claude.com/cai/oauth/authorize?code=true&cli";
        assert_eq!(
            find_oauth_url(c1),
            None,
            "must not capture a half-received URL"
        );
        // Chunk 2 completes the URL's line (accumulated transcript).
        let c2 = format!("{c1}ent_id=abc123&state=ZZZ\x1b[39m\r\n");
        let url = find_oauth_url(&c2).expect("url once line completes");
        assert_eq!(
            url,
            "https://claude.com/cai/oauth/authorize?code=true&client_id=abc123&state=ZZZ"
        );
    }

    #[test]
    fn host_filter_rejects_foreign_urls() {
        assert_eq!(
            find_oauth_url("look here https://evil.example.com/claude.com/oauth\n"),
            None
        );
        // Accepts the other real Anthropic hosts too.
        assert!(find_oauth_url("https://console.anthropic.com/oauth?x=1\n").is_some());
        assert!(find_oauth_url("https://foo.claude.ai/authorize\n").is_some());
    }

    #[test]
    fn token_extraction() {
        let none = find_token(REAL_TRANSCRIPT);
        assert!(none.is_none(), "no token in the pre-code transcript");

        let with = "\x1b[32mYour token:\x1b[39m\r\nsk-ant-oat01-AbCd1234EfGh5678IjKl9012MnOp\r\n";
        assert_eq!(
            find_token(with).as_deref(),
            Some("sk-ant-oat01-AbCd1234EfGh5678IjKl9012MnOp")
        );
        // A too-short candidate must not match.
        assert_eq!(find_token("sk-ant-oat01-short\r\n"), None);
    }

    #[test]
    fn token_redaction_removes_secrets_from_diagnostics() {
        let raw = "token sk-ant-oat01-AbCd1234EfGh5678IjKl9012MnOp done";
        let redacted = redact_tokens(raw);
        assert!(!redacted.contains("sk-ant"));
        assert!(redacted.contains("[redacted OAuth token]"));
    }

    #[test]
    fn failure_reason_picks_marker_line() {
        let s = "starting up\nauthorization code invalid or expired\nbye\n";
        assert_eq!(
            failure_reason(s).as_deref(),
            Some("authorization code invalid or expired")
        );
        assert_eq!(failure_reason("all good here\ndone\n"), None);
    }

    #[test]
    fn tail_is_char_boundary_safe() {
        let s = "α".repeat(100); // 200 bytes
        let t = tail(&s, 51); // 51 is mid-codepoint
        assert!(t.len() <= 51);
        assert!(t.chars().all(|c| c == 'α'));
    }

    #[test]
    fn setup_token_probe_is_one_turn_without_tools_or_persistence() {
        assert!(SETUP_TOKEN_PROBE_ARGS
            .windows(2)
            .any(|pair| pair == ["--max-turns", "1"]));
        assert!(SETUP_TOKEN_PROBE_ARGS
            .windows(2)
            .any(|pair| pair == ["--tools", ""]));
        assert!(SETUP_TOKEN_PROBE_ARGS
            .windows(2)
            .any(|pair| pair == ["--setting-sources", ""]));
        assert!(SETUP_TOKEN_PROBE_ARGS.contains(&"--no-session-persistence"));

        let token = "sk-ant-oat01-AbCd1234EfGh5678IjKl9012MnOp";
        let (cmd, _guard) =
            configure_setup_token_probe(std::process::Command::new("claude"), token).unwrap();
        let args = cmd
            .get_args()
            .map(|arg| arg.to_string_lossy().into_owned())
            .collect::<Vec<_>>();
        assert!(!args.iter().any(|arg| arg.contains(token)));
        assert!(cmd
            .get_envs()
            .any(|(name, value)| { name == "ANTHROPIC_API_KEY" && value.is_none() }));
        let settings_at = args.iter().position(|arg| arg == "--settings").unwrap();
        let settings: serde_json::Value = serde_json::from_str(&args[settings_at + 1]).unwrap();
        assert_eq!(settings["forceLoginMethod"], "claudeai");
        assert_eq!(settings["apiKeyHelper"], "");
    }
}
