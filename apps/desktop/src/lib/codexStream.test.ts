import { describe, expect, it } from "vitest";
import { initialDraft, reduceStream, type StreamDraft } from "./streamMapper";

// Fixtures modeled on a real `codex exec --json` run: thread.started → reasoning
// → an MCP call into Unity → a shell command → the agent's answer → turn.completed.
//
// These go through `reduceStream` (not `reduceCodex`) on purpose: the dispatch by
// event shape is the thing that has to hold, since nothing upstream tells the
// reducer which backend produced the line.

const threadStarted = { type: "thread.started", thread_id: "0199-abc" };
const turnStarted = { type: "turn.started" };

const reasoning = {
  type: "item.completed",
  item: { id: "i0", type: "reasoning", text: "Thinking about the player controller." },
};

const mcpStarted = {
  type: "item.started",
  item: {
    id: "i1",
    type: "mcp_tool_call",
    server: "unity_vibe_os",
    tool: "unity_verify",
    arguments: { filter: "Player" },
  },
};
const mcpRawResult = JSON.stringify({
  ok: true,
  data: { pass: true, compiled: true, errorCount: 0 },
  warnings: [],
  meta: { source: "unity_bridge", durationMs: 8, detailLevel: "normal" },
});
const mcpCompleted = {
  type: "item.completed",
  item: {
    id: "i1",
    type: "mcp_tool_call",
    server: "unity_vibe_os",
    tool: "unity_verify",
    status: "completed",
    result: { content: [{ type: "text", text: mcpRawResult }] },
  },
};

const shellStarted = {
  type: "item.started",
  item: { id: "i2", type: "command_execution", command: "git status" },
};
const shellFailed = {
  type: "item.completed",
  item: {
    id: "i2",
    type: "command_execution",
    command: "git status",
    aggregated_output: "fatal: not a git repository",
    exit_code: 128,
    status: "completed",
  },
};

const agentMessage = {
  type: "item.completed",
  item: { id: "i3", type: "agent_message", text: "Added a jump to the player." },
};

const turnCompleted = {
  type: "turn.completed",
  usage: { input_tokens: 1200, cached_input_tokens: 800, output_tokens: 300 },
};

function fold(lines: unknown[]): StreamDraft {
  return lines.reduce<StreamDraft>((d, l) => reduceStream(d, l), initialDraft());
}

describe("reduceStream over Codex events", () => {
  it("captures the thread id so the next turn can resume it", () => {
    expect(fold([threadStarted]).sessionId).toBe("0199-abc");
  });

  it("takes the agent_message as the visible answer", () => {
    const d = fold([threadStarted, turnStarted, agentMessage, turnCompleted]);
    expect(d.text).toBe("Added a jump to the player.");
    expect(d.done).toBe(true);
    expect(d.isError).toBe(false);
  });

  it("concatenates multiple agent messages in one turn", () => {
    const second = {
      type: "item.completed",
      item: { id: "i4", type: "agent_message", text: "Also fixed the camera." },
    };
    expect(fold([agentMessage, second]).text).toBe(
      "Added a jump to the player.\n\nAlso fixed the camera.",
    );
  });

  it("reports tokens and NO cost — a $0 turn would defeat the loop's budget cap", () => {
    const d = fold([turnCompleted]);
    expect(d.tokens).toBe(1500);
    expect(d.cost).toBeUndefined();
  });

  it("turns an MCP call into a Unity-labelled activity and resolves it", () => {
    const running = fold([mcpStarted]);
    expect(running.activities).toHaveLength(1);
    expect(running.activities[0].status).toBe("running");
    // The (server, tool) pair must normalize onto Claude's flat name so the
    // shared label table applies.
    expect(running.activities[0].name).toBe("mcp__unity-vibe-os__unity_verify");
    expect(running.activities[0].friendlyLabel).toBe(
      "Checking everything compiles and tests pass",
    );

    const done = fold([mcpStarted, mcpCompleted]);
    expect(done.activities).toHaveLength(1); // updated in place, not duplicated
    expect(done.activities[0].status).toBe("ok");
    expect(done.activities[0].resultText).toContain('"pass":true');
    expect(done.activities[0].resultRaw).toBe(mcpRawResult);
    expect(done.activities[0].resultRawTruncated).toBeUndefined();
    expect(done.hasUnityTools).toBe(true);
  });

  it("marks a shell command that exited non-zero as an error", () => {
    const d = fold([shellStarted, shellFailed]);
    expect(d.activities).toHaveLength(1);
    expect(d.activities[0].status).toBe("error");
    expect(d.activities[0].friendlyLabel).toBe("Running a command");
    expect(d.activities[0].resultText).toContain("not a git repository");
  });

  it("does not show private reasoning as text or as a tool chip", () => {
    const d = fold([reasoning]);
    expect(d.text).toBe("");
    expect(d.activities).toHaveLength(0);
  });

  it("surfaces turn.failed as an error with its message", () => {
    const d = fold([
      threadStarted,
      { type: "turn.failed", error: { message: "model overloaded" } },
    ]);
    expect(d.isError).toBe(true);
    expect(d.done).toBe(true);
    expect(d.text).toContain("model overloaded");
  });

  it("keeps the answer when a stray error event arrives after it", () => {
    const d = fold([agentMessage, { type: "error", message: "stream hiccup" }]);
    expect(d.isError).toBe(true);
    expect(d.text).toBe("Added a jump to the player."); // answer not clobbered
  });

  it("ignores unknown item types rather than crashing", () => {
    const d = fold([
      { type: "item.completed", item: { id: "x", type: "some_future_thing" } },
      { type: "turn.completed" },
    ]);
    expect(d.activities).toHaveLength(0);
    expect(d.done).toBe(true);
  });
});

describe("backend dispatch", () => {
  it("still reduces a Claude stream — the two vocabularies do not collide", () => {
    const d = fold([
      { type: "system", subtype: "init", session_id: "claude-1", tools: ["Read"] },
      {
        type: "stream_event",
        event: {
          type: "content_block_delta",
          delta: { type: "text_delta", text: "Hi" },
        },
      },
      { type: "result", total_cost_usd: 0.02, is_error: false, result: "Hi" },
    ]);
    expect(d.sessionId).toBe("claude-1");
    expect(d.text).toBe("Hi");
    expect(d.cost).toBe(0.02);
    expect(d.tokens).toBeUndefined();
  });
});
