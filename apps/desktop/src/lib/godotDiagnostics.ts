import type { ChatMessage } from "@/types/chat";

export type GodotVerificationVerdict = "pass" | "fail" | "unverified" | "running" | "unknown";

export interface GodotVerificationCheck {
  id: string;
  label: string;
  verdict: GodotVerificationVerdict;
  detail?: string;
}

export interface GodotVerificationProblem {
  id: string;
  message: string;
  path?: string;
}

export interface GodotVerification {
  verdict: GodotVerificationVerdict;
  checks: GodotVerificationCheck[];
  problems: GodotVerificationProblem[];
  tests: { status: "not_configured"; message: string };
  updatedAt: number;
  fixPrompt?: string;
}

export type GodotDebugVerdict =
  | "clean"
  | "issues"
  | "unverified"
  | "launch_failed";

export interface GodotDebugIssue {
  severity: "error" | "warning";
  source: string;
  kind: string;
  message: string;
  file?: string;
  line?: number;
  function?: string;
  count: number;
}

export interface GodotDebugPerformanceFinding {
  severity: "warning";
  code: string;
  message: string;
}

export interface GodotDebugEvidence {
  verdict: GodotDebugVerdict;
  summary: string;
  scenePath: string;
  observeMs: number;
  lifecycle: {
    startedByTool: boolean;
    attachedToExisting: boolean;
    stopRequested: boolean;
    stopped: boolean;
    playingAfter: boolean;
  };
  diagnostics: {
    errorCount: number;
    warningCount: number;
    infoCount: number;
    droppedEvents: number;
    droppedSamples: number;
    missedEvents: number;
    missedSamples: number;
    truncatedEvents: number;
    omittedIssueGroups: number;
    issues: GodotDebugIssue[];
  };
  performance: {
    sampleCount: number;
    fps?: { min: number; average: number; max: number };
    frameMs?: { p50: number; p95: number; max: number };
    physicsMs?: { p50: number; p95: number; max: number };
    memoryBytesMax?: number;
    nodeCountMax?: number;
    orphanNodeDelta?: number;
    drawCallsP95?: number;
    findings: GodotDebugPerformanceFinding[];
  };
  runtime: {
    connected: boolean;
    runId: string;
    rootName: string;
    rootType: string;
    nodeCount: number;
    pid: number;
  } | null;
  screenshot: {
    available: boolean;
    width?: number;
    height?: number;
    bytes?: number;
    captureError?: string;
  };
}

export type GodotDebugRun =
  | { status: "running"; updatedAt: number }
  | { status: "complete"; updatedAt: number; evidence: GodotDebugEvidence }
  | { status: "invalid"; updatedAt: number; message: string };

export type GodotTestRun =
  | { status: "running"; updatedAt: number }
  | {
      status: "complete";
      updatedAt: number;
      verdict: "pass" | "fail" | "timeout";
      runnerPath: string;
      durationMs: number;
      exitCode: number | null;
      timedOut: boolean;
    }
  | { status: "invalid"; updatedAt: number; message: string };

export const MAX_MCP_RESULT_TEXT_CHARS = 200_000;

const PRIMARY_DEBUG_RETENTION = {
  issues: 25,
  findings: 8,
  summary: 1_024,
  scenePath: 1_024,
  message: 512,
  path: 512,
  identifier: 256,
  captureError: 512,
} as const;

const FALLBACK_DEBUG_RETENTION = {
  issues: 8,
  findings: 4,
  summary: 256,
  scenePath: 256,
  message: 128,
  path: 128,
  identifier: 64,
  captureError: 128,
} as const;

export function boundMcpResultText(text: string | undefined): {
  resultRaw?: string;
  resultRawTruncated?: boolean;
} {
  if (!text) return {};
  if (text.length <= MAX_MCP_RESULT_TEXT_CHARS) return { resultRaw: text };
  const compactDebugResult = compactGodotDebugEnvelope(text);
  if (compactDebugResult) {
    return {
      resultRaw: compactDebugResult,
      resultRawTruncated: true,
    };
  }
  return {
    resultRaw: text.slice(0, MAX_MCP_RESULT_TEXT_CHARS),
    resultRawTruncated: true,
  };
}

export function isGodotVerifyActivity(name: string): boolean {
  return normalizedToolName(name) === "godot_verify";
}

export function isGodotDebugRunActivity(name: string): boolean {
  return normalizedToolName(name) === "godot_debug_run";
}

export function isGodotTestRunActivity(name: string): boolean {
  return normalizedToolName(name) === "godot_test_run";
}

export function shouldRetainGodotRawResult(name: string): boolean {
  return isGodotVerifyActivity(name)
    || isGodotDebugRunActivity(name)
    || isGodotTestRunActivity(name);
}

export function formatGodotEvidenceGaps(
  diagnostics: GodotDebugEvidence["diagnostics"],
): string {
  return [
    gapCount(diagnostics.droppedEvents, "dropped event"),
    gapCount(diagnostics.droppedSamples, "dropped sample"),
    gapCount(diagnostics.missedEvents, "missed event"),
    gapCount(diagnostics.missedSamples, "missed sample"),
    gapCount(diagnostics.truncatedEvents, "truncated event"),
  ].filter((value): value is string => value !== null).join(" · ");
}

export function collectGodotDiagnostics(
  messages: readonly ChatMessage[],
): GodotVerification | null {
  let latest:
    | { raw?: string; status: string; endedAt: number }
    | undefined;

  for (const message of messages) {
    for (const activity of message.activities) {
      if (!isGodotVerifyActivity(activity.name)) continue;
      const endedAt = activity.endedAt ?? activity.startedAt;
      if (!latest || endedAt >= latest.endedAt) {
        latest = {
          raw: activity.resultRaw?.slice(0, MAX_MCP_RESULT_TEXT_CHARS),
          status: activity.status,
          endedAt,
        };
      }
    }
  }
  if (!latest) return null;
  if (latest.status === "running") {
    return {
      verdict: "running",
      checks: [],
      problems: [],
      tests: notConfiguredTests(),
      updatedAt: latest.endedAt,
    };
  }

  const payload = latest.raw ? parseVerificationPayload(latest.raw) : null;
  if (!payload) {
    return {
      verdict: latest.status === "error" ? "fail" : "unknown",
      checks: [],
      problems: latest.status === "error"
        ? [{ id: "verify", message: "Godot verification failed without structured output." }]
        : [],
      tests: notConfiguredTests(),
      updatedAt: latest.endedAt,
    };
  }

  const importResult = object(payload.import);
  const scripts = object(payload.scripts);
  const failures = Array.isArray(scripts.failures) ? scripts.failures : [];
  const checks: GodotVerificationCheck[] = [
    {
      id: "import",
      label: "Headless import",
      verdict: importResult.ok === true ? "pass" : "fail",
      detail: string(importResult.output) || undefined,
    },
    {
      id: "scripts",
      label: "GDScript syntax",
      verdict: number(scripts.failed) === 0 ? "pass" : "fail",
      detail: `${number(scripts.checked)} checked`,
    },
    {
      id: "csharp",
      label: "C#/.NET",
      verdict: object(payload.csharp).status === "unverified" ? "unverified" : "unknown",
      detail: string(object(payload.csharp).message) || "not present",
    },
    {
      id: "tests",
      label: "Project tests",
      verdict: "unknown",
      detail: "not configured",
    },
  ];
  const problems = failures.map((value, index): GodotVerificationProblem => {
    const failure = object(value);
    return {
      id: `script:${index}`,
      path: string(failure.path) || undefined,
      message: string(failure.output) || "GDScript check failed.",
    };
  });
  if (importResult.ok !== true) {
    problems.unshift({
      id: "import",
      message: string(importResult.output) || "Godot headless import failed.",
    });
  }
  const verdict: GodotVerificationVerdict = problems.length > 0 || payload.verdict === "fail"
    ? "fail"
    : payload.verdict === "unverified" ? "unverified" : "pass";
  return {
    verdict,
    checks,
    problems,
    tests: notConfiguredTests(),
    updatedAt: latest.endedAt,
    ...(verdict === "fail"
      ? {
          fixPrompt:
            "Fix these Godot import or GDScript failures, then run `godot_verify` again until it passes. Do not claim tests ran unless an actual project test runner is configured.",
        }
      : {}),
  };
}

export function collectGodotDebugRun(
  messages: readonly ChatMessage[],
): GodotDebugRun | null {
  let latest:
    | { raw?: string; status: string; endedAt: number }
    | undefined;

  for (const message of messages) {
    for (const activity of message.activities) {
      if (!isGodotDebugRunActivity(activity.name)) continue;
      const endedAt = activity.endedAt ?? activity.startedAt;
      if (!latest || endedAt >= latest.endedAt) {
        latest = {
          raw: activity.resultRaw?.slice(0, MAX_MCP_RESULT_TEXT_CHARS),
          status: activity.status,
          endedAt,
        };
      }
    }
  }

  if (!latest) return null;
  if (latest.status === "running") {
    return { status: "running", updatedAt: latest.endedAt };
  }
  const evidence = latest.raw ? parseGodotDebugEvidence(latest.raw) : null;
  if (evidence) {
    return { status: "complete", updatedAt: latest.endedAt, evidence };
  }
  return {
    status: "invalid",
    updatedAt: latest.endedAt,
    message:
      latest.status === "error"
        ? "The debug run failed without structured evidence."
        : "The debug run returned unreadable evidence.",
  };
}

export function collectGodotTestRun(
  messages: readonly ChatMessage[],
): GodotTestRun | null {
  let latest:
    | { raw?: string; status: string; endedAt: number }
    | undefined;

  for (const message of messages) {
    for (const activity of message.activities) {
      if (!isGodotTestRunActivity(activity.name)) continue;
      const endedAt = activity.endedAt ?? activity.startedAt;
      if (!latest || endedAt >= latest.endedAt) {
        latest = {
          raw: activity.resultRaw?.slice(0, MAX_MCP_RESULT_TEXT_CHARS),
          status: activity.status,
          endedAt,
        };
      }
    }
  }

  if (!latest) return null;
  if (latest.status === "running") {
    return { status: "running", updatedAt: latest.endedAt };
  }
  const payload = latest.raw ? parseEnvelope(latest.raw) : null;
  const verdict = payload ? string(payload.verdict) : "";
  const runnerPath = payload ? string(payload.runnerPath) : "";
  const durationMs = payload ? integer(payload.durationMs, 0) : null;
  const exitCode = payload?.exitCode === null
    ? null
    : payload ? integer(payload.exitCode) : null;
  const timedOut = payload ? boolean(payload.timedOut) : null;
  if (
    !["pass", "fail", "timeout"].includes(verdict)
    || !runnerPath
    || durationMs === null
    || (payload?.exitCode !== null && exitCode === null)
    || timedOut === null
  ) {
    return {
      status: "invalid",
      updatedAt: latest.endedAt,
      message: latest.status === "error"
        ? "The project test run failed without structured evidence."
        : "The project test run returned unreadable evidence.",
    };
  }
  return {
    status: "complete",
    updatedAt: latest.endedAt,
    verdict: verdict as "pass" | "fail" | "timeout",
    runnerPath,
    durationMs,
    exitCode,
    timedOut,
  };
}

export function parseGodotDebugEvidence(raw: string): GodotDebugEvidence | null {
  const payload = parseEnvelope(raw);
  if (!payload) return null;

  const verdict = payload.verdict;
  if (
    verdict !== "clean"
    && verdict !== "issues"
    && verdict !== "unverified"
    && verdict !== "launch_failed"
  ) return null;

  const summary = strictString(payload.summary);
  const scenePath = strictString(payload.scenePath);
  const observeMs = finiteNumber(payload.observeMs, 0);
  const lifecycle = record(payload.lifecycle);
  const diagnostics = record(payload.diagnostics);
  const performance = record(payload.performance);
  const screenshot = record(payload.screenshot);
  if (
    summary === null
    || scenePath === null
    || observeMs === null
    || !lifecycle
    || !diagnostics
    || !performance
    || !screenshot
  ) return null;

  const startedByTool = boolean(lifecycle.startedByTool);
  const attachedToExisting = boolean(lifecycle.attachedToExisting);
  const stopRequested = boolean(lifecycle.stopRequested);
  const stopped = boolean(lifecycle.stopped);
  const playingAfter = boolean(lifecycle.playingAfter);
  if (
    startedByTool === null
    || attachedToExisting === null
    || stopRequested === null
    || stopped === null
    || playingAfter === null
  ) return null;

  const errorCount = integer(diagnostics.errorCount, 0);
  const warningCount = integer(diagnostics.warningCount, 0);
  const infoCount = integer(diagnostics.infoCount, 0);
  const droppedEvents = integer(diagnostics.droppedEvents, 0);
  const droppedSamples = integer(diagnostics.droppedSamples, 0);
  const missedEvents = integer(diagnostics.missedEvents, 0);
  const missedSamples = integer(diagnostics.missedSamples, 0);
  const truncatedEvents = integer(diagnostics.truncatedEvents, 0);
  const omittedIssueGroups = integer(diagnostics.omittedIssueGroups, 0);
  const issues = parseArray(diagnostics.issues, parseDebugIssue);
  if (
    errorCount === null
    || warningCount === null
    || infoCount === null
    || droppedEvents === null
    || droppedSamples === null
    || missedEvents === null
    || missedSamples === null
    || truncatedEvents === null
    || omittedIssueGroups === null
    || !issues
  ) return null;

  const sampleCount = integer(performance.sampleCount, 0);
  const fps = optionalStats(performance.fps, ["min", "average", "max"]);
  const frameMs = optionalStats(performance.frameMs, ["p50", "p95", "max"]);
  const physicsMs = optionalStats(performance.physicsMs, ["p50", "p95", "max"]);
  const memoryBytesMax = optionalNumber(performance.memoryBytesMax, 0);
  const nodeCountMax = optionalInteger(performance.nodeCountMax, 0);
  const orphanNodeDelta = optionalInteger(performance.orphanNodeDelta);
  const drawCallsP95 = optionalNumber(performance.drawCallsP95, 0);
  const findings = parseArray(
    performance.findings,
    parsePerformanceFinding,
  );
  if (
    sampleCount === null
    || fps === null
    || frameMs === null
    || physicsMs === null
    || memoryBytesMax === null
    || nodeCountMax === null
    || orphanNodeDelta === null
    || drawCallsP95 === null
    || !findings
  ) return null;

  const runtime = parseRuntime(payload.runtime);
  if (runtime === undefined) return null;

  const available = boolean(screenshot.available);
  const width = optionalInteger(screenshot.width, 0);
  const height = optionalInteger(screenshot.height, 0);
  const bytes = optionalInteger(screenshot.bytes, 0);
  const captureError = optionalString(screenshot.captureError);
  if (
    available === null
    || width === null
    || height === null
    || bytes === null
    || captureError === null
  ) return null;

  return {
    verdict,
    summary,
    scenePath,
    observeMs,
    lifecycle: {
      startedByTool,
      attachedToExisting,
      stopRequested,
      stopped,
      playingAfter,
    },
    diagnostics: {
      errorCount,
      warningCount,
      infoCount,
      droppedEvents,
      droppedSamples,
      missedEvents,
      missedSamples,
      truncatedEvents,
      omittedIssueGroups,
      issues,
    },
    performance: {
      sampleCount,
      ...optional("fps", fps),
      ...optional("frameMs", frameMs),
      ...optional("physicsMs", physicsMs),
      ...optional("memoryBytesMax", memoryBytesMax),
      ...optional("nodeCountMax", nodeCountMax),
      ...optional("orphanNodeDelta", orphanNodeDelta),
      ...optional("drawCallsP95", drawCallsP95),
      findings,
    },
    runtime,
    screenshot: {
      available,
      ...optional("width", width),
      ...optional("height", height),
      ...optional("bytes", bytes),
      ...optional("captureError", captureError),
    },
  };
}

function compactGodotDebugEnvelope(raw: string): string | null {
  const evidence = parseGodotDebugEvidence(raw);
  if (!evidence) return null;

  const primary = serializeCompactedDebugEvidence(
    evidence,
    PRIMARY_DEBUG_RETENTION,
  );
  if (primary.length <= MAX_MCP_RESULT_TEXT_CHARS) return primary;

  return serializeCompactedDebugEvidence(
    evidence,
    FALLBACK_DEBUG_RETENTION,
  );
}

function serializeCompactedDebugEvidence(
  evidence: GodotDebugEvidence,
  limits: typeof PRIMARY_DEBUG_RETENTION | typeof FALLBACK_DEBUG_RETENTION,
): string {
  const data: GodotDebugEvidence = {
    ...evidence,
    summary: truncateField(evidence.summary, limits.summary),
    scenePath: truncateField(evidence.scenePath, limits.scenePath),
    diagnostics: {
      ...evidence.diagnostics,
      omittedIssueGroups:
        evidence.diagnostics.omittedIssueGroups
        + Math.max(0, evidence.diagnostics.issues.length - limits.issues),
      issues: evidence.diagnostics.issues
        .slice(0, limits.issues)
        .map((issue) => ({
          ...issue,
          source: truncateField(issue.source, limits.identifier),
          kind: truncateField(issue.kind, limits.identifier),
          message: truncateField(issue.message, limits.message),
          ...(issue.file === undefined
            ? {}
            : { file: truncateField(issue.file, limits.path) }),
          ...(issue.function === undefined
            ? {}
            : { function: truncateField(issue.function, limits.identifier) }),
        })),
    },
    performance: {
      ...evidence.performance,
      findings: evidence.performance.findings
        .slice(0, limits.findings)
        .map((finding) => ({
          ...finding,
          code: truncateField(finding.code, limits.identifier),
          message: truncateField(finding.message, limits.message),
        })),
    },
    runtime: evidence.runtime
      ? {
          ...evidence.runtime,
          runId: truncateField(evidence.runtime.runId, limits.identifier),
          rootName: truncateField(evidence.runtime.rootName, limits.identifier),
          rootType: truncateField(evidence.runtime.rootType, limits.identifier),
        }
      : null,
    screenshot: {
      ...evidence.screenshot,
      ...(evidence.screenshot.captureError === undefined
        ? {}
        : {
            captureError: truncateField(
              evidence.screenshot.captureError,
              limits.captureError,
            ),
          }),
    },
  };
  return JSON.stringify({ ok: true, data });
}

function truncateField(value: string, limit: number): string {
  return value.length <= limit ? value : `${value.slice(0, limit - 1)}…`;
}

function gapCount(count: number, label: string): string | null {
  return count > 0 ? `${count} ${label}${count === 1 ? "" : "s"}` : null;
}

function parseVerificationPayload(raw: string): Record<string, unknown> | null {
  const payload = parseEnvelope(raw);
  if (!payload) return null;
  if (
    !["pass", "fail", "unverified"].includes(string(payload.verdict))
    || typeof object(payload.import).ok !== "boolean"
    || !Number.isInteger(object(payload.scripts).checked)
    || !Number.isInteger(object(payload.scripts).failed)
    || !Array.isArray(object(payload.scripts).failures)
  ) return null;
  return payload;
}

function parseEnvelope(raw: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    const envelope = record(parsed);
    if (!envelope) return null;
    if (envelope.ok !== true) return null;
    const candidate = envelope.data ?? envelope.result;
    return record(candidate);
  } catch {
    return null;
  }
}

function parseDebugIssue(value: unknown): GodotDebugIssue | null {
  const issue = record(value);
  if (!issue || (issue.severity !== "error" && issue.severity !== "warning")) {
    return null;
  }
  const source = strictString(issue.source);
  const kind = strictString(issue.kind);
  const message = strictString(issue.message);
  const file = optionalString(issue.file);
  const line = optionalInteger(issue.line, 0);
  const functionName = optionalString(issue.function);
  const count = integer(issue.count, 1);
  if (
    source === null
    || kind === null
    || message === null
    || file === null
    || line === null
    || functionName === null
    || count === null
  ) return null;
  return {
    severity: issue.severity,
    source,
    kind,
    message,
    ...optional("file", file),
    ...optional("line", line),
    ...optional("function", functionName),
    count,
  };
}

function parsePerformanceFinding(value: unknown): GodotDebugPerformanceFinding | null {
  const finding = record(value);
  if (!finding || finding.severity !== "warning") return null;
  const code = strictString(finding.code);
  const message = strictString(finding.message);
  if (code === null || message === null) return null;
  return { severity: "warning", code, message };
}

function parseRuntime(value: unknown): GodotDebugEvidence["runtime"] | undefined {
  if (value === null) return null;
  const runtime = record(value);
  if (!runtime) return undefined;
  const connected = boolean(runtime.connected);
  const runId = strictString(runtime.runId);
  const rootName = strictString(runtime.rootName);
  const rootType = strictString(runtime.rootType);
  const nodeCount = integer(runtime.nodeCount, 0);
  const pid = integer(runtime.pid, 0);
  if (
    connected === null
    || runId === null
    || rootName === null
    || rootType === null
    || nodeCount === null
    || pid === null
  ) return undefined;
  return { connected, runId, rootName, rootType, nodeCount, pid };
}

function optionalStats<const Keys extends readonly [string, string, string]>(
  value: unknown,
  keys: Keys,
): Record<Keys[number], number> | undefined | null {
  if (value === undefined) return undefined;
  const stats = record(value);
  if (!stats) return null;
  const result: Record<string, number> = {};
  for (const key of keys) {
    const parsed = finiteNumber(stats[key], 0);
    if (parsed === null) return null;
    result[key] = parsed;
  }
  return result as Record<Keys[number], number>;
}

function parseArray<T>(
  value: unknown,
  parser: (item: unknown) => T | null,
): T[] | null {
  if (!Array.isArray(value)) return null;
  const result: T[] = [];
  for (const item of value) {
    const parsed = parser(item);
    if (parsed === null) return null;
    result.push(parsed);
  }
  return result;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function strictString(value: unknown): string | null {
  return typeof value === "string" ? value.trim() : null;
}

function optionalString(value: unknown): string | undefined | null {
  if (value === undefined) return undefined;
  return typeof value === "string" ? value.trim() : null;
}

function boolean(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function finiteNumber(value: unknown, minimum?: number): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return minimum === undefined || value >= minimum ? value : null;
}

function integer(value: unknown, minimum?: number): number | null {
  return Number.isInteger(value)
    && (minimum === undefined || (value as number) >= minimum)
    ? (value as number)
    : null;
}

function optionalNumber(
  value: unknown,
  minimum?: number,
): number | undefined | null {
  return value === undefined ? undefined : finiteNumber(value, minimum);
}

function optionalInteger(
  value: unknown,
  minimum?: number,
): number | undefined | null {
  return value === undefined ? undefined : integer(value, minimum);
}

function optional<K extends string, V>(
  key: K,
  value: V | undefined,
): Partial<Record<K, V>> {
  return value === undefined ? {} : { [key]: value } as Record<K, V>;
}

function normalizedToolName(name: string): string {
  return name.split("__").at(-1) ?? name;
}

function notConfiguredTests() {
  return {
    status: "not_configured" as const,
    message: "No Godot test runner is configured for this project.",
  };
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : {};
}

function string(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function number(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}
