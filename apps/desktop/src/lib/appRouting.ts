import type { AgentBackend } from "@/types/agent";

/**
 * Normal backend selection stays inside the project shell. A full-screen auth
 * surface is reserved for the user's explicit Sign in / Re-pair action.
 */
export function authenticationBackend(
  backend: AgentBackend,
  repairing: boolean,
): AgentBackend | null {
  return repairing ? backend : null;
}
