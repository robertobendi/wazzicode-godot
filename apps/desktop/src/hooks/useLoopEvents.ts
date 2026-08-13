import { useEffect } from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { useLoopStore } from "@/stores/useLoopStore";
import { useDebugStore, compact } from "@/stores/useDebugStore";
import { initialDraft, reduceStream } from "@/lib/streamMapper";
import type { LoopState } from "@/types/loop";

/**
 * Subscribe to the auto-loop's `loop:update` broadcasts and derive a live
 * "now doing …" label from the currently-streaming builder/QA sub-run.
 *
 * The loop reuses the same `agent:stream:<runId>` events as chat (runId
 * `loop:<loopId>:<i>:<builder|qa>`); the current runId travels in the loop
 * state, so we (re)subscribe to it whenever it changes and fold the stream
 * through the shared `reduceStream` to surface the latest running tool label.
 * Works for either backend — `reduceStream` reduces both vocabularies.
 */
export function useLoopEvents() {
  const applyUpdate = useLoopStore((s) => s.applyUpdate);
  const setNowDoing = useLoopStore((s) => s.setNowDoing);
  const currentRunId = useLoopStore((s) => s.state?.currentRunId ?? null);

  // Full-state broadcasts.
  useEffect(() => {
    const debug = useDebugStore.getState().push;
    let un: UnlistenFn | undefined;
    let cancelled = false;
    void listen<LoopState>("loop:update", (e) => {
      debug("loop", compact(e.payload));
      applyUpdate(e.payload);
    }).then((u) => {
      if (cancelled) u();
      else un = u;
    });
    return () => {
      cancelled = true;
      un?.();
    };
  }, [applyUpdate]);

  // Live activity of the current sub-run.
  useEffect(() => {
    if (!currentRunId) {
      setNowDoing(null);
      return;
    }
    let un: UnlistenFn | undefined;
    let cancelled = false;
    let draft = initialDraft();
    setNowDoing("Thinking…");

    void listen<unknown>(`agent:stream:${currentRunId}`, (e) => {
      draft = reduceStream(draft, e.payload);
      const running = [...draft.activities]
        .reverse()
        .find((a) => a.status === "running");
      setNowDoing(running?.friendlyLabel ?? "Thinking…");
    }).then((u) => {
      if (cancelled) u();
      else un = u;
    });

    return () => {
      cancelled = true;
      un?.();
    };
  }, [currentRunId, setNowDoing]);
}
