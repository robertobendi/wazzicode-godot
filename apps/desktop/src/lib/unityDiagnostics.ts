import type { ChatMessage, ToolActivity } from "@/types/chat";

export const MAX_MCP_RESULT_TEXT_CHARS = 64 * 1024;

export interface BoundedMcpResultText {
  resultRaw?: string;
  resultRawTruncated?: boolean;
}

/** Keep MCP payloads useful for structured parsing without letting chat history grow unbounded. */
export function boundMcpResultText(text: string | undefined): BoundedMcpResultText {
  if (text === undefined) return {};
  if (text.length <= MAX_MCP_RESULT_TEXT_CHARS) return { resultRaw: text };
  return {
    resultRaw: text.slice(0, MAX_MCP_RESULT_TEXT_CHARS),
    resultRawTruncated: true,
  };
}

export const UNITY_DIAGNOSTIC_TOOLS = [
  "unity_verify",
  "unity_qa",
  "unity_run_tests",
  "unity_get_console_logs",
  "unity_wait_for_compile",
  "unity_smoke_test",
] as const;

export type UnityDiagnosticTool = (typeof UNITY_DIAGNOSTIC_TOOLS)[number];
export type UnityDiagnosticVerdict = "pass" | "fail" | "running" | "unknown";
export type UnityDiagnosticCheckVerdict = UnityDiagnosticVerdict | "skipped";

export interface UnityDiagnosticCheck {
  id: string;
  source: UnityDiagnosticTool;
  label: string;
  verdict: UnityDiagnosticCheckVerdict;
  detail?: string;
}

export type UnityDiagnosticProblemKind =
  | "compile"
  | "console"
  | "test"
  | "qa"
  | "tool";

export interface UnityDiagnosticProblem {
  id: string;
  source: UnityDiagnosticTool;
  kind: UnityDiagnosticProblemKind;
  severity: "error" | "warning";
  message: string;
  file?: string;
  line?: number;
  column?: number;
  stackTrace?: string;
}

export interface UnityDiagnosticTestFailure {
  name: string;
  status: "Failed" | "Inconclusive";
  message?: string;
  stackTrace?: string;
}

export type UnityDiagnosticTestState =
  | "running"
  | "completed"
  | "cancelled"
  | "not_found"
  | "skipped"
  | "unavailable"
  | "unknown";

export interface UnityDiagnosticTests {
  source: UnityDiagnosticTool;
  state: UnityDiagnosticTestState;
  verdict: UnityDiagnosticCheckVerdict;
  updatedAt: number;
  mode?: "EditMode" | "PlayMode";
  total?: number;
  passed?: number;
  failed?: number;
  skipped?: number;
  durationSec?: number;
  failures: UnityDiagnosticTestFailure[];
}

export interface UnityDiagnostics {
  verdict: UnityDiagnosticVerdict;
  checks: UnityDiagnosticCheck[];
  problems: UnityDiagnosticProblem[];
  tests: UnityDiagnosticTests | null;
  fixPrompt: string | null;
  sourceTools: UnityDiagnosticTool[];
  updatedAt: number;
}

type Raw = Record<string, unknown>;
type ProblemDraft = Omit<UnityDiagnosticProblem, "id">;

interface ParsedEnvelope {
  ok: boolean;
  data?: unknown;
  warnings: string[];
  error?: { code?: string; message?: string };
}

interface Candidate {
  tool: UnityDiagnosticTool;
  activity: ToolActivity;
  timestamp: number;
  order: number;
}

interface Contribution {
  verdict: UnityDiagnosticVerdict;
  checks: UnityDiagnosticCheck[];
  problems: ProblemDraft[];
  tests: UnityDiagnosticTests | null;
}

interface ParsedTests {
  summary: UnityDiagnosticTests;
  verdict: UnityDiagnosticCheckVerdict;
  problems: ProblemDraft[];
}

const TOOL_LABELS: Record<UnityDiagnosticTool, string> = {
  unity_verify: "Unity verification",
  unity_qa: "Full Unity QA",
  unity_run_tests: "Unity tests",
  unity_get_console_logs: "Unity console",
  unity_wait_for_compile: "Compilation",
  unity_smoke_test: "Play-mode smoke test",
};

const MAX_CHECKS = 48;
const MAX_PROBLEMS = 64;
const MAX_TEST_FAILURES = 32;

/** Parse the newest still-relevant diagnostic invocations across chat history. */
export function collectUnityDiagnostics(
  messages: readonly ChatMessage[],
): UnityDiagnostics | null {
  const history: Candidate[] = [];
  let order = 0;

  messages.forEach((message) => {
    message.activities.forEach((activity) => {
      const tool = diagnosticToolName(activity.name);
      if (!tool) return;
      const timestamp = activityTimestamp(activity, message.createdAt);
      history.push({ tool, activity, timestamp, order: order++ });
    });
  });

  if (history.length === 0) return null;

  const candidates = history
    .filter(
      (candidate) =>
        !history.some(
          (later) =>
            compareCandidates(later, candidate) > 0 &&
            candidateCoversCandidate(later, candidate),
        ),
    )
    .sort(compareCandidates);
  const contributions = candidates.map((candidate) => {
    const contribution = parseCandidate(candidate);
    if (!contribution.tests) return contribution;
    return {
      ...contribution,
      tests: { ...contribution.tests, updatedAt: candidate.timestamp },
    };
  });
  const checks = dedupeChecks(contributions.flatMap((entry) => entry.checks)).slice(
    0,
    MAX_CHECKS,
  );
  const problems = dedupeProblems(
    contributions.flatMap((entry) => entry.problems),
  )
    .slice(0, MAX_PROBLEMS)
    .map((problem, index) => ({
      ...problem,
      id: `${problem.source}:${problem.kind}:${index}`,
    }));
  const newest = contributions.at(-1);
  const verdict = combineVerdicts(
    contributions.map((entry) => entry.verdict),
    newest?.verdict,
  );
  let tests: UnityDiagnosticTests | null = null;
  for (const contribution of contributions) {
    if (
      contribution.tests &&
      (!tests ||
        isActualTestRun(contribution.tests) ||
        !isActualTestRun(tests))
    ) {
      tests = contribution.tests;
    }
  }

  const base: Omit<UnityDiagnostics, "fixPrompt"> = {
    verdict,
    checks,
    problems,
    tests,
    sourceTools: [...new Set(candidates.map((candidate) => candidate.tool))],
    updatedAt: Math.max(...candidates.map((candidate) => candidate.timestamp)),
  };
  return { ...base, fixPrompt: buildUnityFixPrompt(base) };
}

/** Build the prompt used by the UI's "fix" action from already-sanitized diagnostics. */
export function buildUnityFixPrompt(
  diagnostics: Pick<UnityDiagnostics, "verdict" | "problems" | "sourceTools">,
): string | null {
  if (diagnostics.verdict !== "fail") return null;
  const actionable = diagnostics.problems.filter(
    (problem) => problem.severity === "error",
  );
  const selected = (actionable.length > 0 ? actionable : diagnostics.problems).slice(
    0,
    12,
  );
  if (selected.length === 0) {
    const tools = diagnostics.sourceTools.map((tool) => `\`${tool}\``).join(", ");
    return `Investigate why ${tools || "the Unity diagnostic gate"} failed, fix the cause, then run \`unity_verify\` until it passes.`;
  }

  const lines = selected.map((problem) => {
    const location = formatLocation(problem);
    return `- ${location ? `${location}: ` : ""}${oneLine(problem.message)}`;
  });
  if (diagnostics.problems.length > selected.length) {
    lines.push(`- Review ${diagnostics.problems.length - selected.length} additional diagnostic item(s).`);
  }
  return [
    "Fix these Unity diagnostics, then run `unity_verify` and keep fixing until it passes:",
    ...lines,
  ].join("\n");
}

export function isUnityDiagnosticActivity(name: string): boolean {
  return diagnosticToolName(name) !== undefined;
}

function parseCandidate(candidate: Candidate): Contribution {
  const { activity, tool } = candidate;
  if (activity.status === "running") {
    return {
      verdict: "running",
      checks: [check(tool, "activity", TOOL_LABELS[tool], "running")],
      problems: [],
      tests: null,
    };
  }

  const text = activity.resultRaw ?? activity.resultText;
  const envelope = activity.resultRawTruncated ? null : parseEnvelope(text);
  if (activity.status === "error") {
    return failedToolContribution(
      tool,
      envelopeErrorText(envelope) ?? activity.resultText,
    );
  }
  if (!envelope) {
    const legacy = activity.resultRawTruncated
      ? "unknown"
      : legacyVerdict(activity.resultText);
    return {
      verdict: legacy,
      checks: [
        check(
          tool,
          "activity",
          TOOL_LABELS[tool],
          legacy,
          activity.resultRawTruncated
            ? "The stored result was truncated."
            : legacy === "unknown"
              ? activity.resultText
              : undefined,
        ),
      ],
      problems: [],
      tests: null,
    };
  }
  if (!envelope.ok) {
    return failedToolContribution(tool, envelopeErrorText(envelope));
  }

  const contribution = parseToolData(tool, envelope.data);
  if (envelope.warnings.length === 0) return contribution;
  return {
    ...contribution,
    problems: [
      ...contribution.problems,
      ...envelope.warnings.map((message): ProblemDraft => ({
        source: tool,
        kind: "tool",
        severity: "warning",
        message: cleanText(message),
      })),
    ],
  };
}

function parseToolData(tool: UnityDiagnosticTool, data: unknown): Contribution {
  if (!isRecord(data)) {
    return unknownContribution(tool, "The tool returned an unrecognized data shape.");
  }
  switch (tool) {
    case "unity_verify":
      return parseVerify(tool, data);
    case "unity_qa":
      return parseQa(data);
    case "unity_run_tests":
      return parseRunTests(data);
    case "unity_get_console_logs":
      return parseConsole(data);
    case "unity_wait_for_compile":
      return parseCompile(data);
    case "unity_smoke_test":
      return parseSmokeTest(tool, data);
  }
}

function parseVerify(source: UnityDiagnosticTool, data: Raw): Contribution {
  const checks: UnityDiagnosticCheck[] = [];
  const problems = consoleProblems(source, data.problems);
  const explicitPass = boolean(data.pass);
  checks.push(
    check(
      source,
      "verdict",
      source === "unity_qa" ? "QA verification" : TOOL_LABELS.unity_verify,
      explicitPass === undefined ? "unknown" : explicitPass ? "pass" : "fail",
    ),
  );

  const compiled = boolean(data.compiled);
  if (compiled !== undefined) {
    checks.push(
      check(
        source,
        "compile",
        "Compilation",
        compiled ? "pass" : "fail",
        countDetail(finiteNumber(data.errorCount), "error"),
      ),
    );
  }
  const refreshVerified = boolean(data.refreshVerified);
  if (refreshVerified !== undefined) {
    checks.push(
      check(
        source,
        "asset-refresh",
        "Asset refresh",
        refreshVerified ? "pass" : "fail",
      ),
    );
  }
  const consoleReadable = boolean(data.consoleReadable);
  if (consoleReadable !== undefined) {
    checks.push(
      check(
        source,
        "console-readable",
        "Console inspection",
        consoleReadable ? "pass" : "fail",
      ),
    );
  }
  const consoleErrorCount = finiteNumber(data.consoleErrorCount);
  if (consoleErrorCount !== undefined) {
    checks.push(
      check(
        source,
        "console",
        "Console errors",
        consoleErrorCount === 0 ? "pass" : "fail",
        countDetail(consoleErrorCount, "error"),
      ),
    );
  }

  const parsedTests = parseTests(data.tests, source);
  if (parsedTests) {
    checks.push(
      check(
        source,
        "tests",
        "Unity tests",
        parsedTests.verdict,
        testDetail(parsedTests.summary),
      ),
    );
    problems.push(...parsedTests.problems);
  }
  const errorCount = finiteNumber(data.errorCount);
  if (errorCount !== undefined && errorCount > 0 && problems.length === 0) {
    problems.push({
      source,
      kind: "compile",
      severity: "error",
      message: `Compilation reported ${errorCount} error(s).`,
    });
  }

  return {
    verdict: verdictFromChecks(explicitPass, checks, problems),
    checks,
    problems,
    tests: parsedTests?.summary ?? null,
  };
}

function parseQa(data: Raw): Contribution {
  const source: UnityDiagnosticTool = "unity_qa";
  const explicitPass = boolean(data.pass);
  const checks: UnityDiagnosticCheck[] = [
    check(
      source,
      "verdict",
      TOOL_LABELS[source],
      explicitPass === undefined ? "unknown" : explicitPass ? "pass" : "fail",
    ),
  ];
  checks.push(...namedChecks(source, data.checks, "qa"));
  const problems: ProblemDraft[] = strings(data.reasons).map((message) => ({
    source,
    kind: "qa",
    severity: "error",
    message: cleanText(message),
  }));

  let tests: UnityDiagnosticTests | null = null;
  if (isRecord(data.verify)) {
    problems.push(...consoleProblems(source, data.verify.problems));
    const parsedTests = parseTests(data.verify.tests, source);
    if (parsedTests) {
      tests = parsedTests.summary;
      problems.push(...parsedTests.problems);
    }
  }
  if (isRecord(data.buildSettings)) {
    for (const message of strings(data.buildSettings.issues)) {
      problems.push({
        source,
        kind: "qa",
        severity: "error",
        message: cleanText(message),
      });
    }
  }
  problems.push(...missingAssetProblems(source, data.missingScripts, "script"));
  problems.push(...missingAssetProblems(source, data.missingReferences, "reference"));
  if (isRecord(data.smokeTest)) {
    problems.push(
      ...strings(data.smokeTest.reasons).map((message): ProblemDraft => ({
        source,
        kind: "qa",
        severity: "error",
        message: cleanText(message),
      })),
    );
    if (isRecord(data.smokeTest.console)) {
      problems.push(...consoleProblems(source, data.smokeTest.console.logs));
    }
  }

  return {
    verdict: verdictFromChecks(explicitPass, checks, problems),
    checks,
    problems,
    tests,
  };
}

function parseRunTests(data: Raw): Contribution {
  const source: UnityDiagnosticTool = "unity_run_tests";
  const parsed = parseTests(data, source);
  if (!parsed) return unknownContribution(source, "Test results were not readable.");
  const verdict = parsed.verdict === "skipped" ? "unknown" : parsed.verdict;
  const problems = [...parsed.problems];
  if (
    verdict === "fail" &&
    problems.length === 0 &&
    (parsed.summary.state === "cancelled" || parsed.summary.state === "not_found")
  ) {
    problems.push({
      source,
      kind: "test",
      severity: "error",
      message: `Unity test run ended with state '${parsed.summary.state}'.`,
    });
  }
  return {
    verdict,
    checks: [
      check(source, "tests", TOOL_LABELS[source], parsed.verdict, testDetail(parsed.summary)),
    ],
    problems,
    tests: parsed.summary,
  };
}

function parseConsole(data: Raw): Contribution {
  const source: UnityDiagnosticTool = "unity_get_console_logs";
  const logs = records(data.logs);
  if (!Array.isArray(data.logs)) {
    return unknownContribution(source, "Console logs were not readable.");
  }
  const problems = consoleProblems(source, logs);
  const errors = problems.filter((problem) => problem.severity === "error").length;
  const warnings = problems.length - errors;
  const truncated = data.truncated === true;
  const verdict: UnityDiagnosticVerdict =
    errors > 0 ? "fail" : truncated ? "unknown" : "pass";
  const parts = [`${errors} error(s)`, `${warnings} warning(s)`];
  if (truncated) parts.push("results truncated");
  return {
    verdict,
    checks: [check(source, "console", TOOL_LABELS[source], verdict, parts.join(", "))],
    problems,
    tests: null,
  };
}

function parseCompile(data: Raw): Contribution {
  const source: UnityDiagnosticTool = "unity_wait_for_compile";
  const isCompiling = boolean(data.isCompiling);
  const hasErrors = boolean(data.hasErrors);
  const errorCount = finiteNumber(data.errorCount);
  let verdict: UnityDiagnosticVerdict = "unknown";
  if (isCompiling === true) verdict = "running";
  else if (hasErrors === true || (errorCount !== undefined && errorCount > 0)) {
    verdict = "fail";
  } else if (isCompiling === false && hasErrors === false) {
    verdict = "pass";
  }
  const problems = compileProblems(source, data.errors);
  if (problems.some((problem) => problem.severity === "error")) {
    verdict = "fail";
  }
  if (verdict === "fail" && problems.length === 0) {
    problems.push({
      source,
      kind: "compile",
      severity: "error",
      message: `Compilation reported ${errorCount ?? "one or more"} error(s).`,
    });
  }
  const detail = [
    errorCount === undefined ? undefined : countDetail(errorCount, "error"),
    finiteNumber(data.warningCount) === undefined
      ? undefined
      : countDetail(finiteNumber(data.warningCount), "warning"),
  ]
    .filter((value): value is string => value !== undefined)
    .join(", ");
  return {
    verdict,
    checks: [check(source, "compile", TOOL_LABELS[source], verdict, detail)],
    problems,
    tests: null,
  };
}

function parseSmokeTest(source: UnityDiagnosticTool, data: Raw): Contribution {
  const explicitPass = boolean(data.pass);
  const checks: UnityDiagnosticCheck[] = [
    check(
      source,
      "verdict",
      TOOL_LABELS.unity_smoke_test,
      explicitPass === undefined ? "unknown" : explicitPass ? "pass" : "fail",
    ),
    ...namedChecks(source, data.checks, "smoke"),
  ];
  const problems: ProblemDraft[] = strings(data.reasons).map((message) => ({
    source,
    kind: "qa",
    severity: "error",
    message: cleanText(message),
  }));
  if (isRecord(data.console)) {
    problems.push(...consoleProblems(source, data.console.logs));
  }
  return {
    verdict: verdictFromChecks(explicitPass, checks, problems),
    checks,
    problems,
    tests: null,
  };
}

function parseTests(value: unknown, source: UnityDiagnosticTool): ParsedTests | null {
  if (typeof value === "string") {
    if (!/skip/i.test(value)) return null;
    return {
      summary: {
        source,
        state: "skipped",
        verdict: "skipped",
        updatedAt: 0,
        failures: [],
      },
      verdict: "skipped",
      problems: [],
    };
  }
  if (!isRecord(value)) return null;
  if (typeof value.error === "string") {
    const skipped = value.skipped === true || value.error === "TEST_FRAMEWORK_MISSING";
    const message = string(value.message);
    return {
      summary: {
        source,
        state: skipped ? "skipped" : "unavailable",
        verdict: skipped ? "skipped" : "unknown",
        updatedAt: 0,
        failures: [],
      },
      verdict: skipped ? "skipped" : "unknown",
      problems: message
        ? [
            {
              source,
              kind: "test",
              severity: "warning",
              message: cleanText(message),
            },
          ]
        : [],
    };
  }

  const rawState = string(value.state);
  const state: UnityDiagnosticTestState = isTestState(rawState) ? rawState : "unknown";
  const rawResults = Array.isArray(value.results) ? value.results : undefined;
  const testResults = rawResults?.filter(isRecord) ?? [];
  const failures = testResults
    .filter(
      (result) => result.status === "Failed" || result.status === "Inconclusive",
    )
    .slice(0, MAX_TEST_FAILURES)
    .map((result): UnityDiagnosticTestFailure => ({
      name: string(result.fullName) ?? string(result.name) ?? "Unnamed test",
      status: result.status as UnityDiagnosticTestFailure["status"],
      ...(string(result.message) ? { message: cleanText(string(result.message)!) } : {}),
      ...(string(result.stackTrace)
        ? { stackTrace: cleanStack(string(result.stackTrace)!) }
        : {}),
    }));
  const total = nonNegativeInteger(value.total);
  const passed = nonNegativeInteger(value.passed);
  const failed = nonNegativeInteger(value.failed);
  const skipped = nonNegativeInteger(value.skipped);
  let verdict: UnityDiagnosticCheckVerdict = "unknown";
  if (state === "running") verdict = "running";
  else if (state === "cancelled" || state === "not_found") verdict = "fail";
  else if (state === "completed") {
    if ((failed ?? 0) > 0 || failures.length > 0) {
      verdict = "fail";
    } else if (
      total !== undefined &&
      passed !== undefined &&
      failed !== undefined &&
      skipped !== undefined &&
      passed + failed + skipped === total &&
      completedTestResultsAreCredible(
        value,
        rawResults,
        testResults,
        total,
        passed,
        failed,
        skipped,
      )
    ) {
      verdict = "pass";
    }
  }

  const summary: UnityDiagnosticTests = {
    source,
    state,
    verdict,
    updatedAt: 0,
    ...(value.mode === "EditMode" || value.mode === "PlayMode"
      ? { mode: value.mode }
      : {}),
    ...(total !== undefined ? { total } : {}),
    ...(passed !== undefined ? { passed } : {}),
    ...(failed !== undefined ? { failed } : {}),
    ...(skipped !== undefined ? { skipped } : {}),
    ...(finiteNumber(value.durationSec) !== undefined
      ? { durationSec: finiteNumber(value.durationSec) }
      : {}),
    failures,
  };
  const problems = failures.map((failure): ProblemDraft => ({
    source,
    kind: "test",
    severity: "error",
    message: failure.message
      ? `${failure.name}: ${failure.message}`
      : `${failure.name} was ${failure.status.toLowerCase()}.`,
    ...(failure.stackTrace ? { stackTrace: failure.stackTrace } : {}),
  }));
  return { summary, verdict, problems };
}

function completedTestResultsAreCredible(
  value: Raw,
  rawResults: unknown[] | undefined,
  testResults: readonly Raw[],
  total: number,
  passed: number,
  failed: number,
  skipped: number,
): boolean {
  if (
    !rawResults ||
    rawResults.length !== testResults.length ||
    !testResults.every((result) => isTestResultStatus(result.status))
  ) {
    return false;
  }

  const resultCount = nonNegativeInteger(value.resultCount);
  const resultsTruncated = boolean(value.resultsTruncated);
  if (resultCount !== undefined) {
    if (resultCount !== total) return false;
    if (resultsTruncated === true) return testResults.length < resultCount;
    if (testResults.length !== resultCount) return false;
  } else {
    if (resultsTruncated === true || testResults.length !== total) return false;
  }

  const statuses = { Passed: 0, Failed: 0, Skipped: 0, Inconclusive: 0 };
  for (const result of testResults) {
    statuses[result.status as keyof typeof statuses] += 1;
  }
  return (
    statuses.Passed === passed &&
    statuses.Failed === failed &&
    statuses.Skipped === skipped &&
    statuses.Inconclusive === 0
  );
}

function parseEnvelope(text: string | undefined): ParsedEnvelope | null {
  if (!text) return null;
  const parsed = parseJson(text);
  if (!isRecord(parsed)) return null;
  if (typeof parsed.ok !== "boolean") {
    return { ok: true, data: parsed, warnings: [] };
  }
  const warnings = strings(parsed.warnings);
  if (parsed.ok) return { ok: true, data: parsed.data, warnings };
  const error = isRecord(parsed.error)
    ? { code: string(parsed.error.code), message: string(parsed.error.message) }
    : undefined;
  return { ok: false, warnings, ...(error ? { error } : {}) };
}

function parseJson(text: string): unknown {
  let candidate = text.replace(/^\uFEFF/, "").trim();
  const fenced = candidate.match(/^```(?:json)?\s*\n?([\s\S]*?)\n?```$/i);
  if (fenced) candidate = fenced[1].trim();
  try {
    return JSON.parse(candidate);
  } catch {
    return undefined;
  }
}

function namedChecks(
  source: UnityDiagnosticTool,
  value: unknown,
  prefix: string,
): UnityDiagnosticCheck[] {
  return records(value)
    .filter((entry) => typeof entry.pass === "boolean")
    .map((entry, index) => {
      const name = string(entry.name) ?? `check-${index + 1}`;
      const verdict: UnityDiagnosticCheckVerdict =
        entry.skipped === true ? "skipped" : entry.pass ? "pass" : "fail";
      return check(
        source,
        `${prefix}:${name}`,
        humanize(name),
        verdict,
        string(entry.summary),
      );
    });
}

function consoleProblems(source: UnityDiagnosticTool, value: unknown): ProblemDraft[] {
  return records(value).flatMap((entry): ProblemDraft[] => {
    const message = string(entry.message);
    const type = string(entry.type);
    if (!message || !type || (type !== "Warning" && !isConsoleError(type))) return [];
    return [
      {
        source,
        kind: "console",
        severity: type === "Warning" ? "warning" : "error",
        message: cleanText(message),
        ...(string(entry.stackTrace)
          ? { stackTrace: cleanStack(string(entry.stackTrace)!) }
          : {}),
      },
    ];
  });
}

function compileProblems(source: UnityDiagnosticTool, value: unknown): ProblemDraft[] {
  return records(value).flatMap((entry): ProblemDraft[] => {
    const message = string(entry.message);
    if (!message) return [];
    const type = entry.type === "warning" ? "warning" : "error";
    return [
      {
        source,
        kind: "compile",
        severity: type,
        message: cleanText(message),
        ...(string(entry.file) ? { file: string(entry.file) } : {}),
        ...(finiteNumber(entry.line) !== undefined
          ? { line: finiteNumber(entry.line) }
          : {}),
        ...(finiteNumber(entry.column) !== undefined
          ? { column: finiteNumber(entry.column) }
          : {}),
      },
    ];
  });
}

function missingAssetProblems(
  source: UnityDiagnosticTool,
  value: unknown,
  kind: "script" | "reference",
): ProblemDraft[] {
  if (!isRecord(value)) return [];
  return records(value.hits).map((hit) => {
    const file = string(hit.assetPath);
    const objectPath = string(hit.objectPath);
    const subject = [file, objectPath].filter(Boolean).join(": ") || "Unity asset";
    const detail =
      kind === "script"
        ? `${finiteNumber(hit.missingCount) ?? "one or more"} missing script(s)`
        : [string(hit.component), string(hit.field)].filter(Boolean).join(".") ||
          "missing object reference";
    return {
      source,
      kind: "qa",
      severity: "error",
      message:
        kind === "script"
          ? `${subject} has ${detail}.`
          : `${subject} has a missing reference (${detail}).`,
      ...(file ? { file } : {}),
    };
  });
}

function failedToolContribution(
  tool: UnityDiagnosticTool,
  detail?: string,
): Contribution {
  const message = cleanText(detail || `${TOOL_LABELS[tool]} failed.`);
  return {
    verdict: "fail",
    checks: [check(tool, "activity", TOOL_LABELS[tool], "fail", message)],
    problems: [
      { source: tool, kind: "tool", severity: "error", message },
    ],
    tests: null,
  };
}

function unknownContribution(tool: UnityDiagnosticTool, detail: string): Contribution {
  return {
    verdict: "unknown",
    checks: [check(tool, "activity", TOOL_LABELS[tool], "unknown", detail)],
    problems: [],
    tests: null,
  };
}

function diagnosticToolName(name: string): UnityDiagnosticTool | undefined {
  return UNITY_DIAGNOSTIC_TOOLS.find(
    (tool) => name === tool || name.endsWith(`__${tool}`),
  );
}

function compareCandidates(a: Candidate, b: Candidate): number {
  return (
    a.timestamp - b.timestamp ||
    a.order - b.order ||
    UNITY_DIAGNOSTIC_TOOLS.indexOf(a.tool) -
      UNITY_DIAGNOSTIC_TOOLS.indexOf(b.tool)
  );
}

function candidateCoversCandidate(
  later: Candidate,
  candidate: Candidate,
): boolean {
  if (later.tool === candidate.tool) {
    if (later.tool === "unity_run_tests") {
      return testScopeCovers(later, candidate);
    }
    if (later.tool === "unity_verify") {
      return (
        candidateInput(candidate).runTests === false ||
        testScopeCovers(later, candidate)
      );
    }
    if (later.tool === "unity_qa") {
      return qaScopeCovers(later, candidate);
    }
    return true;
  }

  if (later.tool === "unity_verify") {
    if (
      candidate.tool === "unity_wait_for_compile" ||
      candidate.tool === "unity_get_console_logs"
    ) {
      return true;
    }
    return (
      candidate.tool === "unity_run_tests" &&
      testScopeCovers(later, candidate)
    );
  }

  if (later.tool !== "unity_qa") return false;
  if (
    candidate.tool === "unity_wait_for_compile" ||
    candidate.tool === "unity_get_console_logs"
  ) {
    return true;
  }
  if (candidate.tool === "unity_run_tests") {
    return testScopeCovers(later, candidate);
  }
  if (candidate.tool === "unity_smoke_test") {
    return candidateInput(later).runSmokeTest !== false;
  }
  if (candidate.tool === "unity_verify") {
    const input = candidateInput(candidate);
    return input.runTests === false || testScopeCovers(later, candidate);
  }
  return false;
}

function qaScopeCovers(later: Candidate, candidate: Candidate): boolean {
  const laterInput = candidateInput(later);
  const candidateInputValue = candidateInput(candidate);
  if (
    candidateInputValue.runTests !== false &&
    !testScopeCovers(later, candidate)
  ) {
    return false;
  }
  if (
    candidateInputValue.checkAssets !== false &&
    laterInput.checkAssets === false
  ) {
    return false;
  }
  return !(
    candidateInputValue.runSmokeTest !== false &&
    laterInput.runSmokeTest === false
  );
}

function testScopeCovers(later: Candidate, candidate: Candidate): boolean {
  const laterInput = candidateInput(later);
  if (later.tool !== "unity_run_tests" && laterInput.runTests === false) {
    return false;
  }
  const candidateInputValue = candidateInput(candidate);
  const laterMode =
    string(laterInput.mode) ?? string(laterInput.testMode) ?? "EditMode";
  const candidateMode =
    string(candidateInputValue.mode) ??
    string(candidateInputValue.testMode) ??
    "EditMode";
  if (laterMode !== candidateMode) return false;
  const laterFilter =
    string(laterInput.filter)?.trim() ??
    string(laterInput.testFilter)?.trim() ??
    "";
  const candidateFilter =
    string(candidateInputValue.filter)?.trim() ??
    string(candidateInputValue.testFilter)?.trim() ??
    "";
  return laterFilter.length === 0 || laterFilter === candidateFilter;
}

function candidateInput(candidate: Candidate): Raw {
  return isRecord(candidate.activity.input) ? candidate.activity.input : {};
}

function isActualTestRun(tests: UnityDiagnosticTests): boolean {
  return tests.state !== "skipped" && tests.state !== "unavailable";
}

function activityTimestamp(activity: ToolActivity, messageCreatedAt: number): number {
  if (Number.isFinite(activity.endedAt)) return activity.endedAt!;
  if (Number.isFinite(activity.startedAt)) return activity.startedAt;
  return Number.isFinite(messageCreatedAt) ? messageCreatedAt : 0;
}

function check(
  source: UnityDiagnosticTool,
  id: string,
  label: string,
  verdict: UnityDiagnosticCheckVerdict,
  detail?: string,
): UnityDiagnosticCheck {
  const cleaned = detail ? cleanText(detail) : undefined;
  return {
    id: `${source}:${id}`,
    source,
    label,
    verdict,
    ...(cleaned ? { detail: cleaned } : {}),
  };
}

function verdictFromChecks(
  explicitPass: boolean | undefined,
  checks: readonly UnityDiagnosticCheck[],
  problems: readonly ProblemDraft[] = [],
): UnityDiagnosticVerdict {
  if (
    explicitPass === false ||
    checks.some((entry) => entry.verdict === "fail") ||
    problems.some((problem) => problem.severity === "error")
  ) {
    return "fail";
  }
  if (checks.some((entry) => entry.verdict === "running")) return "running";
  if (explicitPass === true && !checks.some((entry) => entry.verdict === "unknown")) {
    return "pass";
  }
  if (
    explicitPass === undefined &&
    checks.some((entry) => entry.verdict === "pass") &&
    !checks.some((entry) => entry.verdict === "unknown")
  ) {
    return "pass";
  }
  return "unknown";
}

function combineVerdicts(
  verdicts: readonly UnityDiagnosticVerdict[],
  newest: UnityDiagnosticVerdict | undefined,
): UnityDiagnosticVerdict {
  if (newest === "running") return "running";
  if (verdicts.includes("fail")) return "fail";
  if (verdicts.includes("running")) return "running";
  if (verdicts.includes("unknown")) return "unknown";
  return verdicts.includes("pass") ? "pass" : "unknown";
}

function dedupeChecks(checks: readonly UnityDiagnosticCheck[]): UnityDiagnosticCheck[] {
  const byId = new Map<string, UnityDiagnosticCheck>();
  for (const entry of checks) byId.set(entry.id, entry);
  return [...byId.values()];
}

function dedupeProblems(problems: readonly ProblemDraft[]): ProblemDraft[] {
  const seen = new Set<string>();
  return problems.filter((problem) => {
    const key = [
      problem.kind,
      problem.severity,
      problem.file,
      problem.line,
      problem.column,
      problem.message,
    ].join("\u0000");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function legacyVerdict(text: string | undefined): UnityDiagnosticVerdict {
  if (!text) return "unknown";
  const match = text.match(/["']?pass["']?\s*[:=]\s*(true|false)\b/i);
  if (match) return match[1].toLowerCase() === "true" ? "pass" : "fail";
  return "unknown";
}

function envelopeErrorText(envelope: ParsedEnvelope | null): string | undefined {
  if (!envelope || envelope.ok) return undefined;
  const code = envelope.error?.code;
  const message = envelope.error?.message;
  if (code && message) return `${code}: ${message}`;
  return message ?? code;
}

function testDetail(tests: UnityDiagnosticTests): string {
  if (tests.state !== "completed") return humanize(tests.state);
  const parts = [
    tests.passed === undefined ? undefined : `${tests.passed} passed`,
    tests.failed === undefined ? undefined : `${tests.failed} failed`,
    tests.skipped === undefined ? undefined : `${tests.skipped} skipped`,
  ].filter((value): value is string => value !== undefined);
  return parts.length > 0 ? parts.join(", ") : "Completed";
}

function countDetail(value: number | undefined, noun: string): string | undefined {
  return value === undefined ? undefined : `${value} ${noun}${value === 1 ? "" : "s"}`;
}

function formatLocation(problem: UnityDiagnosticProblem): string {
  if (!problem.file) return "";
  const line = problem.line === undefined ? "" : `:${problem.line}`;
  const column = problem.column === undefined ? "" : `:${problem.column}`;
  return `${problem.file}${line}${column}`;
}

function humanize(value: string): string {
  const words = value.replace(/[_-]+/g, " ").trim();
  return words ? words[0].toUpperCase() + words.slice(1) : "Check";
}

function cleanText(value: string): string {
  const text = oneLine(value);
  return text.length > 1_000 ? `${text.slice(0, 999)}…` : text;
}

function cleanStack(value: string): string {
  const text = value.trim();
  return text.length > 4_000 ? `${text.slice(0, 3_999)}…` : text;
}

function oneLine(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function isConsoleError(value: string): boolean {
  return value === "Error" || value === "Assert" || value === "Exception";
}

function isTestState(value: string | undefined): value is UnityDiagnosticTestState {
  return (
    value === "running" ||
    value === "completed" ||
    value === "cancelled" ||
    value === "not_found"
  );
}

function isTestResultStatus(
  value: unknown,
): value is "Passed" | "Failed" | "Skipped" | "Inconclusive" {
  return (
    value === "Passed" ||
    value === "Failed" ||
    value === "Skipped" ||
    value === "Inconclusive"
  );
}

function isRecord(value: unknown): value is Raw {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function records(value: unknown): Raw[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function string(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function boolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function nonNegativeInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 0
    ? value
    : undefined;
}
