import { describe, expect, it } from "vitest";
import { summarizeEvent } from "./eventSummary";

describe("summarizeEvent — Codex", () => {
  it("names the Unity tool being called, not the wrapper item type", () => {
    const s = summarizeEvent({
      type: "item.started",
      item: {
        id: "i1",
        type: "mcp_tool_call",
        server: "unity_vibe_os",
        tool: "unity_verify",
        arguments: { filter: "Player" },
      },
    });
    expect(s.label).toBe("unity_verify");
    expect(s.level).toBe("tool");
    expect(s.detail).toContain("Player");
  });

  it("flags a failed MCP call as an error", () => {
    const s = summarizeEvent({
      type: "item.completed",
      item: {
        id: "i1",
        type: "mcp_tool_call",
        tool: "unity_verify",
        status: "failed",
        error: { message: "UNITY_NOT_CONNECTED" },
      },
    });
    expect(s.label).toBe("unity_verify (failed)");
    expect(s.level).toBe("error");
    expect(s.detail).toContain("UNITY_NOT_CONNECTED");
  });

  it("surfaces a non-zero shell exit as an error with its code", () => {
    const s = summarizeEvent({
      type: "item.completed",
      item: {
        id: "i2",
        type: "command_execution",
        aggregated_output: "fatal: not a git repository",
        exit_code: 128,
      },
    });
    expect(s.label).toBe("shell exit 128");
    expect(s.level).toBe("error");
  });

  it("reports tokens on turn.completed and the message on turn.failed", () => {
    const ok = summarizeEvent({
      type: "turn.completed",
      usage: { input_tokens: 100, output_tokens: 20 },
    });
    expect(ok.label).toBe("turn.completed");
    expect(ok.detail).toBe("120 tokens");

    const bad = summarizeEvent({
      type: "turn.failed",
      error: { message: "model overloaded" },
    });
    expect(bad.level).toBe("error");
    expect(bad.detail).toContain("model overloaded");
  });
});

describe("summarizeEvent — Claude", () => {
  it("names the tool on a tool_use block", () => {
    const s = summarizeEvent({
      type: "assistant",
      message: {
        content: [
          {
            type: "tool_use",
            id: "t1",
            name: "mcp__unity-vibe-os__unity_verify",
            input: { filter: "Player" },
          },
        ],
      },
    });
    // The MCP prefix is noise in a debug log.
    expect(s.label).toBe("unity_verify");
    expect(s.level).toBe("tool");
  });

  it("flags an errored tool_result", () => {
    const s = summarizeEvent({
      type: "user",
      message: {
        content: [
          { type: "tool_result", tool_use_id: "t1", is_error: true, content: "boom" },
        ],
      },
    });
    expect(s.label).toBe("tool failed");
    expect(s.level).toBe("error");
  });

  it("shows the cost on result", () => {
    const s = summarizeEvent({ type: "result", total_cost_usd: 0.1234 });
    expect(s.detail).toBe("$0.1234");
  });
});

describe("summarizeEvent — robustness", () => {
  it("handles raw strings and junk without throwing", () => {
    expect(summarizeEvent("some non-JSON line").label).toBe("raw");
    expect(summarizeEvent(null).label).toBe("unknown");
    expect(summarizeEvent({ type: "something.new" }).label).toBe("something.new");
  });
});
