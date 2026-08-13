import { create } from "zustand";
import { convertFileSrc } from "@tauri-apps/api/core";
import { api } from "@/api";
import type { Attachment, StagedResource } from "@/types/chat";

/**
 * Pending attachments for the next chat message. Files are staged to the
 * project inbox by Rust before they land here (so each carries a real path).
 * On send, the composer reads `items`, hands them to the chat store, then
 * `clear()`s — the files stay owned by the sent message, so clearing does NOT
 * delete them. Only an explicit `remove()` (the chip ×) deletes the staged file.
 */

function toAttachment(r: StagedResource): Attachment {
  return {
    id: r.id,
    path: r.stagedPath,
    name: r.originalName,
    kind: r.kind,
    size: r.byteSize,
    preview: r.kind === "image" ? convertFileSrc(r.stagedPath) : undefined,
  };
}

interface AttachmentsState {
  items: Attachment[];
  /** Append freshly-staged resources (dedup by path). */
  add: (staged: StagedResource[]) => void;
  /** Remove a chip and delete its staged file from disk. */
  remove: (id: string) => Promise<void>;
  /** Detach all without deleting (files pass to the sent message). */
  clear: () => void;
}

export const useAttachmentsStore = create<AttachmentsState>((set, get) => ({
  items: [],

  add: (staged) =>
    set((s) => {
      const known = new Set(s.items.map((i) => i.path));
      const next = staged
        .map(toAttachment)
        .filter((a) => !known.has(a.path));
      return next.length ? { items: [...s.items, ...next] } : {};
    }),

  remove: async (id) => {
    const target = get().items.find((i) => i.id === id);
    set((s) => ({ items: s.items.filter((i) => i.id !== id) }));
    if (target) {
      try {
        await api.removeStaged(target.path);
      } catch {
        // Best-effort: the file may already be gone; the chip is removed either
        // way. Rust refuses paths outside an inbox, so this can't over-delete.
      }
    }
  },

  clear: () => set({ items: [] }),
}));
