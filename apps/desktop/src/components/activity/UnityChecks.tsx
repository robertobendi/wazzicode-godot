import { useMemo, useState } from "react";
import { useUnityDiagnostics } from "@/hooks/useUnityDiagnostics";
import {
  buildSnapshotFixPrompt,
  describeIssue,
  issueLocation,
  issueSeverity,
  issueTitle,
  unityDiagnosticCounts,
  unityDiagnosticIssues,
  unityDiagnosticSummary,
} from "@/lib/unityDiagnosticSnapshot";
import {
  collectUnityDiagnostics,
  type UnityDiagnostics,
} from "@/lib/unityDiagnostics";
import { useChatStore } from "@/stores/useChatStore";
import type {
  UnityDiagnosticsIssue,
  UnityPlayModeStatus,
} from "@/types/unityDiagnostics";
import type { BridgeState } from "@/types/status";
import { ChevronIcon, RefreshIcon } from "@/components/shell/icons";

export default function UnityChecks({
  project,
  bridgeState,
  active,
}: {
  project: string | null;
  bridgeState: BridgeState;
  active: boolean;
}) {
  const connected = bridgeState === "connected";
  const { snapshot, loading, clearing, error, refresh, clearConsole } =
    useUnityDiagnostics(project, connected, active);
  const submitTask = useChatStore((state) => state.submitTask);
  const messages = useChatStore((state) => state.messages);
  const [level, setLevel] = useState<"all" | "errors" | "warnings">("all");
  const [query, setQuery] = useState("");
  const [expanded, setExpanded] = useState<string | null>(null);
  const counts = useMemo(() => unityDiagnosticCounts(snapshot), [snapshot]);
  const summary = useMemo(() => unityDiagnosticSummary(snapshot), [snapshot]);
  const agentDiagnostics = useMemo(
    () => collectUnityDiagnostics(messages),
    [messages],
  );
  const issues = useMemo(
    () => unityDiagnosticIssues(snapshot, level, query),
    [level, query, snapshot],
  );
  const visibleIssues = issues.slice(0, 200);
  const actionableCount = summary.compileErrors + summary.consoleErrors;
  const testResult = agentDiagnostics?.tests ?? null;

  function askAgent(issue?: UnityDiagnosticsIssue) {
    if (!snapshot) return;
    submitTask(buildSnapshotFixPrompt(snapshot, issue));
  }

  function askAgentFromVerification() {
    if (agentDiagnostics?.fixPrompt) submitTask(agentDiagnostics.fixPrompt);
  }

  function diagnoseConnection() {
    submitTask(
      "Run unity_diagnose_connection for this project. Explain the cause in plain language and follow its recommended next action when it is safe and does not require user input.",
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col" aria-busy={loading}>
      <div className="max-h-[60%] shrink-0 overflow-y-auto border-b border-ink-700 px-3 py-3">
        <div className="flex items-center justify-between gap-2">
          <div>
            <div className="flex items-center gap-2">
              <div className="text-xs font-semibold text-fg">Unity checks</div>
              {snapshot && (
                <span className="rounded bg-ink-800 px-1.5 py-0.5 text-[9px] font-medium text-fg-dim">
                  {playModeLabel(snapshot.playMode)}
                </span>
              )}
            </div>
            <div className="mt-0.5 text-[10px] text-fg-dim">
              Live compiler, console, and verification results
            </div>
          </div>
          <button
            type="button"
            onClick={() => void refresh()}
            disabled={!connected || loading}
            aria-label="Refresh Unity checks"
            title="Refresh Unity checks"
            className="icon-button text-fg-dim hover:text-fg disabled:opacity-40"
          >
            <RefreshIcon className={loading ? "animate-spin" : undefined} />
          </button>
        </div>

        <div className="mt-3 grid grid-cols-3 gap-2">
          <Metric
            label="Compile"
            value={snapshot?.compile.isCompiling ? "…" : snapshot?.compile.errorCount ?? "—"}
            tone={
              snapshot?.compile.isCompiling
                ? "warning"
                : snapshot?.compile.hasErrors
                  ? "danger"
                  : snapshot
                    ? "success"
                    : "muted"
            }
            detail={
              snapshot?.compile.isCompiling
                ? "compiling"
                : snapshot?.compile.hasErrors
                  ? "errors"
                  : snapshot
                    ? "clean"
                    : "not read"
            }
          />
          <Metric
            label="Console"
            value={snapshot ? summary.consoleErrors : "—"}
            tone={
              summary.consoleErrors > 0
                ? "danger"
                : summary.consoleWarnings > 0
                  ? "warning"
                  : snapshot?.console.truncated
                    ? "warning"
                  : snapshot
                    ? "success"
                    : "muted"
            }
            detail={
              summary.consoleErrors > 0
                ? "errors"
                : summary.consoleWarnings > 0
                  ? `${summary.consoleWarnings} warnings`
                  : snapshot?.console.truncated
                    ? "partial history"
                  : snapshot
                    ? "0 captured"
                    : "not read"
            }
          />
          <Metric
            label="Last tests"
            {...testMetric(testResult)}
          />
        </div>

        {agentDiagnostics && (
          <AgentVerification
            diagnostics={agentDiagnostics}
            onFix={askAgentFromVerification}
          />
        )}

        {snapshot && actionableCount > 0 && (
          <button
            type="button"
            onClick={() => askAgent()}
            className="mt-2 w-full rounded-lg bg-accent px-3 py-2 text-[11px] font-medium text-white"
          >
            Ask agent to fix {actionableCount}{" "}
            {actionableCount === 1 ? "error" : "errors"}
          </button>
        )}
      </div>

      <div className="shrink-0 border-b border-ink-700 px-3 py-2.5">
        <div className="flex gap-1" role="group" aria-label="Filter Unity issues">
          {(["all", "errors", "warnings"] as const).map((item) => (
            <button
              key={item}
              type="button"
              aria-pressed={level === item}
              onClick={() => setLevel(item)}
              className={`min-h-6 rounded-md px-2 py-1 text-[10px] font-medium capitalize ${
                level === item
                  ? "bg-accent text-fg"
                  : "text-fg-dim hover:bg-ink-800 hover:text-fg"
              }`}
            >
              {item} {item === "all" ? counts.total : counts[item]}
            </button>
          ))}
          <button
            type="button"
            onClick={() => void clearConsole()}
            disabled={!connected || clearing}
            className="ml-auto min-h-6 rounded-md px-2 py-1 text-[10px] text-fg-dim hover:bg-ink-800 hover:text-fg disabled:opacity-40"
          >
            {clearing ? "Clearing…" : "Clear console"}
          </button>
        </div>
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          aria-label="Filter Unity diagnostic messages and file paths"
          placeholder="Filter messages or file paths…"
          className="mt-2 w-full rounded-lg border border-ink-700 bg-white px-2.5 py-2 text-[11px] text-fg outline-none placeholder:text-fg-dim focus:border-accent/40"
        />
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-2 py-2">
        {error && connected && (
          <div
            role="alert"
            className="mb-2 rounded-lg border border-danger/20 bg-danger/5 p-3 text-[11px] leading-relaxed text-danger"
          >
            {error}
          </div>
        )}
        {snapshot?.console.truncated && (
          <div className="mb-2 rounded-lg border border-warning/20 bg-warning/5 px-3 py-2 text-[10px] leading-relaxed text-warning">
            This is a partial Console history. Filter the list or clear Unity's
            Console to reset it.
          </div>
        )}
        {!connected ? (
          <ChecksEmpty
            text={disconnectedChecksText(bridgeState)}
            actionLabel={
              bridgeState === "reloading" ? undefined : "Ask agent to diagnose"
            }
            onAction={bridgeState === "reloading" ? undefined : diagnoseConnection}
          />
        ) : !snapshot && loading ? (
          <ChecksEmpty text="Reading Unity diagnostics…" loading />
        ) : !snapshot ? (
          <ChecksEmpty text="Refresh to read Unity diagnostics." />
        ) : issues.length === 0 ? (
          <ChecksEmpty
            text={
              query || level !== "all"
                ? "Nothing matches this filter."
                : snapshot.console.truncated
                  ? "No problems in the captured portion of Unity's Console."
                : "No live compiler or Console problems."
            }
            success={!query && level === "all" && !snapshot.console.truncated}
          />
        ) : (
          <ul className="space-y-1.5">
            {visibleIssues.map((issue, index) => {
              const key = `${issue.kind}:${index}:${issueTitle(issue)}`;
              return (
                <IssueRow
                  key={key}
                  issue={issue}
                  open={expanded === key}
                  onToggle={() => setExpanded((current) => (current === key ? null : key))}
                  onFix={() => askAgent(issue)}
                />
              );
            })}
            {issues.length > visibleIssues.length && (
              <li className="px-3 py-2 text-center text-[10px] text-fg-dim">
                Showing the first {visibleIssues.length} of {issues.length} issues.
                Refine the filter to see a specific result.
              </li>
            )}
          </ul>
        )}
      </div>
    </div>
  );
}

function Metric({
  label,
  value,
  detail,
  tone,
}: {
  label: string;
  value: string | number;
  detail: string;
  tone: "success" | "danger" | "warning" | "muted";
}) {
  const toneClass = {
    success: "text-success",
    danger: "text-danger",
    warning: "text-warning",
    muted: "text-fg-dim",
  }[tone];
  return (
    <div className="rounded-lg border border-ink-700 bg-white px-2.5 py-2">
      <div className="text-[9px] font-medium uppercase tracking-[0.1em] text-fg-dim">
        {label}
      </div>
      <div className={`mt-1 text-lg font-semibold tabular-nums ${toneClass}`}>{value}</div>
      <div className="text-[9px] text-fg-dim">{detail}</div>
    </div>
  );
}

function IssueRow({
  issue,
  open,
  onToggle,
  onFix,
}: {
  issue: UnityDiagnosticsIssue;
  open: boolean;
  onToggle: () => void;
  onFix: () => void;
}) {
  const severity = issueSeverity(issue);
  const location = issueLocation(issue);
  const detail =
    issue.kind === "console"
      ? issue.entry.stackTrace
      : undefined;
  return (
    <li className="overflow-hidden rounded-lg border border-ink-700 bg-white">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className="flex w-full items-start gap-2.5 px-3 py-2.5 text-left hover:bg-ink-800"
      >
        <span
          aria-hidden
          className={`mt-1 h-2 w-2 shrink-0 rounded-sm ${
            severity === "error" ? "bg-danger" : "bg-warning"
          }`}
        />
        <span className="min-w-0 flex-1">
          <span className="line-clamp-2 block text-[11px] font-medium leading-relaxed text-fg">
            {issueTitle(issue)}
          </span>
          {location && (
            <span className="mt-1 block truncate font-mono text-[9px] text-fg-dim">
              {location}
            </span>
          )}
        </span>
        <span className="mt-0.5 text-[9px] uppercase tracking-[0.08em] text-fg-dim">
          {issue.kind}
        </span>
      </button>
      {open && (
        <div className="border-t border-ink-700 bg-ink-850 px-3 py-2.5">
          {detail && (
            <pre className="selectable max-h-36 overflow-auto whitespace-pre-wrap break-words font-mono text-[9px] leading-relaxed text-fg-muted">
              {detail}
            </pre>
          )}
          {!detail && (
            <p className="selectable text-[10px] leading-relaxed text-fg-muted">
              {describeIssue(issue)}
            </p>
          )}
          <div className="mt-2 flex justify-end">
            <button
              type="button"
              onClick={onFix}
              className="rounded-md border border-ink-700 bg-white px-2 py-1 text-[10px] font-medium text-fg-muted hover:border-ink-600 hover:text-fg"
            >
              Ask agent to fix
            </button>
          </div>
        </div>
      )}
    </li>
  );
}

function ChecksEmpty({
  text,
  success = false,
  loading = false,
  actionLabel,
  onAction,
}: {
  text: string;
  success?: boolean;
  loading?: boolean;
  actionLabel?: string;
  onAction?: () => void;
}) {
  return (
    <div className="flex h-full min-h-28 flex-col items-center justify-center px-4 text-center">
      <span
        aria-hidden
        className={`mb-2 h-2.5 w-2.5 rounded-full ${
          loading
            ? "animate-dot-pulse bg-accent"
            : success
              ? "bg-success"
              : "bg-ink-600"
        }`}
      />
      <p className="text-[11px] leading-relaxed text-fg-dim">{text}</p>
      {actionLabel && onAction && (
        <button
          type="button"
          onClick={onAction}
          className="mt-3 rounded-md border border-ink-700 bg-white px-2.5 py-1.5 text-[10px] font-medium text-fg hover:border-ink-600"
        >
          {actionLabel}
        </button>
      )}
    </div>
  );
}

function playModeLabel(status: UnityPlayModeStatus): string {
  if (status.isPaused) return "Paused";
  return status.isPlaying ? "Playing" : "Edit mode";
}

function testMetric(
  result: UnityDiagnostics["tests"],
): {
  value: string | number;
  detail: string;
  tone: "success" | "danger" | "warning" | "muted";
} {
  if (!result) return { value: "—", detail: "not run", tone: "muted" };
  if (result.verdict === "running") {
    return { value: "…", detail: "running", tone: "warning" };
  }
  if (result.verdict === "fail") {
    if (result.state !== "completed") {
      return {
        value: "!",
        detail: `${result.state.replaceAll("_", " ")}${testTime(result.updatedAt)}`,
        tone: "danger",
      };
    }
    const failed = result.failed ?? 0;
    const inconclusive =
      result.failures?.filter((failure) => failure.status === "Inconclusive")
        .length ?? 0;
    return {
      value: failed + inconclusive,
      detail: `${inconclusive > 0 ? "failed / inconclusive" : "failed"}${testTime(result.updatedAt)}`,
      tone: "danger",
    };
  }
  if (result.verdict === "pass") {
    if (result.total === 0) {
      return {
        value: 0,
        detail: `no tests found${testTime(result.updatedAt)}`,
        tone: "muted",
      };
    }
    return {
      value: result.failed ?? 0,
      detail: `${result.passed ?? 0} passed${testTime(result.updatedAt)}`,
      tone: "success",
    };
  }
  return {
    value: "—",
    detail: `${result.state.replaceAll("_", " ")}${testTime(result.updatedAt)}`,
    tone: "muted",
  };
}

function AgentVerification({
  diagnostics,
  onFix,
}: {
  diagnostics: UnityDiagnostics;
  onFix: () => void;
}) {
  const tone = {
    pass: "text-success",
    fail: "text-danger",
    running: "text-warning",
    unknown: "text-fg-dim",
  }[diagnostics.verdict];
  const label = {
    pass: "Passed",
    fail: "Needs attention",
    running: "Running",
    unknown: "Incomplete",
  }[diagnostics.verdict];
  const visibleProblems = diagnostics.problems.slice(0, 6);
  const visibleChecks = diagnostics.checks.slice(0, 8);

  return (
    <details className="group mt-2 overflow-hidden rounded-lg border border-ink-700 bg-white">
      <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2 text-[10px] hover:bg-ink-800">
        <span
          aria-hidden
          className={`h-2 w-2 rounded-full ${
            diagnostics.verdict === "pass"
              ? "bg-success"
              : diagnostics.verdict === "fail"
                ? "bg-danger"
                : diagnostics.verdict === "running"
                  ? "animate-dot-pulse bg-warning"
                  : "bg-ink-600"
          }`}
        />
        <span className="min-w-0 flex-1 font-medium text-fg">
          Latest agent verification
        </span>
        <span className={`font-medium ${tone}`}>{label}</span>
        <ChevronIcon className="h-3.5 w-3.5 shrink-0 text-fg-dim transition-transform group-open:rotate-180" />
      </summary>
      <div className="border-t border-ink-700 bg-ink-850 px-3 py-2.5">
        <ul className="space-y-1.5">
          {visibleChecks.map((check) => (
            <li key={check.id} className="flex items-start gap-2 text-[10px]">
              <span
                aria-hidden
                className={`mt-1 h-1.5 w-1.5 shrink-0 rounded-full ${checkTone(check.verdict)}`}
              />
              <span className="min-w-0 flex-1 text-fg-muted">
                {check.label}
                {check.detail ? ` · ${check.detail}` : ""}
              </span>
            </li>
          ))}
          {diagnostics.checks.length > visibleChecks.length && (
            <li className="text-[9px] text-fg-dim">
              {diagnostics.checks.length - visibleChecks.length} more checks
            </li>
          )}
        </ul>
        {visibleProblems.length > 0 && (
          <ul className="mt-2 space-y-1 border-t border-ink-700 pt-2">
            {visibleProblems.map((problem) => (
              <li
                key={problem.id}
                className="selectable break-words text-[9px] leading-relaxed text-fg-dim"
              >
                {problem.file ? `${problem.file}${problem.line ? `:${problem.line}` : ""}: ` : ""}
                {problem.message}
              </li>
            ))}
            {diagnostics.problems.length > visibleProblems.length && (
              <li className="text-[9px] text-fg-dim">
                {diagnostics.problems.length - visibleProblems.length} more issue(s)
              </li>
            )}
          </ul>
        )}
        {diagnostics.fixPrompt && (
          <button
            type="button"
            onClick={onFix}
            className="mt-2 w-full rounded-md border border-ink-700 bg-white px-2 py-1.5 text-[10px] font-medium text-fg hover:border-ink-600"
          >
            Ask agent to fix verification failures
          </button>
        )}
      </div>
    </details>
  );
}

function checkTone(verdict: string): string {
  if (verdict === "pass") return "bg-success";
  if (verdict === "fail") return "bg-danger";
  if (verdict === "running") return "animate-dot-pulse bg-warning";
  return "bg-ink-600";
}

function disconnectedChecksText(state: BridgeState): string {
  if (state === "reloading") {
    return "Unity is reloading scripts. Checks will resume automatically.";
  }
  if (state === "identity_mismatch") {
    return "A different Unity project is open. Open this project to read its diagnostics.";
  }
  return "Open this project in Unity to read diagnostics.";
}

function testTime(updatedAt: number | undefined): string {
  if (!updatedAt) return "";
  return ` · ${new Date(updatedAt).toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
  })}`;
}
