//! One-shot "Synchronize" for a project's git remote (blocking).
//!
//! The chat surface's Synchronize button runs this: commit whatever the agent
//! (or the user) left uncommitted, fetch every remote, fast-forward or merge the
//! upstream, then push. It is the network counterpart to the local-only helpers
//! in [`crate::gitutil`], and reuses them for the add/commit steps so the two
//! paths can't drift.
//!
//! Behavior is deliberately conservative: a diverged merge that conflicts is
//! aborted and reported rather than left for the user to untangle, and every
//! network step is wrapped in [`proc::NETWORK_TIMEOUT`]. Nothing here asks for
//! credentials interactively (`apply_no_prompt_env`), so a missing credential
//! helper fails fast with an actionable message instead of hanging.

use crate::gitutil;
use crate::proc;
use serde::Serialize;
use std::path::Path;

/// One step of the sync, for the UI timeline.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncStep {
    pub id: String,
    pub ok: bool,
    pub detail: String,
}

/// Outcome of a Synchronize press. `ok` is true when nothing failed (an
/// already-up-to-date repo is a success).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncReport {
    pub ok: bool,
    pub branch: String,
    pub upstream: Option<String>,
    pub committed: bool,
    pub pulled: bool,
    pub pushed: bool,
    pub fast_forward: bool,
    pub steps: Vec<SyncStep>,
    pub summary: String,
}

fn step(id: &str, ok: bool, detail: impl Into<String>) -> SyncStep {
    SyncStep {
        id: id.into(),
        ok,
        detail: detail.into(),
    }
}

fn stderr_of(out: &std::process::Output) -> String {
    String::from_utf8_lossy(&out.stderr).trim().to_string()
}

fn first_line(text: &str) -> String {
    text.lines()
        .find(|line| !line.trim().is_empty())
        .unwrap_or("")
        .trim()
        .to_string()
}

fn run(
    project: &Path,
    args: &[&str],
    timeout: std::time::Duration,
    network: bool,
) -> Result<std::process::Output, String> {
    let mut cmd = proc::command("git").map_err(|e| e.to_string())?;
    cmd.current_dir(project).args(args);
    if network {
        proc::apply_no_prompt_env(&mut cmd);
    }
    proc::output_with_timeout(cmd, timeout).map_err(|e| e.to_string())
}

fn local_stdout(project: &Path, args: &[&str]) -> Result<String, String> {
    let out = run(project, args, proc::LOCAL_TIMEOUT, false)?;
    if out.status.success() {
        Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
    } else {
        Err(first_line(&stderr_of(&out)))
    }
}

fn net(project: &Path, args: &[&str]) -> Result<std::process::Output, String> {
    run(project, args, proc::NETWORK_TIMEOUT, true)
}

/// Commit local work, fetch, fast-forward-or-merge the upstream, then push.
pub fn synchronize(project: &Path, message: Option<&str>) -> Result<SyncReport, String> {
    if !gitutil::is_repo(project) {
        return Err("This project isn't a git repository, so there's nothing to synchronize.".into());
    }

    let mut steps: Vec<SyncStep> = Vec::new();
    let branch = local_stdout(project, &["rev-parse", "--abbrev-ref", "HEAD"])
        .unwrap_or_else(|_| "HEAD".into());
    let upstream = local_stdout(
        project,
        &["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"],
    )
    .ok()
    .filter(|value| !value.is_empty() && value != "HEAD");

    // 1. Commit local work so the tree is clean and the merge below can run.
    let dirty = local_stdout(project, &["status", "--porcelain"])
        .map(|text| !text.is_empty())
        .unwrap_or(false);
    let mut committed = false;
    if dirty {
        let message = message
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .unwrap_or("chore: synchronize with remote");
        gitutil::add_all(project).map_err(|e| format!("git add failed: {e}"))?;
        match gitutil::commit(project, message) {
            Ok(true) => {
                committed = true;
                steps.push(step("commit", true, format!("Committed local changes — {message}")));
            }
            Ok(false) => steps.push(step("commit", true, "Nothing to commit after staging")),
            Err(e) => return Err(format!("git commit failed: {e}")),
        }
    } else {
        steps.push(step("commit", true, "Working tree already clean"));
    }

    // 2. Fetch every remote.
    let mut remote_ok = true;
    match net(project, &["fetch", "--all", "--prune"]) {
        Ok(out) if out.status.success() => {
            steps.push(step("fetch", true, "Fetched from all remotes"));
        }
        Ok(out) => {
            remote_ok = false;
            steps.push(step("fetch", false, first_line(&stderr_of(&out))));
        }
        Err(e) => {
            remote_ok = false;
            steps.push(step("fetch", false, e));
        }
    }

    // 3. Pull: fast-forward when we're strictly behind, merge when diverged.
    let mut pulled = false;
    let mut fast_forward = false;
    let mut ahead = 0u32;
    if remote_ok {
        if let Some(up) = upstream.clone() {
            let (behind, ahead_count) = ahead_behind(project, &up)?;
            ahead = ahead_count;
            if behind > 0 && ahead == 0 {
                match net(project, &["merge", "--ff-only", "--quiet", up.as_str()]) {
                    Ok(out) if out.status.success() => {
                        pulled = true;
                        fast_forward = true;
                        steps.push(step("pull", true, format!("Fast-forwarded {behind} commit(s) from {up}")));
                    }
                    Ok(out) => steps.push(step("pull", false, first_line(&stderr_of(&out)))),
                    Err(e) => steps.push(step("pull", false, e)),
                }
            } else if behind > 0 && ahead > 0 {
                match net(project, &["merge", "--no-edit", up.as_str()]) {
                    Ok(out) if out.status.success() => {
                        pulled = true;
                        steps.push(step("merge", true, format!("Merged {up} into {branch}")));
                    }
                    Ok(out) => {
                        let _ = run(project, &["merge", "--abort"], proc::LOCAL_TIMEOUT, false);
                        let detail = first_line(&stderr_of(&out));
                        steps.push(step(
                            "merge",
                            false,
                            format!("{up} conflicts with local work; merge aborted. Resolve manually. {detail}"),
                        ));
                        return Ok(finish(steps, branch, upstream, committed, false, false, false, false));
                    }
                    Err(e) => {
                        let _ = run(project, &["merge", "--abort"], proc::LOCAL_TIMEOUT, false);
                        steps.push(step("merge", false, e));
                        return Ok(finish(steps, branch, upstream, committed, false, false, false, false));
                    }
                }
            } else {
                steps.push(step("pull", true, "Already up to date"));
            }
        } else {
            steps.push(step("pull", true, "No upstream branch to pull from"));
        }
    }

    // 4. Push new local commits (or set up a fresh branch's upstream).
    let mut pushed = false;
    if remote_ok {
        let should_push = upstream.is_none() || ahead > 0;
        if should_push {
            let push_args: Vec<&str> = if upstream.is_some() {
                vec!["push"]
            } else {
                vec!["push", "-u", "origin", "HEAD"]
            };
            match net(project, &push_args) {
                Ok(out) if out.status.success() => {
                    pushed = true;
                    steps.push(step("push", true, "Pushed to remote"));
                }
                Ok(out) => steps.push(step("push", false, first_line(&stderr_of(&out)))),
                Err(e) => steps.push(step("push", false, e)),
            }
        } else {
            steps.push(step("push", true, "Nothing to push"));
        }
    }

    Ok(finish(
        steps,
        branch,
        upstream,
        committed,
        pulled,
        !fast_forward && pulled,
        pushed,
        fast_forward,
    ))
}

#[allow(clippy::too_many_arguments)]
fn finish(
    steps: Vec<SyncStep>,
    branch: String,
    upstream: Option<String>,
    committed: bool,
    pulled: bool,
    merged: bool,
    pushed: bool,
    fast_forward: bool,
) -> SyncReport {
    let ok = steps.iter().all(|step| step.ok);
    let summary = if !ok {
        steps
            .iter()
            .rev()
            .find(|step| !step.ok)
            .map(|step| step.detail.clone())
            .unwrap_or_else(|| "Synchronization failed.".into())
    } else if committed || (pulled && merged) || pushed {
        let mut parts: Vec<&str> = Vec::new();
        if committed {
            parts.push("committed");
        }
        if pulled {
            parts.push(if fast_forward { "pulled" } else { "merged" });
        }
        if pushed {
            parts.push("pushed");
        }
        format!("{} on {branch}.", capitalize(&parts.join(", ")))
    } else {
        format!("Everything is up to date on {branch}.")
    };
    SyncReport {
        ok,
        branch,
        upstream,
        committed,
        pulled,
        pushed,
        fast_forward,
        steps,
        summary,
    }
}

fn capitalize(text: &str) -> String {
    let mut chars = text.chars();
    match chars.next() {
        Some(first) => first.to_uppercase().collect::<String>() + chars.as_str(),
        None => String::new(),
    }
}

/// `git rev-list --left-right --count <upstream>...HEAD` → `(behind, ahead)`.
fn ahead_behind(project: &Path, upstream: &str) -> Result<(u32, u32), String> {
    let range = format!("{upstream}...HEAD");
    let out = local_stdout(
        project,
        &["rev-list", "--left-right", "--count", range.as_str()],
    )?;
    let mut parts = out.split_whitespace();
    let behind = parts.next().and_then(|v| v.parse().ok()).unwrap_or(0);
    let ahead = parts.next().and_then(|v| v.parse().ok()).unwrap_or(0);
    Ok((behind, ahead))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn git(dir: &Path, args: &[&str]) {
        run(dir, args, proc::LOCAL_TIMEOUT, false).unwrap();
    }

    fn tmp() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("gvibe-sync-{}", nanoid::nanoid!(8)));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// A bare "remote" plus a working clone, both wired to each other.
    fn pair() -> (PathBuf, PathBuf) {
        let root = tmp();
        let remote = root.join("remote.git");
        std::fs::create_dir_all(&remote).unwrap();
        git(&remote, &["init", "--bare"]);
        let work = root.join("work");
        std::fs::create_dir_all(&work).unwrap();
        git(&work, &["init"]);
        git(&work, &["config", "user.email", "test@example.com"]);
        git(&work, &["config", "user.name", "Test"]);
        git(&work, &["checkout", "-b", "main"]);
        git(&work, &["remote", "add", "origin", remote.to_str().unwrap()]);
        (work, remote)
    }

    /// A second working copy of `remote`, checked out on `main` with an
    /// upstream already configured — so a plain `git push` works.
    fn second_copy(remote: &Path) -> PathBuf {
        let other = remote.parent().unwrap().join("other");
        let _ = run(
            remote.parent().unwrap(),
            &["clone", remote.to_str().unwrap(), other.to_str().unwrap()],
            proc::NETWORK_TIMEOUT,
            true,
        )
        .unwrap();
        git(&other, &["config", "user.email", "test@example.com"]);
        git(&other, &["config", "user.name", "Test"]);
        // `git init --bare` may leave HEAD on another branch; check out the real
        // one and set its upstream so the plain `git push` below works.
        let _ = run(&other, &["checkout", "main"], proc::LOCAL_TIMEOUT, false);
        git(&other, &["branch", "--set-upstream-to=origin/main", "main"]);
        other
    }

    #[test]
    fn synchronize_commits_and_pushes_local_work() {
        let (work, _remote) = pair();
        std::fs::write(work.join("a.txt"), b"one").unwrap();
        git(&work, &["add", "-A"]);
        git(&work, &["commit", "-m", "initial"]);
        // Establish the upstream on the bare remote.
        run(&work, &["push", "-u", "origin", "main"], proc::NETWORK_TIMEOUT, true).unwrap();

        std::fs::write(work.join("a.txt"), b"two").unwrap();
        let report = synchronize(&work, Some("sync: local edit")).unwrap();
        assert!(report.ok, "{:?}", report.steps);
        assert!(report.committed);
        assert!(report.pushed);
        assert_eq!(report.branch, "main");

        // Second run with a clean tree is a clean no-op.
        let again = synchronize(&work, None).unwrap();
        assert!(again.ok, "{:?}", again.steps);
        assert!(!again.committed);
        assert!(!again.pushed);

        std::fs::remove_dir_all(work.parent().unwrap()).ok();
    }

    #[test]
    fn synchronize_fast_forwards_when_only_behind() {
        let (work, remote) = pair();
        std::fs::write(work.join("a.txt"), b"one").unwrap();
        git(&work, &["add", "-A"]);
        git(&work, &["commit", "-m", "initial"]);
        run(&work, &["push", "-u", "origin", "main"], proc::NETWORK_TIMEOUT, true).unwrap();

        // A second clone advances the remote.
        let other = second_copy(&remote);
        std::fs::write(other.join("b.txt"), b"remote").unwrap();
        git(&other, &["add", "-A"]);
        git(&other, &["commit", "-m", "remote change"]);
        run(&other, &["push"], proc::NETWORK_TIMEOUT, true).unwrap();

        let report = synchronize(&work, None).unwrap();
        assert!(report.ok, "{:?}", report.steps);
        assert!(report.pulled);
        assert!(report.fast_forward);
        assert!(work.join("b.txt").exists());

        std::fs::remove_dir_all(work.parent().unwrap()).ok();
    }

    #[test]
    fn diverged_history_merges() {
        let (work, remote) = pair();
        std::fs::write(work.join("a.txt"), b"one").unwrap();
        git(&work, &["add", "-A"]);
        git(&work, &["commit", "-m", "initial"]);
        run(&work, &["push", "-u", "origin", "main"], proc::NETWORK_TIMEOUT, true).unwrap();

        let other = second_copy(&remote);
        std::fs::write(other.join("remote.txt"), b"remote").unwrap();
        git(&other, &["add", "-A"]);
        git(&other, &["commit", "-m", "remote change"]);
        run(&other, &["push"], proc::NETWORK_TIMEOUT, true).unwrap();

        std::fs::write(work.join("local.txt"), b"local").unwrap();
        let report = synchronize(&work, Some("sync: local")).unwrap();

        assert!(report.ok, "{:?}", report.steps);
        assert!(report.pulled);
        assert!(!report.fast_forward, "diverged history must merge");
        assert!(work.join("remote.txt").exists());
        assert!(work.join("local.txt").exists());

        std::fs::remove_dir_all(work.parent().unwrap()).ok();
    }

    #[test]
    fn non_repo_is_a_clear_error() {
        let dir = tmp();
        let err = synchronize(&dir, None).unwrap_err();
        assert!(err.contains("isn't a git repository"), "{err}");
        std::fs::remove_dir_all(&dir).ok();
    }
}
