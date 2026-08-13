import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Settings } from "@/types/settings";

const mocks = vi.hoisted(() => ({
  updateSettings: vi.fn(),
}));

vi.mock("@/api", () => ({
  api: {
    getSettings: vi.fn(),
    updateSettings: mocks.updateSettings,
  },
}));

import { useSettingsStore } from "./useSettingsStore";

const initial: Settings = {
  schemaVersion: 3,
  recentProjects: [],
  currentProject: null,
  agentBackend: "claude",
  model: null,
  codexModel: null,
  effort: null,
  codexEffort: null,
  theme: "system",
  debugDrawer: false,
  pairedOk: false,
  onboarded: true,
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("settings update queue", () => {
  beforeEach(() => {
    mocks.updateSettings.mockReset();
    useSettingsStore.setState({ settings: initial, error: null });
  });

  it("merges each patch into the latest canonical response", async () => {
    const first = deferred<Settings>();
    const second = deferred<Settings>();
    mocks.updateSettings
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);

    const saveModel = useSettingsStore.getState().update({ model: "opus" });
    const saveEffort = useSettingsStore.getState().update({ effort: "high" });

    await vi.waitFor(() => expect(mocks.updateSettings).toHaveBeenCalledTimes(1));
    first.resolve({ ...initial, model: "opus" });
    await vi.waitFor(() => expect(mocks.updateSettings).toHaveBeenCalledTimes(2));

    expect(useSettingsStore.getState().settings).toMatchObject({
      model: "opus",
      effort: "high",
    });

    expect(mocks.updateSettings.mock.calls[1]?.[0]).toMatchObject({
      model: "opus",
      effort: "high",
    });
    second.resolve({ ...initial, model: "opus", effort: "high" });
    await Promise.all([saveModel, saveEffort]);

    expect(useSettingsStore.getState().settings).toMatchObject({
      model: "opus",
      effort: "high",
    });
  });

  it("keeps optimistic values retryable when a save fails", async () => {
    mocks.updateSettings
      .mockRejectedValueOnce(new Error("disk full"))
      .mockResolvedValueOnce({ ...initial, model: "opus" });

    await useSettingsStore.getState().update({ model: "opus" });

    expect(useSettingsStore.getState()).toMatchObject({
      settings: { model: "opus" },
      error: "Error: disk full",
    });

    await useSettingsStore.getState().update({});

    expect(mocks.updateSettings.mock.calls[1]?.[0]).toMatchObject({ model: "opus" });
    expect(useSettingsStore.getState()).toMatchObject({
      settings: { model: "opus" },
      error: null,
    });
  });
});
