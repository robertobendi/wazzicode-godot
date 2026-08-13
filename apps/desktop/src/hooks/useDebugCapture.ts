import { useEffect } from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { useDebugStore } from "@/stores/useDebugStore";

/**
 * Capture the static `debug:raw` channel (non-JSON stdout lines the Rust reader
 * couldn't parse). Per-run `agent:*` events are captured in `useAgentStream`,
 * which is mounted for the project's lifetime; this covers the run-agnostic
 * stream so nothing is missed while the drawer is closed. Mount once, in App.
 */
export function useDebugCapture() {
  useEffect(() => {
    const push = useDebugStore.getState().push;
    let unlisten: UnlistenFn | undefined;
    let cancelled = false;

    void listen<unknown>("debug:raw", (e) => push("raw", e.payload)).then((u) => {
      if (cancelled) u();
      else unlisten = u;
    });

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);
}
