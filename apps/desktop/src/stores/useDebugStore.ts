import { create } from "zustand";
import { summarizeEvent, type EventLevel } from "@/lib/eventSummary";

/** One line in the admin debug log. */
export interface DebugEntry {
  id: number;
  /** Wall-clock time captured. */
  t: number;
  /** Source channel: "stream" | "done" | "error" | "raw". */
  kind: string;
  /** Human-readable one-liner (e.g. `unity_verify`), backend-agnostic. */
  label: string;
  /** Extra context for the summary line — args, output, error text. */
  detail?: string;
  /** Drives the row colour; `error` rows are what you're usually hunting for. */
  level: EventLevel;
  /** The full event, pretty-printed. Shown when the row is expanded. */
  raw: string;
}

/** Cap so a chatty run can't grow the buffer without bound. */
const MAX_ENTRIES = 2000;

interface DebugState {
  entries: DebugEntry[];
  push: (kind: string, payload: unknown) => void;
  clear: () => void;
}

let seq = 0;

export const useDebugStore = create<DebugState>((set) => ({
  entries: [],
  push: (kind, payload) =>
    set((s) => {
      const { label, detail, level } = summarizeEvent(payload);
      const entry: DebugEntry = {
        id: seq++,
        t: Date.now(),
        kind,
        label,
        detail,
        // A terminal `error` event is an error regardless of its shape.
        level: kind === "error" ? "error" : level,
        raw: pretty(payload),
      };
      const next =
        s.entries.length >= MAX_ENTRIES ? s.entries.slice(1) : s.entries;
      return { entries: [...next, entry] };
    }),
  clear: () => set({ entries: [] }),
}));

/** Full event, indented — the drawer shows this under an expanded row. */
function pretty(payload: unknown): string {
  if (typeof payload === "string") return payload;
  try {
    return JSON.stringify(payload, null, 2);
  } catch {
    return String(payload);
  }
}

/** Compactly stringify an arbitrary event payload (single-line, for copy-out). */
export function compact(payload: unknown): string {
  try {
    return typeof payload === "string" ? payload : JSON.stringify(payload);
  } catch {
    return String(payload);
  }
}
