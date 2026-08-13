import type { LoopState } from "@/types/loop";

export function buildContinuationContext(
  state: LoopState,
  note: string,
): string {
  const completed = state.iterations
    .filter((iteration) => iteration.summary.trim())
    .map(
      (iteration) =>
        `- Step ${iteration.index + 1}: ${iteration.summary.trim()}`,
    );
  const guidance = note.trim();

  return [
    "This is a continuation of an interrupted Auto run.",
    "Work from the current project and git state. Do not redo completed work.",
    completed.length > 0
      ? `Completed steps:\n${completed.join("\n")}`
      : "No step completed before the interruption. Inspect the current project state before acting.",
    "The original goal was not confirmed complete. Identify the remaining work, then implement the next safe increment.",
    guidance ? `New user guidance:\n${guidance}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");
}

export function failureMessage(state: LoopState, agentLabel: string): string {
  if (state.failure?.message.trim()) return state.failure.message.trim();

  const warning = state.warnings.find((item) =>
    item.startsWith(`${agentLabel} task failed:`),
  );
  const detail = warning?.slice(warning.indexOf(":") + 1).trim() ?? "";
  if (detail && !detail.startsWith("```") && !detail.startsWith("{")) {
    return detail;
  }
  return `${agentLabel} stopped unexpectedly before the next step was recorded.`;
}
