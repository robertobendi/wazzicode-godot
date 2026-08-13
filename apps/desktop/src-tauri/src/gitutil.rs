//! Shared git helpers (blocking).
//!
//! The auto-loop ([`crate::looprunner`]) and the chat "studio checkpoint" /
//! revert feature both drive the same small set of `git` operations —
//! `add -A`, `commit -m`, `rev-parse --short HEAD`, `reset --hard`,
//! `clean -fd` — through [`crate::proc`] (PATH-augmented spawn +
//! `output_with_timeout`). This module is the single implementation.
//!
//! Every function is blocking (it shells out and waits), so callers on the
//! async runtime must wrap them in `tokio::task::spawn_blocking`. Errors carry
//! the trimmed git stderr so the caller can surface / log it. Nothing here ever
//! pushes to a remote.

use crate::proc;
use serde::Serialize;
use std::path::Path;

/// A one-shot "studio checkpoint" of a project: the commit the user can revert
/// back to (taken just before an AI chat turn). `sha` is the short HEAD sha
/// after the checkpoint commit (or the existing HEAD when there was nothing to
/// commit). Mirrored to the webview as camelCase.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Checkpoint {
    pub sha: String,
    /// The first line of the prompt that triggered the turn (trimmed), for a
    /// human-readable label.
    pub prompt: String,
    /// Unix milliseconds when the checkpoint was taken.
    pub at: i64,
}

/// Run a local `git` subcommand in `project`, returning the `Output`. `Err`
/// carries a spawn/timeout message (git missing, wedged); a non-zero exit is
/// still `Ok` — inspect `status`/`stderr` yourself.
fn run(project: &Path, args: &[&str]) -> Result<std::process::Output, String> {
    let mut cmd = proc::command("git").map_err(|e| e.to_string())?;
    cmd.current_dir(project).args(args);
    proc::output_with_timeout(cmd, proc::LOCAL_TIMEOUT).map_err(|e| e.to_string())
}

fn stderr_of(out: &std::process::Output) -> String {
    String::from_utf8_lossy(&out.stderr).trim().to_string()
}

/// Is `project` inside a git work tree? Cheap probe; `false` on any git error.
pub fn is_repo(project: &Path) -> bool {
    run(project, &["rev-parse", "--is-inside-work-tree"])
        .map(|o| o.status.success() && String::from_utf8_lossy(&o.stdout).trim() == "true")
        .unwrap_or(false)
}

/// `git add -A`. `Err` (with stderr) when git fails — almost always "not a git
/// repository".
pub fn add_all(project: &Path) -> Result<(), String> {
    let out = run(project, &["add", "-A"])?;
    if out.status.success() {
        Ok(())
    } else {
        Err(stderr_of(&out))
    }
}

/// `git commit -m <message>`. `Ok(true)` when a commit was created, `Ok(false)`
/// when there was nothing to commit (clean tree) or the commit otherwise
/// no-op'd — both benign. Never errors on a clean tree.
pub fn commit(project: &Path, message: &str) -> Result<bool, String> {
    let out = run(project, &["commit", "-m", message])?;
    Ok(out.status.success())
}

/// `git rev-parse --short HEAD`. `Ok(None)` when there is no HEAD yet (empty
/// repo) or the sha comes back blank.
pub fn head_short(project: &Path) -> Result<Option<String>, String> {
    let out = run(project, &["rev-parse", "--short", "HEAD"])?;
    if !out.status.success() {
        return Ok(None);
    }
    let sha = String::from_utf8_lossy(&out.stdout).trim().to_string();
    Ok(if sha.is_empty() { None } else { Some(sha) })
}

/// `git reset --hard <sha>`. `Err` (with stderr) on failure.
pub fn reset_hard(project: &Path, sha: &str) -> Result<(), String> {
    let out = run(project, &["reset", "--hard", sha])?;
    if out.status.success() {
        Ok(())
    } else {
        Err(stderr_of(&out))
    }
}

/// `git clean -fd`, excluding each pattern in `excludes` (passed as repeated
/// `-e <pattern>`). Removes untracked files/dirs. `Err` (with stderr) on
/// failure.
pub fn clean(project: &Path, excludes: &[&str]) -> Result<(), String> {
    let mut args: Vec<&str> = vec!["clean", "-fd"];
    for e in excludes {
        args.push("-e");
        args.push(e);
    }
    let out = run(project, &args)?;
    if out.status.success() {
        Ok(())
    } else {
        Err(stderr_of(&out))
    }
}

/// `git add -A && git commit -m "<message>"`, returning the short sha to
/// checkpoint back to. Composes [`add_all`] + [`commit`] + [`head_short`] with
/// the loop's semantics: an `add` failure (not a repo) is an `Err`; a commit
/// that no-ops (nothing to commit) is fine — the returned sha is then just the
/// current HEAD. `Ok(None)` only when there is no HEAD at all.
pub fn commit_and_head(project: &Path, message: &str) -> Result<Option<String>, String> {
    add_all(project)?;
    if !commit(project, message)? {
        // Nothing to commit (or a benign commit failure) — fall through to the
        // current HEAD sha so callers still get a checkpoint to revert to.
    }
    head_short(project)
}

/// Take a studio checkpoint of `project` for the given chat `prompt`: commit any
/// pending work under a "studio checkpoint: …" message and capture the sha.
/// `None` when `project` isn't a git repo (revert is simply unavailable) or the
/// repo has no commit to point at.
pub fn make_checkpoint(project: &Path, prompt: &str) -> Option<Checkpoint> {
    if !is_repo(project) {
        return None;
    }
    let message = checkpoint_message(prompt);
    let sha = match commit_and_head(project, &message) {
        Ok(Some(sha)) => sha,
        Ok(None) => return None,
        Err(e) => {
            log::warn!("studio checkpoint failed: {}", first_line(&e));
            return None;
        }
    };
    Some(Checkpoint {
        sha,
        prompt: trim_prompt(prompt, 60),
        at: now_ms(),
    })
}

/// The commit message for a studio checkpoint: `studio checkpoint: <first 60
/// chars of the prompt, one line>`.
pub fn checkpoint_message(prompt: &str) -> String {
    let head = trim_prompt(prompt, 60);
    if head.is_empty() {
        "studio checkpoint".to_string()
    } else {
        format!("studio checkpoint: {head}")
    }
}

/// Collapse a prompt to a single trimmed line capped at `max` chars.
fn trim_prompt(s: &str, max: usize) -> String {
    let one_line = s.replace(['\n', '\r'], " ");
    let one_line = one_line.split_whitespace().collect::<Vec<_>>().join(" ");
    if one_line.chars().count() <= max {
        one_line
    } else {
        one_line.chars().take(max).collect()
    }
}

fn first_line(s: &str) -> String {
    s.lines()
        .find(|l| !l.trim().is_empty())
        .unwrap_or("")
        .trim()
        .to_string()
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    /// Configure a throwaway repo so commits work in CI (no global git identity).
    fn init_repo(dir: &Path) {
        run(dir, &["init"]).unwrap();
        run(dir, &["config", "user.email", "test@example.com"]).unwrap();
        run(dir, &["config", "user.name", "Test"]).unwrap();
        // Deterministic default branch across git versions.
        let _ = run(dir, &["checkout", "-b", "main"]);
    }

    fn tmp() -> PathBuf {
        let d = std::env::temp_dir().join(format!("uvibe-git-{}", nanoid::nanoid!(8)));
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn checkpoint_message_trims_and_prefixes() {
        assert_eq!(
            checkpoint_message("Make the coins spin"),
            "studio checkpoint: Make the coins spin"
        );
        let long = "a".repeat(200);
        let msg = checkpoint_message(&long);
        assert!(msg.starts_with("studio checkpoint: "));
        // 60 chars of prompt after the prefix.
        assert_eq!(msg.len(), "studio checkpoint: ".len() + 60);
        // Newlines collapse to a single line.
        assert_eq!(
            checkpoint_message("line one\nline two"),
            "studio checkpoint: line one line two"
        );
        assert_eq!(checkpoint_message("   "), "studio checkpoint");
    }

    #[test]
    fn is_repo_false_outside_repo() {
        let dir = tmp();
        assert!(!is_repo(&dir));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn checkpoint_and_revert_round_trip() {
        let dir = tmp();
        init_repo(&dir);
        // Commit an initial tracked file.
        std::fs::write(dir.join("keep.txt"), b"original").unwrap();
        add_all(&dir).unwrap();
        assert!(commit(&dir, "initial").unwrap());
        assert!(is_repo(&dir));

        // A chat turn is about to run: take the checkpoint (commits nothing new
        // here, so it points at the current HEAD).
        let cp = make_checkpoint(&dir, "make the coins spin").expect("repo → checkpoint");
        assert!(!cp.sha.is_empty());
        assert_eq!(cp.prompt, "make the coins spin");

        // The AI edits a tracked file and creates a new untracked one, plus a
        // file under the studio state dir that revert must NOT remove.
        std::fs::write(dir.join("keep.txt"), b"changed by AI").unwrap();
        std::fs::write(dir.join("ai_new.cs"), b"// generated").unwrap();
        std::fs::create_dir_all(dir.join(".unity-vibe").join("studio")).unwrap();
        std::fs::write(dir.join(".unity-vibe").join("studio").join("s.json"), b"{}").unwrap();

        // Revert: reset --hard to the checkpoint + clean untracked (keep
        // .unity-vibe/).
        reset_hard(&dir, &cp.sha).unwrap();
        clean(&dir, &[".unity-vibe/"]).unwrap();

        // Tracked edit rolled back, AI-created file removed, studio state kept.
        assert_eq!(
            std::fs::read_to_string(dir.join("keep.txt")).unwrap(),
            "original"
        );
        assert!(
            !dir.join("ai_new.cs").exists(),
            "AI-created untracked file should be cleaned"
        );
        assert!(
            dir.join(".unity-vibe")
                .join("studio")
                .join("s.json")
                .exists(),
            "studio state dir must survive revert"
        );

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn checkpoint_commits_pending_work() {
        let dir = tmp();
        init_repo(&dir);
        std::fs::write(dir.join("a.txt"), b"one").unwrap();
        add_all(&dir).unwrap();
        commit(&dir, "initial").unwrap();

        // Uncommitted change present → the checkpoint commits it and advances HEAD.
        let head_before = head_short(&dir).unwrap().unwrap();
        std::fs::write(dir.join("a.txt"), b"two").unwrap();
        let cp = make_checkpoint(&dir, "edit").unwrap();
        let head_after = head_short(&dir).unwrap().unwrap();
        assert_ne!(head_before, head_after, "checkpoint should create a commit");
        assert_eq!(cp.sha, head_after);

        std::fs::remove_dir_all(&dir).ok();
    }
}
