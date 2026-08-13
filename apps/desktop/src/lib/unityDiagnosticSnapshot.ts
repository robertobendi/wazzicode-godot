import type {
  UnityDiagnosticsIssue,
  UnityDiagnosticsSnapshot,
} from "@/types/unityDiagnostics";

export function unityDiagnosticIssues(
  snapshot: UnityDiagnosticsSnapshot | null,
  level: "all" | "errors" | "warnings" = "all",
  query = "",
): UnityDiagnosticsIssue[] {
  if (!snapshot) return [];
  const issues: UnityDiagnosticsIssue[] = [];
  for (const problem of snapshot.compile.errors ?? []) {
    issues.push({ kind: "compile", problem });
  }
  for (const entry of snapshot.console.logs) {
    if (entry.type === "Log") continue;
    issues.push({ kind: "console", entry });
  }
  const normalizedQuery = query.trim().toLowerCase();
  return issues.filter((issue) => {
    const severity = issueSeverity(issue);
    if (level === "errors" && severity !== "error") return false;
    if (level === "warnings" && severity !== "warning") return false;
    if (!normalizedQuery) return true;
    return issueText(issue).toLowerCase().includes(normalizedQuery);
  });
}

export function unityDiagnosticCounts(snapshot: UnityDiagnosticsSnapshot | null) {
  const issues = unityDiagnosticIssues(snapshot);
  return {
    total: issues.length,
    errors: issues.filter((issue) => issueSeverity(issue) === "error").length,
    warnings: issues.filter((issue) => issueSeverity(issue) === "warning").length,
  };
}

export function unityDiagnosticSummary(snapshot: UnityDiagnosticsSnapshot | null) {
  if (!snapshot) {
    return {
      compileErrors: 0,
      consoleErrors: 0,
      consoleWarnings: 0,
    };
  }
  return {
    compileErrors: snapshot.compile.errorCount,
    consoleErrors: snapshot.console.logs.filter(isConsoleError).length,
    consoleWarnings: snapshot.console.logs.filter(
      (entry) => entry.type === "Warning",
    ).length,
  };
}

export function issueSeverity(
  issue: UnityDiagnosticsIssue,
): "error" | "warning" {
  if (issue.kind === "compile") {
    return issue.problem.type === "warning" ? "warning" : "error";
  }
  return issue.entry.type === "Warning" ? "warning" : "error";
}

export function issueTitle(issue: UnityDiagnosticsIssue): string {
  if (issue.kind === "compile") return issue.problem.message;
  return issue.entry.message;
}

export function issueLocation(issue: UnityDiagnosticsIssue): string | null {
  if (issue.kind === "compile") {
    if (!issue.problem.file) return null;
    return `${issue.problem.file}${
      issue.problem.line ? `:${issue.problem.line}` : ""
    }${issue.problem.column ? `:${issue.problem.column}` : ""}`;
  }
  return firstStackFrame(issue.entry.stackTrace);
}

export function buildSnapshotFixPrompt(
  snapshot: UnityDiagnosticsSnapshot,
  issue?: UnityDiagnosticsIssue,
): string {
  const focus = issue ? ` Focus first on: ${describeIssue(issue)}.` : "";
  return (
    "Use the current Unity diagnostics as ground truth. Fix the actionable compiler and console failures, then run unity_verify until it passes." +
    focus +
    ` Current summary: ${countPhrase(snapshot.compile.errorCount, "compiler error")}, ${countPhrase(snapshot.compile.warningCount, "compiler warning")}, ${countPhrase(snapshot.console.logs.filter(isConsoleError).length, "console error")}.`
  );
}

export function describeIssue(issue: UnityDiagnosticsIssue): string {
  const location = issueLocation(issue);
  return `${issueTitle(issue)}${location ? ` (${location})` : ""}`;
}

function issueText(issue: UnityDiagnosticsIssue): string {
  if (issue.kind === "compile") {
    return `${issue.problem.file ?? ""} ${issue.problem.message}`;
  }
  return `${issue.entry.message} ${issue.entry.stackTrace ?? ""}`;
}

function firstStackFrame(stack: string | undefined): string | null {
  const line = stack
    ?.split(/\r?\n/)
    .map((item) => item.trim())
    .find(Boolean);
  return line || null;
}

function isConsoleError(entry: { type: string }): boolean {
  return entry.type === "Error" || entry.type === "Assert" || entry.type === "Exception";
}

function countPhrase(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}
