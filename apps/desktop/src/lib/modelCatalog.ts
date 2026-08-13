import type {
  AgentBackend,
  AgentModelOption,
  AgentRunOptions,
} from "@/types/agent";

export const CLAUDE_DEFAULT_EFFORTS = [
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];

const EFFORT_STRENGTH = [
  "ultra",
  "max",
  "xhigh",
  "high",
  "medium",
  "low",
];

const MODEL_LABELS: Record<string, string> = {
  fable: "Fable (latest)",
  opus: "Opus (latest)",
  sonnet: "Sonnet",
  haiku: "Haiku",
  "gpt-5.6-sol": "GPT-5.6-Sol",
};

export function effortsForModel(
  backend: AgentBackend,
  catalog: AgentModelOption[],
  model: string | null,
): string[] {
  if (!model) return backend === "claude" ? CLAUDE_DEFAULT_EFFORTS : [];
  const listed = catalog.find((option) => option.id === model);
  if (listed) return listed.efforts;
  return backend === "claude"
    ? ["low", "medium", "high", "xhigh", "max"]
    : [];
}

export function repairRunOptions(
  options: AgentRunOptions,
  catalog: AgentModelOption[],
): AgentRunOptions {
  const model = options.model?.trim() || null;
  const efforts = effortsForModel(options.backend, catalog, model);
  const effort = options.effort?.trim() || null;
  const listed = catalog.find((option) => option.id === model);
  const repairedEffort = listed
    ? effort && listed.efforts.includes(effort)
      ? effort
      : strongestEffort(listed.efforts)
    : effort && efforts.includes(effort)
      ? effort
      : null;
  return {
    backend: options.backend,
    model,
    effort: repairedEffort,
  };
}

export function strongestEffort(efforts: readonly string[]): string | null {
  return EFFORT_STRENGTH.find((effort) => efforts.includes(effort)) ?? null;
}

export function customModelRunOptions(
  options: AgentRunOptions,
  model: string,
): AgentRunOptions {
  return {
    ...options,
    model: model.trim() || null,
    // A full provider id can have different capabilities from its alias. Let
    // the installed CLI choose unless the user explicitly selects an effort.
    effort: null,
  };
}

export function effortLabel(effort: string): string {
  const labels: Record<string, string> = {
    low: "Low",
    medium: "Medium",
    high: "High",
    xhigh: "Extra high",
    max: "Maximum",
    ultra: "Ultra",
  };
  return labels[effort] ?? effort.replaceAll("_", " ");
}

export function modelLabel(model: string): string {
  return MODEL_LABELS[model] ?? model;
}

export function runOptionsSummary(options: AgentRunOptions): string {
  const model = options.model ? modelLabel(options.model) : "CLI-selected model";
  const effort = options.effort
    ? effortLabel(options.effort)
    : "CLI-selected thinking";
  return `${model} · ${effort}`;
}
