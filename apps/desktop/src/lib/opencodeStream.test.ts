import { describe, it, expect } from "vitest";
import { initialDraft, reduceStream } from "./streamMapper";
import { isOpenCodeEvent } from "./opencodeStream";

// Fixtures modeled on real `opencode run --format json` (1.14.46) lines,
// trimmed to the fields the reducer reads.

const step = (type: string, sessionID = "ses_1") => ({
  type,
  sessionID,
  part: { type: type === "step_start" ? "step-start" : "step-finish" },
});

describe("isOpenCodeEvent", () => {
  it("recognizes opencode's vocabulary", () => {
    expect(isOpenCodeEvent({ type: "step_start" })).toBe(true);
    expect(isOpenCodeEvent({ type: "step_finish" })).toBe(true);
    expect(isOpenCodeEvent({ type: "text" })).toBe(true);
    expect(isOpenCodeEvent({ type: "tool_use" })).toBe(true);
    expect(isOpenCodeEvent({ type: "error", error: { name: "x" } })).toBe(true);
  });

  it("does not claim a Codex-style error", () => {
    expect(isOpenCodeEvent({ type: "error", message: "boom" })).toBe(false);
    expect(isOpenCodeEvent({ type: "item.completed" })).toBe(false);
  });
});

describe("reduceStream with opencode lines", () => {
  it("accumulates text chunks and the session id", () => {
    let draft = reduceStream(initialDraft(), step("step_start"));
    draft = reduceStream(draft, {
      type: "text",
      sessionID: "ses_1",
      part: { type: "text", text: "Hel" },
    });
    draft = reduceStream(draft, {
      type: "text",
      sessionID: "ses_1",
      part: { type: "text", text: "lo" },
    });
    expect(draft.text).toBe("Hello");
    expect(draft.sessionId).toBe("ses_1");
  });

  it("sums cost and tokens across steps", () => {
    let draft = reduceStream(initialDraft(), {
      type: "step_finish",
      part: { cost: 0.1, tokens: { input: 10, output: 2, cache: { read: 3 } } },
    });
    draft = reduceStream(draft, {
      type: "step_finish",
      part: { cost: 0.2, tokens: { input: 20, output: 4 } },
    });
    expect(draft.cost).toBeCloseTo(0.3);
    expect(draft.tokens).toBe(39);
  });

  it("upserts a tool chip from running to completed", () => {
    const running = {
      type: "tool_use",
      part: {
        type: "tool",
        tool: "bash",
        callID: "call_1",
        state: { status: "running", input: { command: "echo hi" } },
      },
    };
    const done = {
      type: "tool_use",
      part: {
        type: "tool",
        tool: "bash",
        callID: "call_1",
        state: {
          status: "completed",
          input: { command: "echo hi" },
          output: "hi\n",
        },
      },
    };
    let draft = reduceStream(initialDraft(), running);
    expect(draft.activities).toHaveLength(1);
    expect(draft.activities[0].status).toBe("running");
    expect(draft.activities[0].friendlyLabel).toBe("Running a command");

    draft = reduceStream(draft, done);
    expect(draft.activities).toHaveLength(1);
    expect(draft.activities[0].status).toBe("ok");
    expect(draft.activities[0].resultText).toBe("hi");
  });

  it("reuses the Godot label table for the namespaced MCP tools", () => {
    const draft = reduceStream(initialDraft(), {
      type: "tool_use",
      part: {
        type: "tool",
        tool: "godot-vibe-os_godot_orient",
        callID: "call_2",
        state: { status: "completed", output: "{}" },
      },
    });
    expect(draft.activities[0].friendlyLabel).toBe("Getting oriented in Godot");
    expect(draft.hasGodotTools).toBe(true);
  });

  it("turns an error event into an error draft", () => {
    const draft = reduceStream(initialDraft(), {
      type: "error",
      sessionID: "ses_1",
      error: { name: "ProviderError", data: { message: "no key" } },
    });
    expect(draft.isError).toBe(true);
    expect(draft.text).toBe("no key");
  });
});
