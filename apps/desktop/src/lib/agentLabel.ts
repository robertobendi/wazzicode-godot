// Naming the agent in user-facing copy, for the non-component code (stores,
// error mapping) that can't call a hook. Components should read `agentBackend`
// from useSettingsStore at render time instead.

import { useSettingsStore } from "@/stores/useSettingsStore";
import { BACKENDS, type AgentBackend } from "@/types/settings";

/** The selected backend, defaulting to Claude before settings have loaded. */
export function currentBackend(): AgentBackend {
  return useSettingsStore.getState().settings?.agentBackend ?? "claude";
}

/** Display name of the selected backend ("Claude Code" / "ChatGPT Codex"). */
export function agentLabel(): string {
  return BACKENDS[currentBackend()].label;
}
