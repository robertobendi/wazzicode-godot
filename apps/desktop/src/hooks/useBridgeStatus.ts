import { useEffect } from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { api } from "@/api";
import { useStatusStore } from "@/stores/useStatusStore";
import type { StatusUpdate } from "@/types/status";

/**
 * Drive the Unity bridge status pill for `project`: subscribe to `status:update`
 * and run the backend poll loop for this project's lifetime.
 */
export function useBridgeStatus(project: string | null) {
  useEffect(() => {
    if (!project) return;
    const setStatus = useStatusStore.getState().set;
    let unlisten: UnlistenFn | undefined;
    let cancelled = false;

    void listen<StatusUpdate>("status:update", (e) => setStatus(e.payload)).then(
      (u) => {
        if (cancelled) u();
        else unlisten = u;
      },
    );
    void api.statusStart(project);

    return () => {
      cancelled = true;
      unlisten?.();
      void api.statusStop();
    };
  }, [project]);
}
