import { useCallback, useEffect, useState } from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { api } from "@/api";
import type { CodexLoginUpdate } from "@/types/codex";

const IDLE: CodexLoginUpdate = { phase: "starting", url: null, error: null };

/**
 * Owns the `codex:login` subscription for the Codex sign-in screen (the mirror
 * of usePairing / pairing:update). State is local rather than a store: unlike
 * pairing there's nothing to reconcile on reload — the CLI either finished the
 * browser flow (and `codexAuthStatus` says so) or the run is gone.
 *
 * `update` is null until a flow is actually started, so the screen can tell
 * "not started" apart from "starting".
 */
export function useCodexLogin() {
  const [update, setUpdate] = useState<CodexLoginUpdate | null>(null);
  const [starting, setStarting] = useState(false);
  const [listenerReady, setListenerReady] = useState(false);

  useEffect(() => {
    let unlisten: UnlistenFn | undefined;
    let cancelled = false;

    void listen<CodexLoginUpdate>("codex:login", (e) => {
      setStarting(false);
      setUpdate(e.payload);
    }).then((u) => {
      if (cancelled) u();
      else {
        unlisten = u;
        setListenerReady(true);
      }
    }).catch((error) => {
      if (!cancelled) {
        setUpdate({ phase: "failed", url: null, error: String(error) });
      }
    });

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  const start = useCallback(async () => {
    if (!listenerReady) {
      setUpdate({
        phase: "failed",
        url: null,
        error: "The sign-in listener is not ready. Try again.",
      });
      return;
    }
    setStarting(true);
    setUpdate(IDLE);
    try {
      await api.codexLoginStart();
    } catch (e) {
      setStarting(false);
      setUpdate({ phase: "failed", url: null, error: String(e) });
    }
  }, [listenerReady]);

  const cancel = useCallback(async () => {
    setStarting(false);
    setUpdate(null);
    try {
      await api.codexLoginCancel();
    } catch {
      // Best-effort — nothing to do if there's no login in flight.
    } finally {
      setUpdate(null);
    }
  }, []);

  return { update, starting, listenerReady, start, cancel };
}
