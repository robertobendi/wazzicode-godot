import { create } from "zustand";
import type { StatusUpdate } from "@/types/status";

interface StatusState {
  status: StatusUpdate;
  set: (status: StatusUpdate) => void;
}

const INITIAL: StatusUpdate = {
  state: "disconnected",
  compiling: false,
  playMode: false,
  friendly: "Connecting…",
};

export const useStatusStore = create<StatusState>((set) => ({
  status: INITIAL,
  set: (status) => set({ status }),
}));
