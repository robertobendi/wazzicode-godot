import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "@/api";
import { useChatStore } from "@/stores/useChatStore";
import type { SyncStatus } from "@/types/gitSync";

/** Don't hit the network more than this often, however busy the chat gets. */
const FETCH_THROTTLE_MS = 60_000;

/**
 * Tracks whether there is anything to commit/pull/push, checked after each full
 * chat task finishes (busy → idle) and when the project changes. Remote fetch
 * is throttled so a fast sequence of turns doesn't fetch after every one.
 */
export function useSyncStatus() {
  const project = useChatStore((s) => s.project);
  const running = useChatStore((s) => s.running);
  const queued = useChatStore((s) => s.queuedTasks.length);
  const [status, setStatus] = useState<SyncStatus | null>(null);
  const [checking, setChecking] = useState(false);
  const requestId = useRef(0);
  const lastFetch = useRef(0);
  const wasBusy = useRef(running || queued > 0);

  const refresh = useCallback(
    async (forceFetch = false) => {
      if (!project) {
        setStatus(null);
        return;
      }
      const fetch =
        forceFetch || Date.now() - lastFetch.current > FETCH_THROTTLE_MS;
      if (fetch) lastFetch.current = Date.now();
      const id = ++requestId.current;
      setChecking(true);
      try {
        const next = await api.syncStatus(project, fetch);
        if (id === requestId.current) setStatus(next);
      } catch {
        if (id === requestId.current) setStatus(null);
      } finally {
        if (id === requestId.current) setChecking(false);
      }
    },
    [project],
  );

  // Fresh project (or first mount): reset the throttle and check once.
  useEffect(() => {
    lastFetch.current = 0;
    const state = useChatStore.getState();
    wasBusy.current = state.running || state.queuedTasks.length > 0;
    void refresh(true);
  }, [project, refresh]);

  // A full task just finished: look again for drift it may have introduced.
  const busy = running || queued > 0;
  useEffect(() => {
    if (wasBusy.current && !busy) void refresh();
    wasBusy.current = busy;
  }, [busy, refresh]);

  return { status, checking, refresh };
}
