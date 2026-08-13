import { useEffect, useState } from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { usePairingStore } from "@/stores/usePairingStore";
import type { PairingState } from "@/types/pairing";

/**
 * Subscribe to backend `pairing:update` events and reconcile with the latest
 * state on mount. Mounted only while the pairing screen is up.
 */
export function usePairing() {
  const [listenerReady, setListenerReady] = useState(false);

  useEffect(() => {
    const setState = usePairingStore.getState().set;
    let unlisten: UnlistenFn | undefined;
    let cancelled = false;

    void listen<PairingState>("pairing:update", (e) => setState(e.payload))
      .then((u) => {
        if (cancelled) u();
        else {
          unlisten = u;
          void usePairingStore
            .getState()
            .refresh()
            .finally(() => {
              if (!cancelled) setListenerReady(true);
            });
        }
      })
      .catch((error) => {
        if (cancelled) return;
        setState({
          phase: "failed",
          oauthUrl: null,
          mode: null,
          error: `The connection listener could not start: ${String(error)}`,
          rawTail: null,
          promptSeen: false,
          pairingId: null,
        });
      });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  return listenerReady;
}
