import { describe, it, expect } from "vitest";
import { initialDraft, reduceStream, type StreamDraft } from "./streamMapper";
import { MAX_MCP_RESULT_TEXT_CHARS } from "./unityDiagnostics";

// Fixtures modeled on real Claude Code 2.1.198 `-p --output-format stream-json
// --verbose --include-partial-messages` lines (fields trimmed to what the
// mapper reads).

const initEvent = {
  type: "system",
  subtype: "init",
  session_id: "sess-abc",
  model: "claude-opus-4-8",
  tools: ["Read", "Edit", "mcp__unity-vibe-os__unity_orient"],
};

const initEventNoUnity = {
  type: "system",
  subtype: "init",
  session_id: "sess-xyz",
  tools: ["Read", "Edit"],
};

const textDelta = (text: string) => ({
  type: "stream_event",
  event: {
    type: "content_block_delta",
    index: 0,
    delta: { type: "text_delta", text },
  },
});

const toolUseAssistant = {
  type: "assistant",
  message: {
    role: "assistant",
    content: [
      {
        type: "tool_use",
        id: "toolu_1",
        name: "mcp__unity-vibe-os__unity_orient",
        input: { detail: "summary" },
      },
    ],
  },
};

const diagnosticToolUseAssistant = {
  type: "assistant",
  message: {
    role: "assistant",
    content: [
      {
        type: "tool_use",
        id: "toolu_1",
        name: "mcp__unity-vibe-os__unity_verify",
        input: {},
      },
    ],
  },
};

const toolResultUser = (isError = false) => ({
  type: "user",
  message: {
    role: "user",
    content: [
      {
        type: "tool_result",
        tool_use_id: "toolu_1",
        content: [{ type: "text", text: "Project: MyGame\nScenes open: 1" }],
        is_error: isError,
      },
    ],
  },
});

const resultEvent = {
  type: "result",
  subtype: "success",
  is_error: false,
  total_cost_usd: 0.1234,
  result: "Done — the cube is now red.",
  session_id: "sess-abc",
  num_turns: 3,
};

function fold(lines: unknown[]): StreamDraft {
  return lines.reduce<StreamDraft>((d, l) => reduceStream(d, l), initialDraft());
}

describe("reduceStream", () => {
  it("captures session id and unity-tool availability from init", () => {
    const d = reduceStream(initialDraft(), initEvent);
    expect(d.sessionId).toBe("sess-abc");
    expect(d.hasUnityTools).toBe(true);
    expect(d.toolsSeen).toContain("mcp__unity-vibe-os__unity_orient");
  });

  it("flags missing unity tools", () => {
    const d = reduceStream(initialDraft(), initEventNoUnity);
    expect(d.hasUnityTools).toBe(false);
  });

  it("accumulates streamed text deltas", () => {
    const d = fold([textDelta("Hel"), textDelta("lo"), textDelta("!")]);
    expect(d.text).toBe("Hello!");
  });

  it("adds a running activity on tool_use with a friendly label", () => {
    const d = fold([initEvent, toolUseAssistant]);
    expect(d.activities).toHaveLength(1);
    expect(d.activities[0]).toMatchObject({
      id: "toolu_1",
      toolUseId: "toolu_1",
      status: "running",
      friendlyLabel: "Getting oriented in Unity",
    });
  });

  it("resolves the activity to ok on a successful tool_result", () => {
    const d = fold([toolUseAssistant, toolResultUser(false)]);
    expect(d.activities[0].status).toBe("ok");
    expect(d.activities[0].resultText).toContain("Project: MyGame");
    expect(d.activities[0].resultRaw).toBeUndefined();
    expect(d.activities[0].endedAt).toBeTypeOf("number");
  });

  it("preserves the original MCP text separately from the short chip summary", () => {
    const raw = JSON.stringify(
      {
        ok: true,
        data: { pass: false, problems: [{ message: "A detailed failure" }] },
        warnings: [],
        meta: { source: "unity_bridge", durationMs: 4, detailLevel: "normal" },
      },
      null,
      2,
    );
    const result = {
      type: "user",
      message: {
        content: [
          {
            type: "tool_result",
            tool_use_id: "toolu_1",
            content: [{ type: "text", text: raw }],
          },
        ],
      },
    };
    const d = fold([diagnosticToolUseAssistant, result]);
    expect(d.activities[0].resultRaw).toBe(raw);
    expect(d.activities[0].resultRawTruncated).toBeUndefined();
    expect(d.activities[0].resultText!.length).toBeLessThanOrEqual(201);
  });

  it("bounds preserved MCP text and records truncation", () => {
    const raw = "x".repeat(MAX_MCP_RESULT_TEXT_CHARS + 100);
    const result = {
      type: "user",
      message: {
        content: [
          {
            type: "tool_result",
            tool_use_id: "toolu_1",
            content: raw,
          },
        ],
      },
    };
    const d = fold([diagnosticToolUseAssistant, result]);
    expect(d.activities[0].resultRaw).toHaveLength(MAX_MCP_RESULT_TEXT_CHARS);
    expect(d.activities[0].resultRawTruncated).toBe(true);
    expect(d.activities[0].resultText).toHaveLength(201);
  });

  it("resolves the activity to error when tool_result is_error", () => {
    const d = fold([toolUseAssistant, toolResultUser(true)]);
    expect(d.activities[0].status).toBe("error");
  });

  it("does not duplicate an activity when the assistant block is re-sent", () => {
    const d = fold([toolUseAssistant, toolUseAssistant]);
    expect(d.activities).toHaveLength(1);
  });

  it("captures cost and done state from the result event", () => {
    const d = fold([textDelta("Done — the cube is now red."), resultEvent]);
    expect(d.done).toBe(true);
    expect(d.isError).toBe(false);
    expect(d.cost).toBeCloseTo(0.1234);
    expect(d.text).toBe("Done — the cube is now red.");
  });

  it("falls back to the result string when no text was streamed", () => {
    const d = fold([toolUseAssistant, toolResultUser(), resultEvent]);
    expect(d.text).toBe("Done — the cube is now red.");
  });

  it("ignores unknown / noise events without throwing", () => {
    const before = fold([initEvent, textDelta("hi")]);
    const after = [
      { type: "system", subtype: "hook_started" },
      { type: "system", subtype: "status", status: "requesting" },
      { type: "rate_limit_event", rate_limit_info: {} },
      { type: "stream_event", event: { type: "message_stop" } },
      null,
      "garbage",
      42,
    ].reduce<StreamDraft>((d, l) => reduceStream(d, l), before);
    expect(after).toEqual(before);
  });

  it("runs a full end-to-end turn", () => {
    const d = fold([
      initEvent,
      toolUseAssistant,
      toolResultUser(false),
      textDelta("All set."),
      resultEvent,
    ]);
    expect(d.sessionId).toBe("sess-abc");
    expect(d.activities[0].status).toBe("ok");
    expect(d.text).toBe("All set.");
    expect(d.done).toBe(true);
    expect(d.cost).toBeCloseTo(0.1234);
  });
});
