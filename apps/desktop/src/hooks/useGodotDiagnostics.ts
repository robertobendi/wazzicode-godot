import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "@/api";
import { friendlyError } from "@/lib/errorMessages";
import type { GodotDiagnosticsSnapshot } from "@/types/godotDiagnostics";

const CONNECTED_REFRESH_MS = 5_000;

export function useGodotDiagnostics(
  project: string | null,
  connected: boolean,
  active: boolean,
) {
  const [snapshot, setSnapshot] = useState<GodotDiagnosticsSnapshot | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const request = useRef(0);
  const inFlight = useRef<Promise<void> | null>(null);

  const refresh = useCallback((): Promise<void> => {
    if (!project || !connected) return Promise.resolve();
    if (inFlight.current) return inFlight.current;
    const current = ++request.current;
    const operation = (async () => {
      setLoading(true);
      setError(null);
      try {
        const next = await api.godotDiagnostics(project);
        if (current === request.current) setSnapshot(next);
      } catch (nextError) {
        if (current === request.current) {
          setSnapshot(null);
          setError(
            friendlyError(String(nextError), "Couldn't read the Godot editor state."),
          );
        }
      } finally {
        if (current === request.current) setLoading(false);
        inFlight.current = null;
      }
    })();
    inFlight.current = operation;
    return operation;
  }, [connected, project]);

  useEffect(() => {
    request.current += 1;
    setSnapshot(null);
    setError(null);
    setLoading(false);
    inFlight.current = null;
  }, [connected, project]);

  useEffect(() => {
    if (!active || !connected) return;
    void refresh();
    const interval = setInterval(() => void refresh(), CONNECTED_REFRESH_MS);
    return () => clearInterval(interval);
  }, [active, connected, refresh]);

  return { snapshot, loading, error, refresh };
}
