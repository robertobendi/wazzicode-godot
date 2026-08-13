import { useEffect } from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { useRevertStore } from "@/stores/useRevertStore";
import type { Checkpoint } from "@/types/revert";

/**
 * Subscribe to `checkpoint:ready` — emitted by `chat_send` right after it takes
 * a studio checkpoint (before the AI turn runs) — and stash it so the TopBar can
 * offer "Undo last change" once the turn finishes. Mounted once at the app root.
 */
export function useCheckpointEvents() {
  const setCheckpoint = useRevertStore((s) => s.setCheckpoint);

  useEffect(() => {
    let un: UnlistenFn | undefined;
    let cancelled = false;
    void listen<Checkpoint>("checkpoint:ready", (e) => {
      setCheckpoint(e.payload);
    }).then((u) => {
      if (cancelled) u();
      else un = u;
    });
    return () => {
      cancelled = true;
      un?.();
    };
  }, [setCheckpoint]);
}
