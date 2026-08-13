import { create } from "zustand";
import { api } from "@/api";
import { friendlyError } from "@/lib/errorMessages";
import { buildContinuationContext } from "@/lib/loopRecovery";
import { isLoopActive, type LoopOptions, type LoopState } from "@/types/loop";

/**
 * Auto-mode state. The Rust driver owns the loop; this store just mirrors the
 * `loop:update` broadcasts and exposes start/stop actions. `nowDoing` is the
 * live friendly label of the current builder/QA turn, fed by `useLoopEvents`
 * from the sub-run's `agent:stream` events.
 */
interface LoopStoreState {
  state: LoopState | null;
  starting: boolean;
  error: string | null;
  feedbackSending: boolean;
  feedbackError: string | null;
  /** Live "now doing …" label while a sub-run streams, else null. */
  nowDoing: string | null;

  /** Load any persisted loop state on startup / project switch. */
  hydrate: (project: string) => Promise<void>;
  start: (project: string, goal: string, options: LoopOptions) => Promise<void>;
  continueRun: (project: string, note: string) => Promise<void>;
  stop: () => Promise<void>;
  addFeedback: (comment: string) => Promise<boolean>;

  // Called by useLoopEvents — not part of the UI surface.
  applyUpdate: (s: LoopState) => void;
  setNowDoing: (label: string | null) => void;
}

export const useLoopStore = create<LoopStoreState>((set, get) => ({
  state: null,
  starting: false,
  error: null,
  feedbackSending: false,
  feedbackError: null,
  nowDoing: null,

  hydrate: async (project) => {
    try {
      const s = await api.loopState(project);
      set({ state: s });
    } catch {
      set({ state: null });
    }
  },

  start: async (project, goal, options) => {
    if (get().starting) return;
    set({ starting: true, error: null });
    try {
      await api.loopStart(project, goal, options);
      // The first `loop:update` (status "running") arrives via the event; no
      // need to set state here.
    } catch (e) {
      const raw = String(e);
      const friendly = raw.startsWith("busy")
        ? "Something is already running for this project."
        : friendlyError(raw, "Couldn't start Auto mode.", options.agent.backend);
      set({ error: friendly });
    } finally {
      set({ starting: false });
    }
  },

  continueRun: async (project, note) => {
    const previous = get().state;
    if (
      !previous ||
      isLoopActive(previous.status) ||
      previous.status === "done"
    ) {
      return;
    }
    await get().start(project, previous.goal, {
      ...previous.options,
      continuationContext: buildContinuationContext(previous, note),
    });
  },

  stop: async () => {
    try {
      await api.loopStop();
    } catch {
      // The driver still emits a terminal `loop:update`; nothing to do here.
    }
  },

  addFeedback: async (comment) => {
    if (get().feedbackSending) return false;
    set({ feedbackSending: true, feedbackError: null });
    try {
      await api.loopFeedback(comment);
      return true;
    } catch (error) {
      set({
        feedbackError: friendlyError(
          String(error),
          "Couldn't add feedback to this loop.",
        ),
      });
      return false;
    } finally {
      set({ feedbackSending: false });
    }
  },

  applyUpdate: (s) =>
    set((prev) => ({
      state: s,
      // Clear the live label once the loop is no longer active.
      nowDoing: isLoopActive(s.status) ? prev.nowDoing : null,
    })),

  setNowDoing: (label) => set({ nowDoing: label }),
}));
