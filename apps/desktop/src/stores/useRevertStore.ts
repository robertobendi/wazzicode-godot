import { create } from "zustand";
import { api } from "@/api";
import { friendlyError } from "@/lib/errorMessages";
import type { Checkpoint } from "@/types/revert";

/**
 * Tracks the last studio checkpoint (a git snapshot taken before the most
 * recent chat turn) and drives the "Undo last change" action. The checkpoint
 * arrives on the `checkpoint:ready` event (see `useCheckpointEvents`); the
 * TopBar shows the button once a turn has finished, and `revert` rolls the
 * project back and clears it.
 */
interface RevertState {
  checkpoint: Checkpoint | null;
  reverting: boolean;

  setCheckpoint: (cp: Checkpoint) => void;
  clear: () => void;
  /** Roll back to the checkpoint. Returns the restored sha, or throws friendly. */
  revert: (project: string) => Promise<string>;
}

export const useRevertStore = create<RevertState>((set) => ({
  checkpoint: null,
  reverting: false,

  setCheckpoint: (cp) => set({ checkpoint: cp }),
  clear: () => set({ checkpoint: null }),

  revert: async (project) => {
    set({ reverting: true });
    try {
      const result = await api.revertLast(project);
      set({ checkpoint: null });
      return result.restoredTo;
    } catch (e) {
      throw new Error(friendlyError(String(e), "Couldn't undo the last change."));
    } finally {
      set({ reverting: false });
    }
  },
}));
