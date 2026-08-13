import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentRunOptions } from "@/types/agent";
import type { Settings } from "@/types/settings";

const mocks = vi.hoisted(() => ({
  chatSend: vi.fn(),
  chatCancel: vi.fn(),
  removeStaged: vi.fn(),
}));

vi.mock("@/api", () => ({
  api: {
    chatSend: mocks.chatSend,
    chatCancel: mocks.chatCancel,
    removeStaged: mocks.removeStaged,
  },
}));

import { useChatStore } from "./useChatStore";
import { useSettingsStore } from "./useSettingsStore";

const settings: Settings = {
  schemaVersion: 3,
  recentProjects: [],
  currentProject: "/project",
  agentBackend: "claude",
  model: null,
  codexModel: null,
  effort: null,
  codexEffort: null,
  theme: "system",
  debugDrawer: false,
  pairedOk: true,
  onboarded: true,
};

let projectNumber = 0;

describe("chat run snapshots", () => {
  beforeEach(() => {
    projectNumber += 1;
    mocks.chatSend.mockReset().mockResolvedValue("run-1");
    mocks.chatCancel.mockReset();
    mocks.removeStaged.mockReset().mockResolvedValue(undefined);
    useSettingsStore.getState().setSettings(settings);
    useChatStore.getState().setProject(`/project-${projectNumber}`);
  });

  it("passes and captures explicit controls for a new task", async () => {
    const options: AgentRunOptions = {
      backend: "codex",
      model: "gpt-5.6-sol",
      effort: "xhigh",
    };

    await useChatStore.getState().send("Build it", [], options);

    expect(mocks.chatSend).toHaveBeenCalledWith(
      `/project-${projectNumber}`,
      "Build it",
      null,
      options,
    );
    expect(useChatStore.getState().session).toMatchObject({
      backend: "codex",
      runOptions: options,
    });
  });

  it("keeps a loaded session's backend and controls when defaults change", async () => {
    useChatStore.getState().loadSession({
      sessionId: "claude-session",
      title: "Existing",
      createdAt: 1,
      updatedAt: 2,
      totalCostUsd: 0,
      messages: [],
      agentBackend: "claude",
      runOptions: { backend: "claude", model: "opus", effort: "high" },
    });

    await useChatStore.getState().send("Continue", [], {
      backend: "codex",
      model: "gpt-5.6-sol",
      effort: "low",
    });

    expect(mocks.chatSend).toHaveBeenCalledWith(
      `/project-${projectNumber}`,
      "Continue",
      "claude-session",
      { backend: "claude", model: "opus", effort: "high" },
    );
  });

  it("unfreezes a new conversation when the backend rejects startup", async () => {
    mocks.chatSend.mockRejectedValueOnce(new Error("model unavailable"));
    const options: AgentRunOptions = {
      backend: "codex",
      model: "bad-model",
      effort: "high",
    };

    await useChatStore.getState().send("Try it", [], options);

    expect(useChatStore.getState().session).toMatchObject({
      backend: null,
      runOptions: null,
      sessionId: null,
    });
    expect(useChatStore.getState().running).toBe(false);
  });

  it("maps auth failures using the task backend rather than current settings", async () => {
    mocks.chatSend.mockRejectedValueOnce(new Error("401 Unauthorized"));
    await useChatStore.getState().send("Try Codex", [], {
      backend: "codex",
      model: null,
      effort: null,
    });

    const assistant = useChatStore
      .getState()
      .messages.find((message) => message.role === "assistant");
    expect(assistant?.error).toContain("Codex isn't signed in");
  });

  it("cancels a run when stop is clicked before startup returns its id", async () => {
    let resolveRun: (runId: string) => void = () => undefined;
    mocks.chatSend.mockReturnValueOnce(
      new Promise<string>((resolve) => {
        resolveRun = resolve;
      }),
    );

    const send = useChatStore.getState().send("Start slowly");
    await useChatStore.getState().cancel();

    expect(mocks.chatCancel).not.toHaveBeenCalled();
    resolveRun("delayed-run");
    await send;

    expect(mocks.chatCancel).toHaveBeenCalledWith("delayed-run");
  });

  it("keeps queued tasks in FIFO order until each run fully settles", async () => {
    mocks.chatSend
      .mockResolvedValueOnce("run-1")
      .mockResolvedValueOnce("run-2")
      .mockResolvedValueOnce("run-3");
    const options: AgentRunOptions = {
      backend: "codex",
      model: "gpt-5.6-sol",
      effort: "high",
    };

    await useChatStore.getState().send("First", [], options);
    const secondResult = useChatStore.getState().submitTask("Second", [], {
      backend: "claude",
      model: "opus",
      effort: "low",
    });
    const thirdResult = useChatStore.getState().submitTask("Third");

    expect([secondResult, thirdResult]).toEqual(["queued", "queued"]);
    expect(mocks.chatSend).toHaveBeenCalledTimes(1);
    expect(useChatStore.getState().queuedTasks.map((task) => task.prompt)).toEqual([
      "Second",
      "Third",
    ]);
    expect(useChatStore.getState().queuedTasks[0].runOptions).toEqual(options);

    useChatStore.getState().finish("run-1", {
      sessionId: "codex-session",
      costUsd: null,
      tokens: 100,
      isError: false,
      resultText: "Done",
      numTurns: 1,
    });
    await useChatStore.getState().runNextQueued();

    expect(mocks.chatSend).toHaveBeenNthCalledWith(
      2,
      `/project-${projectNumber}`,
      "Second",
      "codex-session",
      options,
    );
    expect(useChatStore.getState().queuedTasks.map((task) => task.prompt)).toEqual([
      "Third",
    ]);

    useChatStore.getState().finish("run-2", {
      sessionId: "codex-session",
      costUsd: null,
      tokens: 50,
      isError: false,
      resultText: "Done again",
      numTurns: 1,
    });
    await useChatStore.getState().runNextQueued();

    expect(mocks.chatSend).toHaveBeenNthCalledWith(
      3,
      `/project-${projectNumber}`,
      "Third",
      "codex-session",
      options,
    );
    expect(useChatStore.getState().queuedTasks).toEqual([]);
  });

  it("atomically starts a task submitted just after the active run settles", async () => {
    mocks.chatSend
      .mockResolvedValueOnce("run-1")
      .mockResolvedValueOnce("run-2");
    await useChatStore.getState().send("First");
    useChatStore.getState().finish("run-1", {
      sessionId: "claude-session",
      costUsd: 0.01,
      tokens: null,
      isError: false,
      resultText: "Done",
      numTurns: 1,
    });

    const result = useChatStore.getState().submitTask("At the boundary");
    await vi.waitFor(() => expect(mocks.chatSend).toHaveBeenCalledTimes(2));

    expect(result).toBe("sent");
    expect(useChatStore.getState().queuedTasks).toEqual([]);
    expect(mocks.chatSend).toHaveBeenLastCalledWith(
      `/project-${projectNumber}`,
      "At the boundary",
      "claude-session",
      expect.objectContaining({ backend: "claude" }),
    );
  });

  it("pauses and preserves queued work when the active task cannot start", async () => {
    let rejectRun: (error: Error) => void = () => undefined;
    mocks.chatSend.mockReturnValueOnce(
      new Promise<string>((_resolve, reject) => {
        rejectRun = reject;
      }),
    );

    const first = useChatStore.getState().send("First");
    expect(useChatStore.getState().submitTask("Keep this for later")).toBe(
      "queued",
    );
    rejectRun(new Error("agent unavailable"));
    await first;

    expect(useChatStore.getState().running).toBe(false);
    expect(useChatStore.getState().queuedTasks.map((task) => task.prompt)).toEqual([
      "Keep this for later",
    ]);
    expect(useChatStore.getState().queuePauseReason).toMatch(/could not start/i);
  });

  it("preserves paused tasks and cleans up removed queued attachments", async () => {
    await useChatStore.getState().send("First");
    const id = useChatStore.getState().enqueue("Review this", [
      {
        id: "attachment-1",
        path: "/project/.unity-vibe/inbox/review.png",
        name: "review.png",
        kind: "image",
      },
    ]);
    useChatStore.getState().pauseQueue("Review the error, then resume.");

    expect(useChatStore.getState().queuePauseReason).toMatch(/resume/i);
    await useChatStore.getState().removeQueued(id!);

    expect(useChatStore.getState().queuedTasks).toEqual([]);
    expect(useChatStore.getState().queuePauseReason).toBeNull();
    expect(mocks.removeStaged).toHaveBeenCalledWith(
      "/project/.unity-vibe/inbox/review.png",
    );
  });

  it("settles a tool that never returned when its run finishes", async () => {
    await useChatStore.getState().send("Verify the project");
    useChatStore.getState().ingest("run-1", {
      type: "assistant",
      message: {
        content: [
          {
            type: "tool_use",
            id: "verify-1",
            name: "mcp__unity-vibe-os__unity_verify",
            input: {},
          },
        ],
      },
    });

    useChatStore.getState().finish("run-1", {
      sessionId: "claude-session",
      costUsd: 0,
      tokens: null,
      isError: true,
      resultText: "Stopped",
      numTurns: 1,
    });

    const activity = useChatStore
      .getState()
      .messages.find((message) => message.role === "assistant")
      ?.activities[0];
    expect(activity).toMatchObject({
      status: "error",
      resultText: "The run ended before this tool returned.",
    });
    expect(activity?.endedAt).toBeTypeOf("number");
  });
});
