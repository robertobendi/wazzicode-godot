import { useEffect, useRef, useState } from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { api } from "@/api";
import type {
  OnboardingProgress,
  SetupResult,
  SetupStep as SetupStepResult,
} from "@/types/onboarding";
import { PrimaryButton, SecondaryButton, Spinner, StepHeading } from "./_shared";

// Friendly labels for the deterministic setup sequence (onboarding.rs order).
const KNOWN = [
  { id: "init", label: "Setting up Unity Vibe OS" },
  { id: "install_package", label: "Installing the Unity package" },
  { id: "brain", label: "Mapping your project" },
  { id: "access", label: "Finishing AI setup" },
  { id: "mcp_config", label: "Connecting your agent to Unity" },
  { id: "gitignore", label: "Tidying project settings" },
  { id: "doctor", label: "Double-checking everything" },
] as const;

type RowState = "pending" | "running" | "done" | "fail";

/**
 * Step 3 — one button that runs the whole "prepare this project" sequence,
 * showing each sub-step check off live (from `onboarding:progress`) and the
 * final per-step verdict (from the returned SetupResult).
 */
export default function SetupStep({
  project,
  projectName,
  onDone,
  onBack,
}: {
  project: string;
  projectName: string;
  onDone: () => void;
  onBack: () => void;
}) {
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<SetupResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lastSeen, setLastSeen] = useState<string | null>(null);
  const [lastLine, setLastLine] = useState<string>("");
  const seen = useRef<Set<string>>(new Set());

  // Track progress while a run is in flight.
  useEffect(() => {
    let unlisten: UnlistenFn | undefined;
    let cancelled = false;
    void listen<OnboardingProgress>("onboarding:progress", (e) => {
      seen.current.add(e.payload.step);
      setLastSeen(e.payload.step);
      setLastLine(e.payload.line);
    }).then((u) => {
      if (cancelled) u();
      else unlisten = u;
    });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  async function run() {
    setError(null);
    setResult(null);
    seen.current = new Set();
    setLastSeen(null);
    setLastLine("");
    setRunning(true);
    try {
      const r = await api.onboardingSetupProject(project);
      setResult(r);
    } catch (e) {
      setError(String(e));
    } finally {
      setRunning(false);
    }
  }

  const byId = new Map<string, SetupStepResult>(
    (result?.steps ?? []).map((s) => [s.id, s]),
  );
  const allOk = result !== null && result.steps.every((s) => s.ok);
  const brainReady = byId.get("brain")?.ok === true;

  function rowState(id: string): RowState {
    const done = byId.get(id);
    if (done) return done.ok ? "done" : "fail";
    if (!running && !result) return "pending";
    if (running && seen.current.has(id)) {
      return lastSeen === id ? "running" : "done";
    }
    return "pending";
  }

  return (
    <div>
      <StepHeading title="Prepare your project">
        We&apos;ll get <span className="text-fg">{projectName}</span> ready,
        connect it to Unity, and check that everything works.
      </StepHeading>

      <div className="mt-6 space-y-2">
        {KNOWN.map(({ id, label }) => {
          const state = rowState(id);
          const detail = byId.get(id)?.detail;
          return (
            <div
              key={id}
              className="flex items-start gap-3 rounded-lg border border-white/5 bg-ink-900/60 px-3 py-2"
            >
              <StatusDot state={state} />
              <div className="min-w-0 flex-1">
                <div
                  className={`text-sm ${
                    state === "pending" ? "text-fg-dim" : "text-fg"
                  }`}
                >
                  {label}
                </div>
                {state === "running" && lastLine && (
                  <div className="mt-0.5 truncate font-mono text-[11px] text-fg-dim">
                    {lastLine}
                  </div>
                )}
                {state === "fail" && detail && (
                  <div className="mt-0.5 text-[11px] text-danger">{detail}</div>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {error && (
        <div className="mt-4 rounded-lg border border-danger/30 bg-danger/5 p-3 text-xs text-fg-muted">
          {error}
        </div>
      )}

      <div className="mt-8 flex gap-3">
        <SecondaryButton onClick={onBack}>Back</SecondaryButton>
        <div className="flex-1">
          {result && allOk ? (
            <PrimaryButton onClick={onDone}>Continue</PrimaryButton>
          ) : result || error ? (
            <PrimaryButton onClick={() => void run()}>Try again</PrimaryButton>
          ) : (
            <PrimaryButton onClick={() => void run()} busy={running}>
              Prepare this project
            </PrimaryButton>
          )}
        </div>
      </div>

      {result && !allOk && brainReady && (
        <button
          onClick={onDone}
          className="mt-3 w-full text-center text-xs text-fg-dim transition-colors hover:text-fg-muted"
        >
          Continue anyway
        </button>
      )}
    </div>
  );
}

function StatusDot({ state }: { state: RowState }) {
  if (state === "running") {
    return (
      <span className="mt-0.5">
        <Spinner />
      </span>
    );
  }
  const map: Record<RowState, string> = {
    pending: "border border-ink-600 text-transparent",
    running: "",
    done: "bg-success/15 text-success",
    fail: "bg-danger/15 text-danger",
  };
  return (
    <span
      className={`mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full text-[10px] ${map[state]}`}
    >
      {state === "done" ? "✓" : state === "fail" ? "!" : ""}
    </span>
  );
}
