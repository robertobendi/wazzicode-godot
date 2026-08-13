import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PairingState } from "@/types/pairing";

const mocks = vi.hoisted(() => ({
  pairingStart: vi.fn(),
  pairingState: vi.fn(),
  pairingSubmitCode: vi.fn(),
  pairingCancel: vi.fn(),
}));

vi.mock("@/api", () => ({
  api: mocks,
}));

import { usePairingStore } from "./usePairingStore";

const idle: PairingState = {
  phase: "idle",
  oauthUrl: null,
  mode: null,
  error: null,
  rawTail: null,
  promptSeen: false,
  pairingId: null,
};

describe("pairing state reconciliation", () => {
  beforeEach(() => {
    for (const mock of Object.values(mocks)) mock.mockReset();
    usePairingStore.setState({
      state: idle,
      starting: false,
      submitting: false,
    });
  });

  it("refreshes after start so a fast event cannot leave the UI stuck", async () => {
    const awaitingAdmin: PairingState = {
      ...idle,
      phase: "awaiting_admin",
      oauthUrl: "https://claude.ai/oauth/authorize?code=true",
      pairingId: "pair-1",
    };
    mocks.pairingStart.mockResolvedValue("pair-1");
    mocks.pairingState.mockResolvedValue(awaitingAdmin);

    await usePairingStore.getState().start();

    expect(mocks.pairingStart).toHaveBeenCalledOnce();
    expect(mocks.pairingState).toHaveBeenCalledOnce();
    expect(usePairingStore.getState()).toMatchObject({
      state: awaitingAdmin,
      starting: false,
    });
  });

  it("does not let a prior attempt's late snapshot overwrite a newer event", async () => {
    let resolveSnapshot: (state: PairingState) => void = () => undefined;
    mocks.pairingState.mockReturnValueOnce(
      new Promise<PairingState>((resolve) => {
        resolveSnapshot = resolve;
      }),
    );
    const refresh = usePairingStore.getState().refresh();
    const awaitingAdmin: PairingState = {
      ...idle,
      phase: "awaiting_admin",
      oauthUrl: "https://claude.ai/oauth/authorize?code=true",
      pairingId: "pair-1",
    };
    usePairingStore.getState().set(awaitingAdmin);

    resolveSnapshot({
      ...idle,
      phase: "starting",
      pairingId: "old-pair",
    });
    await refresh;

    expect(usePairingStore.getState().state).toEqual(awaitingAdmin);
  });
});
