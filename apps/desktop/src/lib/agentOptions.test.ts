import { describe, expect, it } from "vitest";
import {
  compatibleResumeSessionId,
  inferSessionRunOptions,
  normalizeAgentRunOptions,
  resolveChatRunOptions,
  runOptionsFromSettings,
} from "./agentOptions";
import type { Settings } from "@/types/settings";

const settings: Settings = {
  schemaVersion: 3,
  recentProjects: [],
  currentProject: null,
  agentBackend: "codex",
  model: "sonnet",
  codexModel: "gpt-5.6-sol",
  effort: "high",
  codexEffort: "xhigh",
  theme: "system",
  debugDrawer: false,
  pairedOk: true,
  onboarded: true,
};

describe("agent run options", () => {
  it("normalizes persisted strings and invalid backends", () => {
    expect(
      normalizeAgentRunOptions(
        { backend: "unknown", model: "  ", effort: " high " },
        "codex",
      ),
    ).toEqual({ backend: "codex", model: null, effort: "high" });
  });

  it("keeps model and effort defaults separate by backend", () => {
    expect(runOptionsFromSettings(settings)).toEqual({
      backend: "codex",
      model: "gpt-5.6-sol",
      effort: "xhigh",
    });
    expect(runOptionsFromSettings(settings, "claude")).toEqual({
      backend: "claude",
      model: "sonnet",
      effort: "high",
    });
  });

  it("loads legacy sessions as Claude unless token data proves Codex", () => {
    expect(inferSessionRunOptions({ messages: [] })).toEqual({
      backend: "claude",
      model: null,
      effort: null,
    });
    expect(
      inferSessionRunOptions({ messages: [{ tokens: 0 }] }).backend,
    ).toBe("codex");
  });

  it("prefers the exact saved snapshot over redundant legacy fields", () => {
    expect(
      inferSessionRunOptions({
        agentBackend: "claude",
        runOptions: {
          backend: "codex",
          model: "gpt-5.6-sol",
          effort: "max",
        },
      }),
    ).toEqual({
      backend: "codex",
      model: "gpt-5.6-sol",
      effort: "max",
    });
  });

  it("freezes an existing conversation ahead of task and global defaults", () => {
    expect(
      resolveChatRunOptions({
        sessionRunOptions: {
          backend: "claude",
          model: "opus",
          effort: "max",
        },
        sessionBackend: "claude",
        requested: {
          backend: "codex",
          model: "gpt-5.6-sol",
          effort: "low",
        },
        settings,
      }),
    ).toEqual({ backend: "claude", model: "opus", effort: "max" });
  });

  it("never resumes an id on a different backend", () => {
    expect(
      compatibleResumeSessionId("session-1", "claude", {
        backend: "codex",
        model: null,
        effort: null,
      }),
    ).toBeNull();
    expect(
      compatibleResumeSessionId("session-1", "codex", {
        backend: "codex",
        model: null,
        effort: null,
      }),
    ).toBe("session-1");
  });
});
