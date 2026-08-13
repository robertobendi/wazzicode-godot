import { create } from "zustand";

/** A brief, auto-dismissing confirmation banner. */
export interface Toast {
  id: string;
  message: string;
}

interface ToastState {
  toasts: Toast[];
  /** Show a toast; it auto-dismisses after a few seconds. */
  show: (message: string) => void;
  dismiss: (id: string) => void;
}

const DISMISS_MS = 3500;

export const useToastStore = create<ToastState>((set, get) => ({
  toasts: [],

  show: (message) => {
    const id =
      globalThis.crypto?.randomUUID?.() ??
      `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    set((s) => ({ toasts: [...s.toasts, { id, message }] }));
    setTimeout(() => get().dismiss(id), DISMISS_MS);
  },

  dismiss: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
}));
