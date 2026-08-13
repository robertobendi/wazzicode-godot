import { describe, expect, it } from "vitest";
import {
  DEFAULT_QUICK_ACTIONS,
  coerceQuickActions,
  type QuickAction,
} from "./quickActions";

describe("DEFAULT_QUICK_ACTIONS", () => {
  it("ships three well-formed, plain-language actions", () => {
    expect(DEFAULT_QUICK_ACTIONS).toHaveLength(3);
    for (const a of DEFAULT_QUICK_ACTIONS) {
      expect(a.label.trim()).not.toBe("");
      expect(a.prompt.trim()).not.toBe("");
    }
    expect(DEFAULT_QUICK_ACTIONS[0].label).toBe("Fix whatever's broken");
  });
});

describe("coerceQuickActions", () => {
  it("returns the defaults for non-arrays", () => {
    expect(coerceQuickActions(null)).toBe(DEFAULT_QUICK_ACTIONS);
    expect(coerceQuickActions(undefined)).toBe(DEFAULT_QUICK_ACTIONS);
    expect(coerceQuickActions("nope")).toBe(DEFAULT_QUICK_ACTIONS);
    expect(coerceQuickActions({})).toBe(DEFAULT_QUICK_ACTIONS);
  });

  it("returns the defaults when no entry is valid", () => {
    expect(coerceQuickActions([])).toBe(DEFAULT_QUICK_ACTIONS);
    expect(coerceQuickActions([{ label: "  ", prompt: "" }])).toBe(
      DEFAULT_QUICK_ACTIONS,
    );
    expect(coerceQuickActions([{ label: "x" }, 5, null])).toBe(
      DEFAULT_QUICK_ACTIONS,
    );
  });

  it("keeps only well-formed entries from a valid override", () => {
    const input: unknown = [
      { label: "Do X", prompt: "Please do X" },
      { label: "bad" }, // missing prompt → dropped
      { label: "Do Y", prompt: "Please do Y" },
    ];
    const out = coerceQuickActions(input);
    expect(out).toEqual<QuickAction[]>([
      { label: "Do X", prompt: "Please do X" },
      { label: "Do Y", prompt: "Please do Y" },
    ]);
  });
});
