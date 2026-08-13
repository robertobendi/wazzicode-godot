import { useCallback, useEffect, useRef, useState } from "react";
import { MODEL_PROBE } from "@/lib/dictation/config";
import {
  MicUnavailableError,
  startRecording,
  type Recording,
} from "@/lib/dictation/recorder";
import type {
  WorkerRequest,
  WorkerResponse,
} from "@/lib/dictation/whisper.worker";

export type DictationState =
  | "unsupported" // assets not vendored — dictation is simply not offered
  | "idle"
  | "recording"
  | "transcribing"
  | "error";

interface Dictation {
  state: DictationState;
  error: string | null;
  /** Begin capturing. No-op unless idle. */
  start: () => void;
  /** Stop and transcribe; the text is delivered to `onText`. */
  stop: () => void;
  /** Throw the take away. */
  cancel: () => void;
}

/**
 * Push-to-talk dictation for the composer, backed by a local Whisper model
 * (see `lib/dictation/config.ts` — offline, no API credits).
 *
 * `onText` receives the transcript; the composer appends it to whatever the user
 * has already typed, so dictation composes with typing instead of replacing it.
 *
 * Availability is probed rather than assumed: a dev build that hasn't run
 * `bundle:whisper` has no model on disk, and in that case we report `unsupported`
 * so the composer can hide the mic entirely rather than offer a button that
 * always fails.
 */
export function useDictation(onText: (text: string) => void): Dictation {
  const [state, setState] = useState<DictationState>("idle");
  const [error, setError] = useState<string | null>(null);

  const workerRef = useRef<Worker | null>(null);
  const recordingRef = useRef<Recording | null>(null);
  const reqRef = useRef(0);
  // Keep the callback in a ref so the worker's message handler — installed once —
  // always calls the latest composer, not the one captured at mount.
  const onTextRef = useRef(onText);
  onTextRef.current = onText;

  // Are the vendored assets actually there?
  useEffect(() => {
    let alive = true;
    void fetch(MODEL_PROBE, { method: "HEAD" })
      .then((r) => {
        if (alive && !r.ok) setState("unsupported");
      })
      .catch(() => {
        if (alive) setState("unsupported");
      });
    return () => {
      alive = false;
    };
  }, []);

  // Spin the worker up lazily, and tear it down with the composer.
  const worker = useCallback((): Worker => {
    if (!workerRef.current) {
      const w = new Worker(
        new URL("../lib/dictation/whisper.worker.ts", import.meta.url),
        { type: "module" },
      );
      w.onmessage = (e: MessageEvent<WorkerResponse>) => {
        const msg = e.data;
        if (msg.type === "result") {
          if (msg.text) onTextRef.current(msg.text);
          setState("idle");
        } else if (msg.type === "error") {
          setError(friendly(msg.message));
          setState("error");
        }
      };
      w.onerror = () => {
        setError("Dictation failed to start.");
        setState("error");
      };
      workerRef.current = w;
    }
    return workerRef.current;
  }, []);

  useEffect(() => {
    return () => {
      recordingRef.current?.cancel();
      workerRef.current?.terminate();
      workerRef.current = null;
    };
  }, []);

  const start = useCallback(() => {
    if (state !== "idle" && state !== "error") return;
    setError(null);
    // Load the model while the user is still talking, so `stop` doesn't wait on it.
    worker().postMessage({ type: "warmup", id: -1 } satisfies WorkerRequest);

    setState("recording");
    void startRecording()
      .then((rec) => {
        recordingRef.current = rec;
      })
      .catch((e: unknown) => {
        setError(
          e instanceof MicUnavailableError
            ? "No microphone, or access was denied. Check your OS privacy settings."
            : "Couldn't start the microphone.",
        );
        setState("error");
      });
  }, [state, worker]);

  const stop = useCallback(() => {
    const rec = recordingRef.current;
    if (!rec) {
      // Stopped before the mic finished opening — just go back to idle.
      setState("idle");
      return;
    }
    recordingRef.current = null;
    setState("transcribing");

    void rec.stop().then((pcm) => {
      if (pcm.length === 0) {
        setState("idle");
        return;
      }
      const id = ++reqRef.current;
      // Hand the samples over rather than copy them (they can be megabytes).
      worker().postMessage({ type: "transcribe", id, pcm } satisfies WorkerRequest, [
        pcm.buffer,
      ]);
    });
  }, [worker]);

  const cancel = useCallback(() => {
    recordingRef.current?.cancel();
    recordingRef.current = null;
    setState("idle");
    setError(null);
  }, []);

  return { state, error, start, stop, cancel };
}

/** Turn a worker/ORT exception into something a game designer can act on. */
function friendly(message: string): string {
  const m = message.toLowerCase();
  if (m.includes("404") || m.includes("not found") || m.includes("failed to fetch")) {
    return "The dictation model is missing from this build.";
  }
  return "Couldn't transcribe that. Try again.";
}
