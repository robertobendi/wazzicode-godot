import { useMemo } from "react";
import { useGodotDiagnostics } from "@/hooks/useGodotDiagnostics";
import {
  collectGodotDebugRun,
  collectGodotDiagnostics,
  collectGodotTestRun,
  formatGodotEvidenceGaps,
  type GodotDebugRun,
} from "@/lib/godotDiagnostics";
import {
  buildSceneQuestion,
  importState,
  sceneState,
} from "@/lib/godotDiagnosticSnapshot";
import { useChatStore } from "@/stores/useChatStore";
import type { BridgeState } from "@/types/status";
import { ChevronIcon, RefreshIcon } from "@/components/shell/icons";

export const GODOT_DEBUG_RUN_PROMPT =
  "Run `godot_debug_run` exactly once. Safely observe the current scene, or the project main scene when no scene is currently playing. Report the returned runtime diagnostics, performance findings, lifecycle, and screenshot evidence. Do not modify files, scenes, settings, or auto-fix anything unless I explicitly ask in a later task.";

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
  const agentBusy = useChatStore((state) => state.running);
  const verification = useMemo(
    () => collectGodotDiagnostics(messages),
    [messages],
  );
  const debugRun = useMemo(() => collectGodotDebugRun(messages), [messages]);
  const testRun = useMemo(() => collectGodotTestRun(messages), [messages]);
  const tests = testMetric(testRun);
  const scenes = sceneState(snapshot);
  const imports = importState(snapshot);

  function diagnoseConnection() {
    submitTask(
      "Run godot_diagnose_connection for this project. Explain the exact cause and follow its safe recommended action when no user input is required.",
    );
  }

  function runDebugObservation() {
    submitTask(GODOT_DEBUG_RUN_PROMPT);
  }

  return (
    <div className="flex h-full min-h-0 flex-col" aria-busy={loading}>
      <div className="shrink-0 border-b border-ink-700 px-3 py-3">
        <div className="flex items-center justify-between gap-2">
          <div>
            <div className="flex items-center gap-2">
              <div className="text-xs font-semibold text-fg">Godot checks</div>
              {snapshot && (
                <span className="rounded bg-ink-800 px-1.5 py-0.5 text-[9px] font-medium text-fg-dim">
                  {snapshot.play.playing ? "Running" : "Editing"}
                </span>
              )}
            </div>
            <div className="mt-0.5 text-[10px] text-fg-dim">
              Live import, scene, run, and verification state
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            <button
              type="button"
              onClick={runDebugObservation}
              disabled={!connected || agentBusy}
              title={agentBusy ? "The agent is already working" : "Observe runtime evidence without changing the project"}
              className="inline-flex h-7 items-center gap-1.5 rounded-md border border-action/25 bg-action/10 px-2 text-[9px] font-semibold uppercase tracking-[0.08em] text-action hover:border-action/45 hover:bg-action/15 disabled:cursor-not-allowed disabled:opacity-40"
            >
              <span className="relative flex h-2 w-2 items-center justify-center" aria-hidden="true">
                <span className="absolute h-2 w-2 rounded-full border border-current opacity-45" />
                <span className="h-1 w-1 rounded-full bg-current" />
              </span>
              Debug run
            </button>
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
            value={tests.value}
            detail={tests.detail}
            tone={tests.tone}
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
            {debugRun && <DebugEvidenceCard run={debugRun} />}
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
                      <span className={`mt-1 h-2 w-2 shrink-0 rounded-full ${scene.isActive ? "bg-action" : "bg-ink-600"}`} />
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
              {testStatusText(testRun)}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function DebugEvidenceCard({ run }: { run: GodotDebugRun }) {
  if (run.status === "running") {
    return (
      <div className="mb-3 rounded-lg border border-action/25 bg-action/5 px-3 py-2.5">
        <div className="flex items-center gap-2 text-[10px] font-semibold text-fg">
          <span className="h-2 w-2 animate-dot-pulse rounded-full bg-action" />
          Observing runtime evidence
        </div>
        <p className="mt-1 text-[10px] leading-relaxed text-fg-dim">
          The agent is watching a bounded play session for errors and frame health.
        </p>
      </div>
    );
  }

  if (run.status === "invalid") {
    return (
      <div className="mb-3 rounded-lg border border-warning/25 bg-warning/5 px-3 py-2.5">
        <div className="text-[10px] font-semibold text-warning">Debug evidence unavailable</div>
        <p className="mt-1 text-[10px] leading-relaxed text-fg-dim">{run.message}</p>
      </div>
    );
  }

  const { evidence } = run;
  const tone = debugTone(evidence.verdict, evidence.diagnostics.errorCount);
  const fps = evidence.performance.fps?.average;
  const omittedGroups = evidence.diagnostics.omittedIssueGroups;
  const evidenceGaps = formatGodotEvidenceGaps(evidence.diagnostics);
  const findings = [
    ...evidence.diagnostics.issues.map((issue) => ({
      key: `${issue.source}:${issue.kind}:${issue.file ?? ""}:${issue.line ?? ""}`,
      tone: issue.severity === "error" ? "text-danger" : "text-warning",
      label: issue.message,
      detail: issue.file
        ? `${issue.file}${issue.line === undefined ? "" : `:${issue.line}`}`
        : `${issue.source} · ${issue.kind}`,
    })),
    ...evidence.performance.findings.map((finding) => ({
      key: `performance:${finding.code}`,
      tone: "text-warning",
      label: finding.message,
      detail: `performance · ${finding.code}`,
    })),
  ];

  return (
    <article className={`mb-3 overflow-hidden rounded-lg border border-ink-700 border-l-2 bg-white ${tone.border}`}>
      <div className="px-3 py-2.5">
        <div className="flex items-center gap-2">
          <span className={`h-2 w-2 shrink-0 rounded-full ${tone.dot}`} />
          <span className="min-w-0 flex-1 text-[10px] font-semibold text-fg">
            Latest debug evidence
          </span>
          <span className={`text-[9px] font-semibold uppercase tracking-[0.08em] ${tone.text}`}>
            {tone.label}
          </span>
        </div>
        <p className="mt-2 text-[10px] leading-relaxed text-fg-muted">{evidence.summary}</p>
        <div className="mt-1.5 flex items-center gap-2 font-mono text-[9px] text-fg-dim">
          <span className="min-w-0 flex-1 truncate">{evidence.scenePath || "Scene unresolved"}</span>
          <span className="shrink-0">{formatDuration(evidence.observeMs)}</span>
        </div>
        {evidence.verdict === "unverified" && evidenceGaps && (
          <p className="mt-1.5 text-[8px] leading-relaxed text-warning">
            Evidence gaps · {evidenceGaps}
          </p>
        )}
        <div className="mt-2.5 grid grid-cols-3 divide-x divide-ink-700 rounded-md border border-ink-700 bg-ink-850">
          <EvidenceMetric label="Errors" value={evidence.diagnostics.errorCount} tone={evidence.diagnostics.errorCount > 0 ? "danger" : "muted"} />
          <EvidenceMetric label="Warnings" value={evidence.diagnostics.warningCount} tone={evidence.diagnostics.warningCount > 0 ? "warning" : "muted"} />
          <EvidenceMetric label="Avg FPS" value={fps === undefined ? "—" : formatNumber(fps)} tone="muted" />
        </div>
      </div>
      <details className="group border-t border-ink-700 bg-ink-850">
        <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2 text-[9px] font-medium uppercase tracking-[0.08em] text-fg-dim hover:text-fg">
          <span className="min-w-0 flex-1">
            {findingsLabel(findings.length, omittedGroups)}
          </span>
          <ChevronIcon className="h-3.5 w-3.5 transition-transform group-open:rotate-180" />
        </summary>
        <div className="border-t border-ink-700 px-3 py-2.5">
          {findings.length > 0 ? (
            <ul className="space-y-2">
              {findings.slice(0, 5).map((finding) => (
                <li key={finding.key} className="text-[10px] leading-relaxed">
                  <div className={finding.tone}>{finding.label}</div>
                  <div className="mt-0.5 break-all font-mono text-[8px] text-fg-dim">{finding.detail}</div>
                </li>
              ))}
            </ul>
          ) : (
            omittedGroups === 0 && (
              <p className="text-[10px] text-fg-dim">No runtime or performance findings were recorded.</p>
            )
          )}
          {findings.length > 5 && (
            <p className="mt-2 text-[9px] leading-relaxed text-fg-dim">
              +{findings.length - 5} retained findings are not shown in this preview.
            </p>
          )}
          {omittedGroups > 0 && (
            <p className="mt-2 text-[9px] leading-relaxed text-warning">
              +{omittedGroups} diagnostic group{omittedGroups === 1 ? " was" : "s were"} omitted from the bounded packet. Totals above still include them.
            </p>
          )}
          {evidence.verdict !== "unverified" && evidenceGaps && (
            <p className="mt-1 text-[9px] leading-relaxed text-warning">
              Evidence gaps · {evidenceGaps}
            </p>
          )}
          <div className="mt-2.5 grid gap-1 border-t border-ink-700 pt-2 font-mono text-[8px] leading-relaxed text-fg-dim">
            <span>{runtimeLabel(evidence)}</span>
            <span>{lifecycleLabel(evidence)} · {screenshotLabel(evidence)}</span>
          </div>
        </div>
      </details>
    </article>
  );
}

function findingsLabel(retained: number, omittedGroups: number): string {
  if (retained === 0 && omittedGroups === 0) return "Observation details";
  const retainedLabel = retained > 0
    ? `${retained} finding${retained === 1 ? "" : "s"}`
    : "No retained findings";
  return omittedGroups > 0
    ? `${retainedLabel} · +${omittedGroups} more group${omittedGroups === 1 ? "" : "s"}`
    : retainedLabel;
}

function EvidenceMetric({ label, value, tone }: {
  label: string;
  value: string | number;
  tone: "danger" | "warning" | "muted";
}) {
  const color = {
    danger: "text-danger",
    warning: "text-warning",
    muted: "text-fg",
  }[tone];
  return (
    <div className="px-2 py-1.5 text-center">
      <div className={`text-[11px] font-semibold tabular-nums ${color}`}>{value}</div>
      <div className="text-[8px] uppercase tracking-[0.08em] text-fg-dim">{label}</div>
    </div>
  );
}

function debugTone(verdict: "clean" | "issues" | "unverified" | "launch_failed", errors: number) {
  if (verdict === "clean") {
    return { label: "Clean", dot: "bg-success", text: "text-success", border: "border-l-success/60" };
  }
  if (verdict === "issues" && errors === 0) {
    return { label: "Warnings", dot: "bg-warning", text: "text-warning", border: "border-l-warning/60" };
  }
  if (verdict === "issues") {
    return { label: "Issues", dot: "bg-danger", text: "text-danger", border: "border-l-danger/60" };
  }
  if (verdict === "launch_failed") {
    return { label: "Launch failed", dot: "bg-danger", text: "text-danger", border: "border-l-danger/60" };
  }
  return { label: "Unverified", dot: "bg-ink-600", text: "text-fg-dim", border: "border-l-ink-600" };
}

function formatDuration(milliseconds: number): string {
  return milliseconds < 1000
    ? `${Math.round(milliseconds)} ms`
    : `${(milliseconds / 1000).toFixed(milliseconds % 1000 === 0 ? 0 : 1)} s`;
}

function testMetric(testRun: ReturnType<typeof collectGodotTestRun>): {
  value: string;
  detail: string;
  tone: "success" | "warning" | "muted";
} {
  if (!testRun) return { value: "—", detail: "not run", tone: "muted" };
  if (testRun.status === "running") {
    return { value: "…", detail: "running", tone: "warning" };
  }
  if (testRun.status === "invalid") {
    return { value: "!", detail: "unreadable", tone: "warning" };
  }
  if (testRun.verdict === "pass") {
    return { value: "Pass", detail: formatDuration(testRun.durationMs), tone: "success" };
  }
  return {
    value: testRun.verdict === "timeout" ? "Time" : "Fail",
    detail: formatDuration(testRun.durationMs),
    tone: "warning",
  };
}

function testStatusText(testRun: ReturnType<typeof collectGodotTestRun>): string {
  if (!testRun) {
    return "No project test run has been observed. Verification still checks headless import and every GDScript file.";
  }
  if (testRun.status === "running") return "The project-owned Godot test runner is active.";
  if (testRun.status === "invalid") return testRun.message;
  return testRun.verdict === "pass"
    ? `${testRun.runnerPath} passed independently in ${formatDuration(testRun.durationMs)}.`
    : `${testRun.runnerPath} ${testRun.verdict === "timeout" ? "timed out" : "failed"} after ${formatDuration(testRun.durationMs)}.`;
}

function formatNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

function runtimeLabel(evidence: Extract<GodotDebugRun, { status: "complete" }>["evidence"]): string {
  return evidence.runtime?.connected
    ? `${evidence.runtime.rootName} · ${evidence.runtime.rootType} · ${evidence.runtime.nodeCount} nodes · PID ${evidence.runtime.pid}`
    : "Runtime probe unavailable";
}

function lifecycleLabel(evidence: Extract<GodotDebugRun, { status: "complete" }>["evidence"]): string {
  const { lifecycle } = evidence;
  if (lifecycle.attachedToExisting) {
    return lifecycle.playingAfter ? "Attached; run left active" : "Attached; run ended";
  }
  if (lifecycle.startedByTool) {
    return lifecycle.stopped ? "Started and stopped safely" : lifecycle.playingAfter ? "Started; run left active" : "Started; run ended";
  }
  return lifecycle.playingAfter ? "Existing run active" : "No active run";
}

function screenshotLabel(evidence: Extract<GodotDebugRun, { status: "complete" }>["evidence"]): string {
  if (!evidence.screenshot.available) return "No screenshot";
  const size = evidence.screenshot.width && evidence.screenshot.height
    ? ` ${evidence.screenshot.width}×${evidence.screenshot.height}`
    : "";
  return `Screenshot${size}`;
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
      <span className={`mb-2 h-2.5 w-2.5 rounded-full ${loading ? "animate-dot-pulse bg-action" : "bg-ink-600"}`} />
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
