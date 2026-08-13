import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "@/api";
import { friendlyError } from "@/lib/errorMessages";
import type { UnityDiagnosticsSnapshot } from "@/types/unityDiagnostics";

const CONNECTED_REFRESH_MS = 5_000;

export function useUnityDiagnostics(
  project: string | null,
  connected: boolean,
  active: boolean,
) {
  const [snapshot, setSnapshot] = useState<UnityDiagnosticsSnapshot | null>(null);
  const [loading, setLoading] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const request = useRef(0);
  const clearRequest = useRef(0);
  const inFlight = useRef<{
    project: string;
    id: number;
    promise: Promise<void>;
  } | null>(null);

  const refresh = useCallback((): Promise<void> => {
    if (!project || !connected) return Promise.resolve();
    if (inFlight.current?.project === project) return inFlight.current.promise;
    const current = ++request.current;
    const operation = (async () => {
      setLoading(true);
      setError(null);
      try {
        const next = await api.unityDiagnostics(project);
        if (current === request.current) setSnapshot(next);
      } catch (nextError) {
        if (current === request.current) {
          setSnapshot(null);
          setError(friendlyError(String(nextError), "Couldn't read Unity diagnostics."));
        }
      } finally {
        if (current === request.current) setLoading(false);
        if (inFlight.current?.id === current) inFlight.current = null;
      }
    })();
    inFlight.current = { project, id: current, promise: operation };
    return operation;
  }, [connected, project]);

  const clearConsole = useCallback(async () => {
    if (!project || !connected || clearing) return;
    const current = ++clearRequest.current;
    setClearing(true);
    setError(null);
    try {
      await api.unityClearConsole(project);
      if (current !== clearRequest.current) return;
      if (inFlight.current?.project === project) {
        await inFlight.current.promise;
      }
      if (current !== clearRequest.current) return;
      await refresh();
    } catch (nextError) {
      if (current === clearRequest.current) {
        setError(
          friendlyError(String(nextError), "Couldn't clear the Unity console."),
        );
      }
    } finally {
      if (current === clearRequest.current) setClearing(false);
    }
  }, [clearing, connected, project, refresh]);

  useEffect(() => {
    request.current += 1;
    clearRequest.current += 1;
    setSnapshot(null);
    setError(null);
    setLoading(false);
    setClearing(false);
    inFlight.current = null;
  }, [project]);

  useEffect(() => {
    if (connected) return;
    request.current += 1;
    clearRequest.current += 1;
    setSnapshot(null);
    setError(null);
    setLoading(false);
    setClearing(false);
    inFlight.current = null;
  }, [connected]);

  useEffect(() => {
    if (!active || !connected) return;
    void refresh();
    const interval = setInterval(() => void refresh(), CONNECTED_REFRESH_MS);
    return () => clearInterval(interval);
  }, [active, connected, refresh]);

  return {
    snapshot,
    loading,
    clearing,
    error,
    refresh,
    clearConsole,
  };
}
