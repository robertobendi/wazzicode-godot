import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "@/api";
import { screenshotErrorMessage } from "@/lib/errorMessages";
import { useChatStore } from "@/stores/useChatStore";

/** Tools whose completion means the selected Unity view likely changed on screen. */
const REFRESH_RE = /capture|play_mode|step|enter_play|exit_play|set_selection/;

/** How often to soft-refresh the capture while a run is active + connected. */
const SOFT_INTERVAL_MS = 10_000;

export interface LiveScreenshot {
  kind: ScreenshotKind;
  pngPath: string | null;
  /** Bumps on each successful capture; used to cache-bust the <img> src. */
  version: number;
  loading: boolean;
  error: string | null;
  selectKind: (kind: ScreenshotKind) => void;
  capture: (kind?: ScreenshotKind) => Promise<void>;
}

export type ScreenshotKind = "game" | "scene" | "selected";

/**
 * Owns the latest selected-view capture for the activity panel. Refreshes:
 *  - after any capture/play/step tool completes ok (agent changed the view),
 *  - on a soft 10s interval, but only while connected AND a run is active,
 *  - and on demand via the returned `capture()` (manual refresh button).
 */
export function useLiveScreenshot(
  project: string | null,
  connected: boolean,
): LiveScreenshot {
  const [kind, setKind] = useState<ScreenshotKind>("game");
  const [pngPath, setPngPath] = useState<string | null>(null);
  const [version, setVersion] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const request = useRef(0);
  const inFlight = useRef(
    new Map<string, { token: symbol; promise: Promise<void> }>(),
  );
  const running = useChatStore((s) => s.running);
  const messages = useChatStore((s) => s.messages);

  const capture = useCallback(
    (target: ScreenshotKind = kind): Promise<void> => {
      if (!project || !connected) return Promise.resolve();
      const key = `${project}\0${target}`;
      const existing = inFlight.current.get(key);
      if (existing) return existing.promise;
      const current = ++request.current;
      const token = Symbol();
      const operation = (async () => {
        setLoading(true);
        setError(null);
        try {
          const { pngPath } = await api.bridgeCapture(project, target);
          if (current !== request.current) return;
          setPngPath(pngPath);
          setVersion((v) => v + 1);
        } catch (e) {
          if (current === request.current) {
            setError(screenshotErrorMessage(String(e), target));
          }
        } finally {
          if (current === request.current) setLoading(false);
          if (inFlight.current.get(key)?.token === token) {
            inFlight.current.delete(key);
          }
        }
      })();
      inFlight.current.set(key, { token, promise: operation });
      return operation;
    },
    [connected, kind, project],
  );

  useEffect(() => {
    request.current += 1;
    inFlight.current.clear();
    setPngPath(null);
    setError(null);
    setLoading(false);
  }, [project]);

  useEffect(() => {
    if (connected) return;
    request.current += 1;
    inFlight.current.clear();
    setPngPath(null);
    setError(null);
    setLoading(false);
  }, [connected]);

  const selectKind = useCallback(
    (next: ScreenshotKind) => {
      if (next === kind) return;
      setKind(next);
      setPngPath(null);
      setError(null);
    },
    [kind],
  );

  useEffect(() => {
    if (connected) void capture(kind);
  }, [capture, connected, kind]);

  // Timestamp of the most recent view-changing tool completion.
  const triggerTs = useMemo(() => {
    let ts = 0;
    for (const m of messages) {
      for (const a of m.activities) {
        if (a.status === "ok" && a.endedAt && REFRESH_RE.test(a.name)) {
          if (a.endedAt > ts) ts = a.endedAt;
        }
      }
    }
    return ts;
  }, [messages]);

  const lastTrigger = useRef(0);
  useEffect(() => {
    if (triggerTs > lastTrigger.current) {
      lastTrigger.current = triggerTs;
      if (connected) void capture(kind);
    }
  }, [triggerTs, connected, capture, kind]);

  const wasRunning = useRef(running);
  useEffect(() => {
    const justFinished = wasRunning.current && !running;
    wasRunning.current = running;
    if (justFinished && connected) void capture(kind);
  }, [capture, connected, kind, running]);

  // Soft interval — only while it's worth spending the bridge round-trip.
  useEffect(() => {
    if (!connected || !running) return;
    const id = setInterval(() => void capture(kind), SOFT_INTERVAL_MS);
    return () => clearInterval(id);
  }, [connected, running, capture, kind]);

  return { kind, pngPath, version, loading, error, selectKind, capture };
}
