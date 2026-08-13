import { create } from "zustand";

/** Which top-level surface is showing: manual chat or the autonomous loop. */
export type AppMode = "chat" | "auto";

/** Ephemeral shell UI state (panel/drawer/popover visibility). Not persisted. */
interface UiState {
  /** Active surface: "chat" (manual) or "auto" (loop). */
  mode: AppMode;
  /** Right-hand activity panel open? */
  activityOpen: boolean;
  /** Left session-history rail open? Persisted across launches. */
  sessionRailOpen: boolean;
  /** Bottom debug drawer expanded? (Only reachable when settings.debugDrawer.) */
  debugOpen: boolean;
  /** Settings popover open? */
  settingsOpen: boolean;
  /** Project knowledge map drawer open? */
  projectMapOpen: boolean;
  /** Admin "Re-pair account" chosen — force the pairing screen back up. */
  repairing: boolean;
  toggleActivity: () => void;
  toggleSessionRail: () => void;
  toggleDebug: () => void;
  setSettingsOpen: (open: boolean) => void;
  setProjectMapOpen: (open: boolean) => void;
  setRepairing: (v: boolean) => void;
  setMode: (mode: AppMode) => void;
}

// The session rail's open/closed state is the one bit of shell UI we persist,
// so a user who prefers it collapsed keeps that between launches.
const RAIL_KEY = "uvibe.sessionRailOpen";

function loadRailOpen(): boolean {
  try {
    return localStorage.getItem(RAIL_KEY) !== "false";
  } catch {
    return true;
  }
}

function saveRailOpen(open: boolean): void {
  try {
    localStorage.setItem(RAIL_KEY, String(open));
  } catch {
    // Private mode / storage disabled — non-fatal, just don't persist.
  }
}

export const useUiStore = create<UiState>((set) => ({
  mode: "chat",
  activityOpen: false,
  sessionRailOpen: loadRailOpen(),
  debugOpen: false,
  settingsOpen: false,
  projectMapOpen: false,
  repairing: false,
  toggleActivity: () => set((s) => ({ activityOpen: !s.activityOpen })),
  toggleSessionRail: () =>
    set((s) => {
      const next = !s.sessionRailOpen;
      saveRailOpen(next);
      return { sessionRailOpen: next };
    }),
  toggleDebug: () => set((s) => ({ debugOpen: !s.debugOpen })),
  setSettingsOpen: (open) => set({ settingsOpen: open }),
  setProjectMapOpen: (open) => set({ projectMapOpen: open }),
  setRepairing: (v) => set({ repairing: v }),
  setMode: (mode) => set({ mode }),
}));
