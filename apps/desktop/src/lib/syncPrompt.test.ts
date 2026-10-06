import { beforeEach, describe, expect, it, vi } from "vitest";
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

import { useChatStore } from "@/stores/useChatStore";
import { useSettingsStore } from "@/stores/useSettingsStore";
import { runTaskAndWait, syncCommitMessage, syncPromptFor } from "./syncPrompt";

const settings: Settings = {
  schemaVersion: 7,
  recentProjects: [],
  currentProject: "/game",
  agentBackend: "claude",
  model: null,
  codexModel: null,
  effort: null,
  codexEffort: null,
  opencodeModel: null,
  opencodeEffort: null,
  houseRules: { enabled: [], custom: "" },
  theme: "dark",
  debugDrawer: false,
  pyriteEnabled: true,
  pyritePath: null,
  syncPrompts: {},
  pairedOk: true,
  onboarded: true,
};

describe("syncPromptFor", () => {
  it("is per project and needs both the switch and some text", () => {
    const s: Settings = {
      ...settings,
      syncPrompts: {
        "/game": { prompt: "  update the endpoint  ", enabled: true },
        "/off": { prompt: "update the endpoint", enabled: false },
        "/blank": { prompt: "   ", enabled: true },
      },
    };
    expect(syncPromptFor(s, "/game")).toBe("update the endpoint");
    expect(syncPromptFor(s, "/off")).toBeNull();
    expect(syncPromptFor(s, "/blank")).toBeNull();
    expect(syncPromptFor(s, "/other")).toBeNull();
    expect(syncPromptFor(null, "/game")).toBeNull();
    expect(syncPromptFor(s, null)).toBeNull();
  });
});

describe("syncCommitMessage", () => {
  it("uses the first line, collapsed and capped", () => {
    expect(syncCommitMessage("Point the API at staging\nthen run tests")).toBe(
      "sync: Point the API at staging",
    );
    const long = syncCommitMessage("x ".repeat(80));
    expect(long.length).toBeLessThanOrEqual(6 + 58);
    expect(long.endsWith("…")).toBe(true);
  });
});

describe("runTaskAndWait", () => {
  let n = 0;
  beforeEach(() => {
    n += 1;
    mocks.chatSend.mockReset().mockResolvedValue(`run-${n}`);
    useSettingsStore.getState().setSettings(settings);
    useChatStore.getState().setProject(`/game-${n}`);
  });

  it("resolves true when the task finishes cleanly", async () => {
    const done = runTaskAndWait("update the endpoint");
    await vi.waitFor(() => expect(useChatStore.getState().activeRunId).toBe(`run-${n}`));
    useChatStore.getState().finish(`run-${n}`, {
      sessionId: "s",
      isError: false,
      resultText: "Done",
      costUsd: null,
      tokens: null,
      numTurns: 1,
    });
    await expect(done).resolves.toBe(true);
  });

  it("resolves false when the task fails", async () => {
    const done = runTaskAndWait("update the endpoint");
    await vi.waitFor(() => expect(useChatStore.getState().activeRunId).toBe(`run-${n}`));
    useChatStore.getState().fail(`run-${n}`, { friendly: "boom", raw: "boom" });
    await expect(done).resolves.toBe(false);
  });

  it("resolves false when the chat is reset underneath it", async () => {
    const done = runTaskAndWait("update the endpoint");
    useChatStore.getState().reset();
    await expect(done).resolves.toBe(false);
  });

  it("refuses to start while another task is running", async () => {
    useChatStore.setState({ running: true });
    await expect(runTaskAndWait("update the endpoint")).resolves.toBe(false);
    expect(mocks.chatSend).not.toHaveBeenCalled();
  });
});
