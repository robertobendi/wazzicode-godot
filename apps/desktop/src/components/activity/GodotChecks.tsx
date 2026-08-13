import { useMemo } from "react";
import { useGodotDiagnostics } from "@/hooks/useGodotDiagnostics";
import { collectGodotDiagnostics } from "@/lib/godotDiagnostics";
import {
  buildSceneQuestion,
  importState,
  sceneState,
} from "@/lib/godotDiagnosticSnapshot";
import { useChatStore } from "@/stores/useChatStore";
import type { BridgeState } from "@/types/status";
import { ChevronIcon, RefreshIcon } from "@/components/shell/icons";

export default function GodotChecks({
  project,
  bridgeState,
  active,
}: {
  project: string | null;
  bridgeState: BridgeState;
  active: boolean;
}) {
  const connected = bridgeState === "connected";
  const { snapshot, loading, error, refresh } = useGodotDiagnostics(
    project,
    connected,
    active,
  );
  const submitTask = useChatStore((state) => state.submitTask);
  const messages = useChatStore((state) => state.messages);
  const verification = useMemo(
    () => collectGodotDiagnostics(messages),
    [messages],
  );
  const scenes = sceneState(snapshot);
  const imports = importState(snapshot);

  function diagnoseConnection() {
    submitTask(
      "Run godot_diagnose_connection for this project. Explain the exact cause and follow its safe recommended action when no user input is required.",
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col" aria-busy={loading}>
      <div className="shrink-0 border-b border-ink-700 px-3 py-3">
        <div className="flex items-center justify-between gap-2">
          <div>
            <div className="flex items-center gap-2">
              <div className="text-xs font-semibold text-fg">Godot checks</div>
              {snapshot && (
                <span className="rounded bg-godot/10 px-1.5 py-0.5 text-[9px] font-medium text-godot">
                  {snapshot.play.playing ? "Running" : "Editing"}
                </span>
              )}
            </div>
            <div className="mt-0.5 text-[10px] text-fg-dim">
              Live import, scene, run, and verification state
            </div>
          </div>
          <button
            type="button"
            onClick={() => void refresh()}
            disabled={!connected || loading}
            aria-label="Refresh Godot checks"
            className="icon-button text-fg-dim hover:text-fg disabled:opacity-40"
          >
            <RefreshIcon className={loading ? "animate-spin" : undefined} />
          </button>
        </div>

        <div className="mt-3 grid grid-cols-3 gap-2">
          <Metric
            label="Imports"
            value={imports.busy ? "…" : snapshot ? "Ready" : "—"}
            detail={imports.label}
            tone={imports.busy ? "warning" : snapshot ? "success" : "muted"}
          />
          <Metric
            label="Scenes"
            value={snapshot ? scenes.open : "—"}
            detail={scenes.unsaved ? `${scenes.unsaved} unsaved` : "all saved"}
            tone={scenes.unsaved ? "warning" : snapshot ? "success" : "muted"}
          />
          <Metric
            label="Tests"
            value="—"
            detail="not configured"
            tone="muted"
          />
        </div>

        {verification && (
          <VerificationCard
            verification={verification}
            onFix={() => verification.fixPrompt && submitTask(verification.fixPrompt)}
          />
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
        {error && connected && (
          <div role="alert" className="mb-3 rounded-lg border border-danger/20 bg-danger/5 p-3 text-[11px] text-danger">
            {error}
          </div>
        )}
        {!connected ? (
          <Empty
            text={disconnectedText(bridgeState)}
            action={bridgeState === "reloading" ? undefined : "Ask agent to diagnose"}
            onAction={bridgeState === "reloading" ? undefined : diagnoseConnection}
          />
        ) : !snapshot && loading ? (
          <Empty text="Reading Godot editor state…" loading />
        ) : !snapshot ? (
          <Empty text="Refresh to inspect the editor." />
        ) : (
          <>
            <div className="mb-2 flex items-center justify-between">
              <span className="text-[10px] font-medium uppercase tracking-[0.12em] text-fg-dim">
                Open scenes
              </span>
              <span className="text-[10px] text-fg-dim">
                {snapshot.filesystem.indexedFiles} resources indexed
              </span>
            </div>
            {snapshot.scenes.scenes.length === 0 ? (
              <Empty text="No scene is open in the editor." />
            ) : (
              <ul className="space-y-1.5">
                {snapshot.scenes.scenes.map((scene) => (
                  <li key={scene.path} className="rounded-lg border border-ink-700 bg-white px-3 py-2.5">
                    <div className="flex items-start gap-2">
                      <span className={`mt-1 h-2 w-2 shrink-0 rounded-full ${scene.isActive ? "bg-godot" : "bg-ink-600"}`} />
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2 text-[11px] font-medium text-fg">
                          <span className="truncate">{scene.name}</span>
                          {scene.isUnsaved && <span className="text-[9px] text-warning">UNSAVED</span>}
                        </div>
                        <div className="mt-1 truncate font-mono text-[9px] text-fg-dim">{scene.path}</div>
                      </div>
                      <button
                        type="button"
                        onClick={() => submitTask(buildSceneQuestion(scene))}
                        className="rounded-md border border-ink-700 px-2 py-1 text-[9px] text-fg-dim hover:text-fg"
                      >
                        Inspect
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            )}
            <div className="mt-3 rounded-lg border border-ink-700 bg-ink-850 px-3 py-2 text-[10px] leading-relaxed text-fg-dim">
              Tests are reported as not configured until this project supplies a real runner. Verification still checks headless import and every GDScript file.
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function Metric({ label, value, detail, tone }: {
  label: string;
  value: string | number;
  detail: string;
  tone: "success" | "warning" | "danger" | "muted";
}) {
  const color = { success: "text-success", warning: "text-warning", danger: "text-danger", muted: "text-fg-dim" }[tone];
  return (
    <div className="rounded-lg border border-ink-700 bg-white px-2.5 py-2">
      <div className="text-[9px] font-medium uppercase tracking-[0.1em] text-fg-dim">{label}</div>
      <div className={`mt-1 text-base font-semibold tabular-nums ${color}`}>{value}</div>
      <div className="truncate text-[9px] text-fg-dim">{detail}</div>
    </div>
  );
}

function VerificationCard({ verification, onFix }: {
  verification: NonNullable<ReturnType<typeof collectGodotDiagnostics>>;
  onFix: () => void;
}) {
  const label = { pass: "Passed", fail: "Needs attention", unverified: "Partly unverified", running: "Running", unknown: "Incomplete" }[verification.verdict];
  return (
    <details className="group mt-2 overflow-hidden rounded-lg border border-ink-700 bg-white">
      <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2 text-[10px] hover:bg-ink-800">
        <span className={`h-2 w-2 rounded-full ${verification.verdict === "pass" ? "bg-success" : verification.verdict === "fail" ? "bg-danger" : "bg-ink-600"}`} />
        <span className="min-w-0 flex-1 font-medium text-fg">Latest godot_verify</span>
        <span className="text-fg-dim">{label}</span>
        <ChevronIcon className="h-3.5 w-3.5 text-fg-dim transition-transform group-open:rotate-180" />
      </summary>
      <div className="border-t border-ink-700 bg-ink-850 px-3 py-2.5">
        <ul className="space-y-1.5">
          {verification.checks.map((check) => (
            <li key={check.id} className="flex items-start gap-2 text-[10px] text-fg-muted">
              <span className={`mt-1 h-1.5 w-1.5 rounded-full ${check.verdict === "pass" ? "bg-success" : check.verdict === "fail" ? "bg-danger" : "bg-ink-600"}`} />
              <span>{check.label}{check.detail ? ` · ${check.detail}` : ""}</span>
            </li>
          ))}
          {verification.problems.slice(0, 5).map((problem) => (
            <li key={problem.id} className="break-words font-mono text-[9px] text-danger">
              {problem.path ? `${problem.path}: ` : ""}{problem.message}
            </li>
          ))}
        </ul>
        {verification.fixPrompt && (
          <button type="button" onClick={onFix} className="mt-2 w-full rounded-md border border-ink-700 bg-white px-2 py-1.5 text-[10px] font-medium text-fg">
            Ask agent to fix verification
          </button>
        )}
      </div>
    </details>
  );
}

function Empty({ text, loading = false, action, onAction }: {
  text: string;
  loading?: boolean;
  action?: string;
  onAction?: () => void;
}) {
  return (
    <div className="flex min-h-28 flex-col items-center justify-center px-4 text-center">
      <span className={`mb-2 h-2.5 w-2.5 rounded-full ${loading ? "animate-dot-pulse bg-godot" : "bg-ink-600"}`} />
      <p className="text-[11px] leading-relaxed text-fg-dim">{text}</p>
      {action && onAction && <button type="button" onClick={onAction} className="mt-3 rounded-md border border-ink-700 bg-white px-2.5 py-1.5 text-[10px] text-fg">{action}</button>}
    </div>
  );
}

function disconnectedText(state: BridgeState): string {
  if (state === "reloading") return "The Godot addon is restarting. Checks will resume automatically.";
  if (state === "identity_mismatch") return "A different Godot project is open. Open this project to inspect it.";
  return "Open this project in Godot to inspect live scenes and resources.";
}
