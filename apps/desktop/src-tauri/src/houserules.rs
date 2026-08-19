//! House rules — standing instructions appended to the end of every prompt.
//!
//! Without them the user retypes the same tail on each message ("don't
//! over-engineer, be tasteful, tweak what's already there"). The catalog below
//! turns that into toggles plus free text of their own.
//!
//! Rendering lives here rather than in the webview because auto mode builds its
//! builder prompts in Rust: one catalog, one renderer, both paths identical.

use serde::{Deserialize, Serialize};

/// One toggleable directive. `text` is what actually reaches the agent; `label`
/// and `hint` are UI only.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HouseRule {
    pub id: &'static str,
    pub label: &'static str,
    pub hint: &'static str,
    pub text: &'static str,
    pub default_on: bool,
}

/// Order here is render order, so the block reads the same on every turn.
/// The first three are the discipline rules, then the two that stop the most
/// common failures (unverified work, invented APIs), then taste and clarity.
pub const CATALOG: &[HouseRule] = &[
    HouseRule {
        id: "scope",
        label: "Stay in scope",
        hint: "Do what was asked, then stop.",
        text: "Do exactly what I asked and stop there. No extra features, no options, and no abstractions I did not ask for.",
        default_on: true,
    },
    HouseRule {
        id: "reuse",
        label: "Reuse before building",
        hint: "Extend what exists instead of adding a parallel system.",
        text: "Before adding anything new, look for an existing scene, node, or script that already does most of this and extend or simplify that instead. Tell me what you reused.",
        default_on: true,
    },
    HouseRule {
        id: "taste",
        label: "Keep it tasteful",
        hint: "The smallest readable change that fits the project.",
        text: "Match the naming, structure, and style already in this project. Prefer the smallest readable change over a clever one, and delete whatever your change makes redundant.",
        default_on: true,
    },
    HouseRule {
        id: "verify",
        label: "Prove it works",
        hint: "Run godot_verify before calling it done.",
        text: "After any script or scene change, run godot_verify and keep working until it passes, and run godot_test_run when the project has a test runner. Never tell me something is done when you have not watched it check out clean.",
        default_on: true,
    },
    HouseRule {
        id: "api",
        label: "Never guess an API",
        hint: "Confirm members with godot_reflect first.",
        text: "Before writing code against a Godot or addon API, confirm the class and member exist with godot_reflect. Do not write signatures from memory.",
        default_on: true,
    },
    HouseRule {
        id: "tunables",
        label: "Expose the knobs",
        hint: "Feel values belong in the Inspector, not in constants.",
        text: "Expose the values that decide how the game feels - speed, damping, durations, thresholds - as @export variables with sensible defaults, so I can tune them in the Inspector without editing code.",
        default_on: true,
    },
    HouseRule {
        id: "plain",
        label: "Explain it plainly",
        hint: "A short, jargon-free summary at the end.",
        text: "Finish with a short plain-language summary: what changed, and what I should do in the Editor to see it. No jargon and no long bullet lists.",
        default_on: true,
    },
    HouseRule {
        id: "performance",
        label: "Mind the frame budget",
        hint: "No per-frame lookups or allocations.",
        text: "Respect the frame budget: cache node lookups in @onready variables instead of calling get_node every frame, avoid allocating in _process and _physics_process, and say so when a change is likely to cost performance.",
        default_on: false,
    },
    HouseRule {
        id: "ask",
        label: "Ask when it is ambiguous",
        hint: "Check with me rather than guessing.",
        text: "If my request could reasonably mean two different things, stop and ask which one I meant instead of guessing and building the wrong thing.",
        default_on: false,
    },
];

const HEADER: &str = "--- House rules ---";

/// The user's selection. Absent from an older settings file means "never
/// chosen", which deserializes to the recommended defaults below.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HouseRules {
    /// Ids of enabled catalog rules. Ids no longer in the catalog are ignored.
    /// A missing key means "never chosen" and yields the recommended set; an
    /// explicitly empty list is a real choice and stays empty.
    #[serde(default = "recommended")]
    pub enabled: Vec<String>,
    /// The user's own instructions, one per line, appended after the presets.
    #[serde(default)]
    pub custom: String,
}

fn recommended() -> Vec<String> {
    CATALOG
        .iter()
        .filter(|rule| rule.default_on)
        .map(|rule| rule.id.to_string())
        .collect()
}

impl Default for HouseRules {
    fn default() -> Self {
        Self {
            enabled: recommended(),
            custom: String::new(),
        }
    }
}

impl HouseRules {
    /// The block to append to a prompt, or `None` when nothing is enabled.
    pub fn block(&self) -> Option<String> {
        let mut lines: Vec<String> = CATALOG
            .iter()
            .filter(|rule| self.enabled.iter().any(|id| id == rule.id))
            .map(|rule| format!("- {}", rule.text))
            .collect();
        lines.extend(custom_lines(&self.custom));
        if lines.is_empty() {
            return None;
        }
        Some(format!("{HEADER}\n{}", lines.join("\n")))
    }

    /// `prompt` with the block appended. Last position on purpose: it is where
    /// the user used to type these by hand, and the agent reads it last.
    pub fn apply(&self, prompt: &str) -> String {
        match self.block() {
            Some(block) if prompt.trim().is_empty() => block,
            Some(block) => format!("{prompt}\n\n{block}"),
            None => prompt.to_string(),
        }
    }
}

/// Free text becomes one bullet per non-empty line, with any bullet the user
/// typed themselves stripped so the block never reads "- - ".
fn custom_lines(custom: &str) -> Vec<String> {
    custom
        .lines()
        .map(|line| line.trim().trim_start_matches(['-', '*', '\u{2022}']).trim())
        .filter(|line| !line.is_empty())
        .map(|line| format!("- {line}"))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn catalog_ids_are_unique_and_stable() {
        let mut ids: Vec<&str> = CATALOG.iter().map(|rule| rule.id).collect();
        let count = ids.len();
        ids.sort_unstable();
        ids.dedup();
        assert_eq!(ids.len(), count, "house rule ids must be unique");
        assert!(CATALOG.iter().all(|rule| !rule.text.trim().is_empty()));
    }

    #[test]
    fn defaults_enable_the_recommended_set_and_nothing_else() {
        let rules = HouseRules::default();
        for rule in CATALOG {
            assert_eq!(
                rules.enabled.iter().any(|id| id == rule.id),
                rule.default_on,
                "default mismatch for {}",
                rule.id
            );
        }
        let block = rules.block().expect("defaults must render a block");
        assert!(block.starts_with(HEADER));
        assert!(block.contains("godot_verify"));
        assert!(!block.contains("frame budget"), "opt-in rules stay off");
    }

    #[test]
    fn an_older_settings_file_adopts_the_defaults() {
        let rules: HouseRules = serde_json::from_str("{}").expect("must deserialize");
        assert_eq!(rules.enabled, HouseRules::default().enabled);
        // An explicit empty selection is a real choice, not a missing field.
        let cleared: HouseRules =
            serde_json::from_str(r#"{"enabled":[],"custom":""}"#).expect("must deserialize");
        assert!(cleared.enabled.is_empty());
        assert_eq!(cleared.block(), None);
    }

    #[test]
    fn rules_render_in_catalog_order_regardless_of_selection_order() {
        let rules = HouseRules {
            enabled: vec!["plain".into(), "scope".into(), "nonexistent".into()],
            custom: String::new(),
        };
        let block = rules.block().expect("block");
        let scope = block.find("Do exactly what I asked").expect("scope rule");
        let plain = block.find("plain-language summary").expect("plain rule");
        assert!(scope < plain);
        assert_eq!(block.lines().count(), 3, "unknown ids are dropped");
    }

    #[test]
    fn custom_text_becomes_one_bullet_per_line_without_doubling_dashes() {
        let rules = HouseRules {
            enabled: Vec::new(),
            custom: "- keep the art style flat\n\n  * no new packages  \n".into(),
        };
        let block = rules.block().expect("block");
        assert_eq!(
            block,
            "--- House rules ---\n- keep the art style flat\n- no new packages"
        );
    }

    #[test]
    fn apply_appends_after_the_prompt_and_is_a_no_op_when_empty() {
        let rules = HouseRules {
            enabled: vec!["scope".into()],
            custom: String::new(),
        };
        let applied = rules.apply("make the cube red");
        assert!(applied.starts_with("make the cube red\n\n--- House rules ---\n- "));

        let none = HouseRules {
            enabled: Vec::new(),
            custom: "   \n".into(),
        };
        assert_eq!(none.apply("make the cube red"), "make the cube red");
    }
}
