import { useCallback, useEffect, useRef, useState } from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { create } from "zustand";
import { api } from "@/api";
import type { AgentBackend } from "@/types/settings";
import type { CliStatus } from "@/types/onboarding";
import type { OnboardingProgress } from "@/types/onboarding";

const useCliInstallStore = create<{ backend: AgentBackend | null }>(() => ({
  backend: null,
}));

export function useCliInstallActive(): boolean {
  return useCliInstallStore((state) => state.backend !== null);
}

/**
 * Subscribe to backend `onboarding:progress` events and accumulate the lines.
 * Optionally filter to a single `step`. Returns the running log plus a reset.
 */
export function useOnboardingProgress(step?: string) {
  const [lines, setLines] = useState<string[]>([]);
  // Latest `step` without re-subscribing on every render.
  const stepRef = useRef(step);
  stepRef.current = step;

  useEffect(() => {
    let unlisten: UnlistenFn | undefined;
    let cancelled = false;

    void listen<OnboardingProgress>("onboarding:progress", (e) => {
      const want = stepRef.current;
      if (want && e.payload.step !== want) return;
      setLines((prev) => {
        const next = [...prev, e.payload.line];
        // Keep the tail bounded — installers can be chatty.
        return next.length > 200 ? next.slice(-200) : next;
      });
    }).then((u) => {
      if (cancelled) u();
      else unlisten = u;
    });

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  return { lines, reset: () => setLines([]) };
}

/** A backend-aware CLI probe/installer that ignores stale async responses. */
export function useCliSetup(
  backend: AgentBackend,
  initial: CliStatus | null = null,
) {
  const [status, setStatus] = useState<CliStatus | null>(initial);
  const [checking, setChecking] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const request = useRef(0);
  const activeInstallBackend = useCliInstallStore((state) => state.backend);
  const previousInstallBackend = useRef(activeInstallBackend);
  const completedOwnInstall = useRef(false);
  const installing = activeInstallBackend !== null;

  const check = useCallback(async () => {
    const id = ++request.current;
    setChecking(true);
    setError(null);
    try {
      const next = await api.onboardingCheckCli(backend);
      if (id !== request.current) return null;
      setStatus(next);
      setError(next.error);
      return next;
    } catch (e) {
      if (id !== request.current) return null;
      setStatus(null);
      setError(String(e));
      return null;
    } finally {
      if (id === request.current) setChecking(false);
    }
  }, [backend]);

  const install = useCallback(async () => {
    if (useCliInstallStore.getState().backend) {
      setError("Another CLI install is already running. Wait for it to finish.");
      return null;
    }
    const id = ++request.current;
    useCliInstallStore.setState({ backend });
    setError(null);
    try {
      const next = await api.onboardingInstallCli(backend);
      if (id !== request.current) return null;
      setStatus(next);
      setError(next.error);
      return next;
    } catch (e) {
      if (id !== request.current) return null;
      setError(String(e));
      return null;
    } finally {
      if (useCliInstallStore.getState().backend === backend) {
        completedOwnInstall.current = true;
        useCliInstallStore.setState({ backend: null });
      }
    }
  }, [backend]);

  useEffect(() => {
    const previous = previousInstallBackend.current;
    previousInstallBackend.current = activeInstallBackend;
    if (previous && !activeInstallBackend) {
      if (completedOwnInstall.current) completedOwnInstall.current = false;
      else void check();
    }
  }, [activeInstallBackend, check]);

  useEffect(() => {
    request.current += 1;
    setStatus(initial);
    setError(null);
    void check();
    return () => {
      request.current += 1;
    };
  }, [backend, check]);

  return { status, checking, installing, error, check, install };
}
