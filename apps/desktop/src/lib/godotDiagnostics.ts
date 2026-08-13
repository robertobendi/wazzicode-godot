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

export const GODOT_DIAGNOSTIC_TOOLS = ["godot_verify"] as const;
export const MAX_MCP_RESULT_TEXT_CHARS = 200_000;

export function boundMcpResultText(text: string | undefined): {
  resultRaw?: string;
  resultRawTruncated?: boolean;
} {
  if (!text) return {};
  if (text.length <= MAX_MCP_RESULT_TEXT_CHARS) return { resultRaw: text };
  return {
    resultRaw: text.slice(0, MAX_MCP_RESULT_TEXT_CHARS),
    resultRawTruncated: true,
  };
}

export function isGodotDiagnosticActivity(name: string): boolean {
  return normalizedToolName(name) === "godot_verify";
}

export function collectGodotDiagnostics(
  messages: readonly ChatMessage[],
): GodotVerification | null {
  let latest:
    | { raw: string; status: string; endedAt: number }
    | undefined;

  for (const message of messages) {
    for (const activity of message.activities) {
      if (!isGodotDiagnosticActivity(activity.name) || !activity.resultRaw) continue;
      const endedAt = activity.endedAt ?? activity.startedAt;
      if (!latest || endedAt >= latest.endedAt) {
        latest = {
          raw: activity.resultRaw.slice(0, MAX_MCP_RESULT_TEXT_CHARS),
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

  const payload = parsePayload(latest.raw);
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

function parsePayload(raw: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    const envelope = object(parsed);
    if (envelope.ok === false) return null;
    const candidate = envelope.data ?? envelope.result;
    if (!candidate || typeof candidate !== "object") return null;
    const payload = object(candidate);
    if (
      !["pass", "fail", "unverified"].includes(string(payload.verdict))
      || typeof object(payload.import).ok !== "boolean"
      || !Number.isInteger(object(payload.scripts).checked)
      || !Number.isInteger(object(payload.scripts).failed)
      || !Array.isArray(object(payload.scripts).failures)
    ) return null;
    return payload;
  } catch {
    return null;
  }
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
