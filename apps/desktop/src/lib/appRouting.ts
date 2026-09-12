import type { AgentBackend } from "@/types/agent";

/**
 * Normal backend selection stays inside the project shell. A full-screen auth
 * surface is reserved for the user's explicit Sign in / Re-pair action.
 */
export function authenticationBackend(
  backend: AgentBackend,
  repairing: boolean,
): AgentBackend | null {
  if (!repairing) return null;
  // OpenCode has no account to pair: its providers are keys managed inline in
  // Settings, so it never takes over the full-screen auth surface.
  if (backend === "opencode") return null;
  return backend;
}
