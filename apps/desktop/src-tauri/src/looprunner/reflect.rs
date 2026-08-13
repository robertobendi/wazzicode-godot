//! Pure loop reflection + decision logic.
//!
//! The auto-loop deliberately keeps its "brain" free of a second LLM: after a
//! builder turn we parse the fenced JSON verdict the builder was told to emit,
//! and every stop/continue/blocked decision is a plain function of the parsed
//! verdict, the strike streak, the running cost, and the stop flag. Splitting
//! this out from the spawning IO (in `mod.rs`) is what makes the state machine
//! unit-testable without ever launching Claude.

use serde::Deserialize;

/// The builder's self-reported verdict for an iteration.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Verdict {
    Done,
    Continue,
    Blocked,
    /// The verdict block was missing, unparseable, or an unrecognized status.
    Unknown,
}

impl Verdict {
    pub fn as_str(&self) -> &'static str {
        match self {
            Verdict::Done => "done",
            Verdict::Continue => "continue",
            Verdict::Blocked => "blocked",
            Verdict::Unknown => "unknown",
        }
    }
}

/// Parsed builder verdict block.
#[derive(Debug, Clone)]
pub struct BuilderReflection {
    pub verdict: Verdict,
    pub summary: String,
    pub screenshot_path: Option<String>,
}

#[derive(Deserialize)]
struct BuilderRaw {
    status: String,
    #[serde(default)]
    summary: String,
    #[serde(default, rename = "screenshotPath")]
    screenshot_path: Option<String>,
}

/// What the project's ground-truth gate (`unity_qa`) returned when the critic
/// ran it. This is the one part of a QA verdict that is not the reviewer's
/// opinion — compile status, console errors, tests, missing scripts and
/// dangling references all come back as structured checks.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Gate {
    Pass,
    Fail,
    /// The gate could not run, or the critic never reported it. Both mean the
    /// same thing to the loop: the work is unproven, so `done` is not accepted.
    Unavailable,
}

/// Parsed QA critic block.
#[derive(Debug, Clone)]
pub struct QaReflection {
    pub pass: bool,
    pub gate: Gate,
    pub score: Option<f64>,
    pub notes: String,
}

impl QaReflection {
    /// The verdict the loop acts on: the reviewer's judgement **and** a passing
    /// gate. A reviewer who likes the screenshot cannot finish the loop over a
    /// failing compile or a red test.
    pub fn accepted(&self) -> bool {
        self.pass && self.gate == Gate::Pass
    }

    /// What to hand the next builder turn. When the gate is what blocked an
    /// otherwise-positive review, say so — otherwise the builder reads glowing
    /// notes and has no idea why it was sent back.
    pub fn feedback(&self) -> String {
        let notes = self.notes.trim();
        match (self.pass, self.gate) {
            (_, Gate::Pass) => notes.to_string(),
            (true, Gate::Fail) => format!(
                "unity_qa failed, so this is not done regardless of how it looks. \
                 Run unity_qa yourself, fix every failing check, and re-verify. \
                 Reviewer notes: {notes}"
            ),
            (true, Gate::Unavailable) => format!(
                "unity_qa did not run, so nothing is proven. Get it running \
                 (check the Unity bridge is connected) and make it pass before \
                 claiming done. Reviewer notes: {notes}"
            ),
            (false, _) => notes.to_string(),
        }
    }
}

#[derive(Deserialize)]
struct QaRaw {
    pass: bool,
    #[serde(default)]
    gate: Option<String>,
    #[serde(default)]
    score: Option<f64>,
    #[serde(default)]
    notes: String,
}

/// The next step the driver should take, decided purely.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Step {
    /// Advance to the next builder iteration.
    Continue,
    /// Builder reported done and QA is enabled — run the QA critic.
    RunQa,
    /// Terminal: the goal is achieved.
    Done,
    /// Terminal: builder is stuck (blocked verdict or two strikes).
    Blocked,
    /// Terminal: iteration budget exhausted.
    MaxIterations,
    /// Terminal: cumulative cost cap hit.
    CostCapped,
    /// Terminal: user asked to stop.
    Stopped,
}

/// Extract the inner text of the **last** fenced code block in `text`.
///
/// Tolerant of ```` ```json ````/bare ```` ``` ```` fences, surrounding
/// whitespace, and any prose after the block — the builder is told to end with
/// the block but models sometimes add a trailing line. Returns `None` when no
/// complete fenced block exists.
pub fn last_fenced_block(text: &str) -> Option<String> {
    // ``` + optional language tag, then the body (non-greedy, spanning lines)
    // up to the next ```. `(?s)` makes `.` match newlines.
    let re = regex::Regex::new(r"(?s)```[ \t]*[A-Za-z0-9_+-]*[ \t]*\r?\n?(.*?)```").ok()?;
    let last = re.captures_iter(text).last()?;
    Some(last.get(1)?.as_str().trim().to_string())
}

/// Parse a builder verdict from its result text. `None` if no JSON block
/// parses; callers usually want [`reflect_builder`], which folds that into an
/// `Unknown` verdict.
pub fn parse_builder(text: &str) -> Option<BuilderReflection> {
    let block = last_fenced_block(text)?;
    let raw: BuilderRaw = serde_json::from_str(&block).ok()?;
    let verdict = match raw.status.trim().to_ascii_lowercase().as_str() {
        "done" => Verdict::Done,
        "continue" => Verdict::Continue,
        "blocked" => Verdict::Blocked,
        _ => Verdict::Unknown,
    };
    let screenshot_path = raw.screenshot_path.filter(|s| !s.trim().is_empty());
    Some(BuilderReflection {
        verdict,
        summary: raw.summary.trim().to_string(),
        screenshot_path,
    })
}

/// Reflect on a builder turn, mapping missing/unparseable output to `Unknown`.
pub fn reflect_builder(text: &str) -> BuilderReflection {
    parse_builder(text).unwrap_or(BuilderReflection {
        verdict: Verdict::Unknown,
        summary: String::new(),
        screenshot_path: None,
    })
}

/// Parse a QA critic verdict. `None` when the block is missing/unparseable
/// (the driver treats that as a fail — never a silent pass).
pub fn parse_qa(text: &str) -> Option<QaReflection> {
    let block = last_fenced_block(text)?;
    let raw: QaRaw = serde_json::from_str(&block).ok()?;
    let gate = match raw.gate.as_deref().map(str::trim).unwrap_or("") {
        g if g.eq_ignore_ascii_case("pass") => Gate::Pass,
        g if g.eq_ignore_ascii_case("fail") => Gate::Fail,
        _ => Gate::Unavailable,
    };
    Some(QaReflection {
        pass: raw.pass,
        gate,
        score: raw.score,
        notes: raw.notes.trim().to_string(),
    })
}

/// New strike count after an iteration whose builder verdict was `verdict`.
/// `Unknown` extends the streak; any real verdict resets it.
pub fn next_strikes(verdict: Verdict, strikes: u32) -> u32 {
    if verdict == Verdict::Unknown {
        strikes + 1
    } else {
        0
    }
}

/// Accumulate a turn's cost onto the running total (missing cost counts as 0).
pub fn add_cost(total: f64, turn: Option<f64>) -> f64 {
    total + turn.unwrap_or(0.0)
}

/// Decision immediately after a builder turn (strikes already updated for it).
pub fn decide_after_builder(
    stop_requested: bool,
    total_cost: f64,
    max_cost: f64,
    verdict: Verdict,
    strikes: u32,
    qa_enabled: bool,
) -> Step {
    if stop_requested {
        return Step::Stopped;
    }
    if total_cost >= max_cost {
        return Step::CostCapped;
    }
    if strikes >= 2 {
        return Step::Blocked;
    }
    match verdict {
        Verdict::Blocked => Step::Blocked,
        Verdict::Done => {
            if qa_enabled {
                Step::RunQa
            } else {
                Step::Done
            }
        }
        Verdict::Continue | Verdict::Unknown => Step::Continue,
    }
}

/// Decision after a QA turn. Takes the *effective* verdict
/// ([`QaReflection::accepted`] — reviewer judgement AND a passing `unity_qa`
/// gate); `None` means the QA block was unparseable. Anything but `Some(true)`
/// keeps iterating, never a silent pass.
pub fn decide_after_qa(
    stop_requested: bool,
    total_cost: f64,
    max_cost: f64,
    qa_accepted: Option<bool>,
) -> Step {
    if stop_requested {
        return Step::Stopped;
    }
    if total_cost >= max_cost {
        return Step::CostCapped;
    }
    match qa_accepted {
        Some(true) => Step::Done,
        _ => Step::Continue,
    }
}

/// Pending user guidance gets a safe chance to redirect the next builder
/// before a done/blocked verdict terminates the loop. Stop and cost remain hard
/// limits.
pub fn feedback_step(
    stop_requested: bool,
    total_cost: f64,
    max_cost: f64,
    has_feedback: bool,
) -> Option<Step> {
    if !has_feedback {
        return None;
    }
    if stop_requested {
        return Some(Step::Stopped);
    }
    if total_cost >= max_cost {
        return Some(Step::CostCapped);
    }
    Some(Step::Continue)
}

/// Gate a would-be `Continue` on the iteration budget: if advancing to
/// `next_index` would meet/exceed `max_iterations`, stop instead.
pub fn gate_iterations(next_index: u32, max_iterations: u32) -> Step {
    if next_index >= max_iterations {
        Step::MaxIterations
    } else {
        Step::Continue
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extracts_simple_json_block() {
        let text = "Here goes:\n```json\n{\"status\":\"done\"}\n```";
        assert_eq!(last_fenced_block(text).unwrap(), "{\"status\":\"done\"}");
    }

    #[test]
    fn tolerates_text_after_the_block() {
        let text = "```json\n{\"status\":\"continue\"}\n```\nThanks, hope that helps!";
        let v = reflect_builder(text);
        assert_eq!(v.verdict, Verdict::Continue);
    }

    #[test]
    fn takes_the_last_of_multiple_blocks() {
        let text = "```json\n{\"status\":\"continue\"}\n```\nand then\n```json\n{\"status\":\"done\",\"summary\":\"all set\"}\n```";
        let v = reflect_builder(text);
        assert_eq!(v.verdict, Verdict::Done);
        assert_eq!(v.summary, "all set");
    }

    #[test]
    fn handles_bare_fence_without_language_tag() {
        let text = "```\n{\"status\":\"blocked\",\"summary\":\"missing asset\"}\n```";
        let v = reflect_builder(text);
        assert_eq!(v.verdict, Verdict::Blocked);
        assert_eq!(v.summary, "missing asset");
    }

    #[test]
    fn missing_block_is_unknown() {
        let v = reflect_builder("I did some work but forgot the block.");
        assert_eq!(v.verdict, Verdict::Unknown);
        assert!(parse_builder("no block here").is_none());
    }

    #[test]
    fn malformed_json_is_unknown() {
        let v = reflect_builder("```json\n{status: done,,,}\n```");
        assert_eq!(v.verdict, Verdict::Unknown);
    }

    #[test]
    fn unrecognized_status_is_unknown() {
        let v = reflect_builder("```json\n{\"status\":\"in_progress\"}\n```");
        assert_eq!(v.verdict, Verdict::Unknown);
    }

    #[test]
    fn captures_screenshot_path_and_drops_empty() {
        let with = reflect_builder(
            "```json\n{\"status\":\"continue\",\"screenshotPath\":\"/tmp/a.png\"}\n```",
        );
        assert_eq!(with.screenshot_path.as_deref(), Some("/tmp/a.png"));
        let without =
            reflect_builder("```json\n{\"status\":\"continue\",\"screenshotPath\":\"\"}\n```");
        assert_eq!(without.screenshot_path, None);
    }

    #[test]
    fn parses_qa_block() {
        let qa =
            parse_qa("```json\n{\"pass\":true,\"score\":8,\"notes\":\"looks good\"}\n```").unwrap();
        assert!(qa.pass);
        assert_eq!(qa.score, Some(8.0));
        assert_eq!(qa.notes, "looks good");

        let fail =
            parse_qa("```json\n{\"pass\":false,\"notes\":\"the cube is blue not red\"}\n```")
                .unwrap();
        assert!(!fail.pass);
        assert_eq!(fail.score, None);

        assert!(parse_qa("no verdict emitted").is_none());
    }

    #[test]
    fn qa_gate_is_parsed_and_defaults_to_unavailable() {
        let passed =
            parse_qa("```json\n{\"pass\":true,\"gate\":\"PASS\",\"notes\":\"ok\"}\n```").unwrap();
        assert_eq!(passed.gate, Gate::Pass);

        let failed =
            parse_qa("```json\n{\"pass\":true,\"gate\":\"fail\",\"notes\":\"ok\"}\n```").unwrap();
        assert_eq!(failed.gate, Gate::Fail);

        // A critic that never reports the gate has proven nothing.
        let silent = parse_qa("```json\n{\"pass\":true,\"notes\":\"ok\"}\n```").unwrap();
        assert_eq!(silent.gate, Gate::Unavailable);

        let nonsense =
            parse_qa("```json\n{\"pass\":true,\"gate\":\"probably?\",\"notes\":\"\"}\n```").unwrap();
        assert_eq!(nonsense.gate, Gate::Unavailable);
    }

    #[test]
    fn a_passing_review_over_a_failing_gate_is_not_accepted() {
        let looks_fine = |gate: &str| {
            parse_qa(&format!(
                "```json\n{{\"pass\":true,\"gate\":\"{gate}\",\"notes\":\"looks great\"}}\n```"
            ))
            .unwrap()
        };

        assert!(looks_fine("pass").accepted());
        assert!(!looks_fine("fail").accepted());
        assert!(!looks_fine("unavailable").accepted());

        // ...and the loop keeps going rather than finishing on the opinion.
        assert_eq!(
            decide_after_qa(false, 0.0, 5.0, Some(looks_fine("fail").accepted())),
            Step::Continue
        );
        assert_eq!(
            decide_after_qa(false, 0.0, 5.0, Some(looks_fine("pass").accepted())),
            Step::Done
        );
    }

    #[test]
    fn gate_rejection_tells_the_builder_why_it_came_back() {
        let blocked =
            parse_qa("```json\n{\"pass\":true,\"gate\":\"fail\",\"notes\":\"looks great\"}\n```")
                .unwrap();
        let feedback = blocked.feedback();
        assert!(feedback.contains("unity_qa failed"));
        assert!(feedback.contains("looks great"));

        // A genuine reviewer rejection is passed through untouched.
        let honest =
            parse_qa("```json\n{\"pass\":false,\"gate\":\"pass\",\"notes\":\"cube is blue\"}\n```")
                .unwrap();
        assert_eq!(honest.feedback(), "cube is blue");
    }

    #[test]
    fn strike_streak_increments_then_resets() {
        let s1 = next_strikes(Verdict::Unknown, 0);
        assert_eq!(s1, 1);
        let s2 = next_strikes(Verdict::Unknown, s1);
        assert_eq!(s2, 2);
        // A real verdict resets the streak.
        assert_eq!(next_strikes(Verdict::Continue, s2), 0);
    }

    #[test]
    fn two_strikes_block_the_loop() {
        let step = decide_after_builder(false, 0.0, 5.0, Verdict::Unknown, 2, true);
        assert_eq!(step, Step::Blocked);
        // One strike does not block.
        let step = decide_after_builder(false, 0.0, 5.0, Verdict::Unknown, 1, true);
        assert_eq!(step, Step::Continue);
    }

    #[test]
    fn cost_accumulation_and_cap() {
        let mut total = 0.0;
        total = add_cost(total, Some(2.0));
        total = add_cost(total, None); // a turn with no reported cost
        total = add_cost(total, Some(3.5));
        assert!((total - 5.5).abs() < f64::EPSILON);
        // Over the cap → CostCapped regardless of a "done" verdict.
        let step = decide_after_builder(false, total, 5.0, Verdict::Done, 0, true);
        assert_eq!(step, Step::CostCapped);
    }

    #[test]
    fn done_runs_qa_when_enabled_else_finishes() {
        assert_eq!(
            decide_after_builder(false, 0.0, 5.0, Verdict::Done, 0, true),
            Step::RunQa
        );
        assert_eq!(
            decide_after_builder(false, 0.0, 5.0, Verdict::Done, 0, false),
            Step::Done
        );
    }

    #[test]
    fn stop_flag_short_circuits_every_stage() {
        // Stop wins over a done verdict, cost, everything.
        assert_eq!(
            decide_after_builder(true, 0.0, 5.0, Verdict::Done, 0, true),
            Step::Stopped
        );
        assert_eq!(decide_after_qa(true, 0.0, 5.0, Some(true)), Step::Stopped);
    }

    #[test]
    fn qa_pass_finishes_fail_or_unparseable_continues() {
        assert_eq!(decide_after_qa(false, 0.0, 5.0, Some(true)), Step::Done);
        assert_eq!(
            decide_after_qa(false, 0.0, 5.0, Some(false)),
            Step::Continue
        );
        assert_eq!(decide_after_qa(false, 0.0, 5.0, None), Step::Continue);
    }

    #[test]
    fn queued_feedback_reopens_the_plan_without_bypassing_hard_limits() {
        assert_eq!(feedback_step(false, 0.0, 5.0, true), Some(Step::Continue));
        assert_eq!(feedback_step(true, 0.0, 5.0, true), Some(Step::Stopped));
        assert_eq!(feedback_step(false, 5.0, 5.0, true), Some(Step::CostCapped));
        assert_eq!(feedback_step(false, 0.0, 5.0, false), None);
    }

    #[test]
    fn iteration_budget_gate() {
        assert_eq!(gate_iterations(3, 10), Step::Continue);
        assert_eq!(gate_iterations(10, 10), Step::MaxIterations);
        assert_eq!(gate_iterations(11, 10), Step::MaxIterations);
    }
}
