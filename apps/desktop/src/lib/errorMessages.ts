// Turn raw error text (bridge error codes, CLI stderr) into human-friendly,
// non-technical messages. Returns null when nothing matches so callers can
// fall back to whatever friendly text the backend already provided.
//
// Auth expiry is the one message that differs per agent — the two backends have
// completely different recovery paths (re-pair vs. sign in), so the copy has to
// name the right one. Callers don't pass it: it's read from settings.

import { currentBackend } from "@/lib/agentLabel";
import { BACKENDS, type AgentBackend } from "@/types/settings";

// How the OS says "that program isn't there", across both platforms and both
// layers that report it (Rust's io::Error, Node's spawn errors).
const CLI_MISSING = [
  "enoent",
  "no such file",
  "program not found",
  "os error 2",
  "os error 3",
];

export function mapErrorMessage(
  raw: string | undefined | null,
  backend: AgentBackend = currentBackend(),
): string | null {
  if (!raw) return null;
  const text = raw.toLowerCase();

  if (text.includes("godot_not_connected")) {
    return "Godot isn't connected. Open this project in the Godot editor.";
  }
  if (text.includes("godot_reloading")) {
    return "The Godot addon is restarting. Give it a moment and try again.";
  }
  if (text.includes("project_identity_mismatch")) {
    return "A different Godot project is open. Switch the editor to this project.";
  }
  // Before the auth branch: a CLI we couldn't even launch has no session to
  // have expired, and "reinstall" is the only thing that helps.
  if (CLI_MISSING.some((needle) => text.includes(needle))) {
    return `The ${BACKENDS[backend].label} CLI wasn't found. It may be installed but not visible to desktop apps — try opening this app from a terminal, or reinstall the CLI.`;
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
  view: "2d" | "3d",
): string {
  const text = raw.toLowerCase();
  if (text.includes("capture_unavailable")) {
    return `Open the ${view.toUpperCase()} workspace in the Godot editor, then try again.`;
  }
  return friendlyError(raw, `Couldn't capture the ${view.toUpperCase()} viewport.`);
}
