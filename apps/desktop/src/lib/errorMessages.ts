// Turn raw error text (bridge error codes, CLI stderr) into human-friendly,
// non-technical messages. Returns null when nothing matches so callers can
// fall back to whatever friendly text the backend already provided.
//
// Auth expiry is the one message that differs per agent — the two backends have
// completely different recovery paths (re-pair vs. sign in), so the copy has to
// name the right one. Callers don't pass it: it's read from settings.

import { currentBackend } from "@/lib/agentLabel";
import type { AgentBackend } from "@/types/settings";

export function mapErrorMessage(
  raw: string | undefined | null,
  backend: AgentBackend = currentBackend(),
): string | null {
  if (!raw) return null;
  const text = raw.toLowerCase();

  if (text.includes("unity_not_connected")) {
    return "Unity isn't connected. Open Unity and load your project.";
  }
  if (text.includes("unity_reloading")) {
    return "Unity is busy recompiling. Give it a moment and try again.";
  }
  if (text.includes("project_identity_mismatch")) {
    return "A different Unity project is open. Switch Unity to this project.";
  }
  if (
    text.includes("invalid api key") ||
    text.includes("401") ||
    text.includes("unauthorized") ||
    text.includes("not logged in") ||
    text.includes("authentication")
  ) {
    return backend === "codex"
      ? "Codex isn't signed in — go to Settings → Sign in to Codex."
      : "Your connection expired — go to Settings → Re-pair account.";
  }
  return null;
}

/** Resolve the best message to show: a mapped one, else the provided fallback. */
export function friendlyError(
  raw: string | undefined | null,
  fallback: string,
  backend?: AgentBackend,
): string {
  return mapErrorMessage(raw, backend ?? currentBackend()) ?? fallback;
}

export function screenshotErrorMessage(
  raw: string,
  view: "game" | "scene" | "selected",
): string {
  const text = raw.toLowerCase();
  if (view === "selected" && text.includes("no gameobject is selected")) {
    return "Select a GameObject in Unity's Hierarchy, then try again.";
  }
  if (view === "game" && text.includes("no suitable camera")) {
    return "Add or enable a Camera in the active scene, then try again.";
  }
  if (view === "scene" && text.includes("no sceneview is currently open")) {
    return "Open Unity's Scene view, then try again.";
  }
  return friendlyError(raw, `Couldn't capture the ${view} view.`);
}
