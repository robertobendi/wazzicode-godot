import { create } from "zustand";
import { api } from "@/api";
import type { Settings } from "@/types/settings";

// Settings are written as a complete object. Serialize partial updates so a
// slower response can never restore fields from an older snapshot.
let settingsUpdateQueue: Promise<void> = Promise.resolve();
let settingsRevision = 0;

interface SettingsState {
  settings: Settings | null;
  loading: boolean;
  error: string | null;
  /** Load settings from the Rust backend. Safe to call more than once. */
  load: () => Promise<void>;
  /** Persist a partial update and reflect the returned canonical settings. */
  update: (patch: Partial<Settings>) => Promise<void>;
  /** Adopt canonical settings returned by a backend command (no extra save). */
  setSettings: (settings: Settings) => void;
}

export const useSettingsStore = create<SettingsState>((set, get) => ({
  settings: null,
  loading: false,
  error: null,

  load: async () => {
    set({ loading: true, error: null });
    try {
      const settings = await api.getSettings();
      set({ settings, loading: false });
    } catch (e) {
      set({ error: String(e), loading: false });
    }
  },

  update: (patch) => {
    const revision = ++settingsRevision;
    set((state) => ({
      settings: state.settings ? { ...state.settings, ...patch } : null,
      error: null,
    }));
    const queued = settingsUpdateQueue.then(async () => {
      const current = get().settings;
      if (!current) return;
      const next = { ...current, ...patch };
      try {
        const saved = await api.updateSettings(next);
        if (revision === settingsRevision) {
          set({ settings: saved, error: null });
        }
      } catch (e) {
        if (revision === settingsRevision) set({ error: String(e) });
      }
    });
    settingsUpdateQueue = queued;
    return queued;
  },

  setSettings: (settings) => set({ settings }),
}));
