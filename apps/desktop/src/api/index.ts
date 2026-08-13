// Typed wrappers around Tauri `invoke`. One place to discover the IPC surface;
// later phases extend this as new Rust commands land.

import { invoke } from "@tauri-apps/api/core";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { openUrl } from "@tauri-apps/plugin-opener";
import type {
  AgentBackend,
  AgentModelOption,
  AgentRunOptions,
} from "@/types/agent";
import type { Settings } from "@/types/settings";
import type { ProjectInfo } from "@/types/project";
import type { ChatTerminalEvent, StagedResource } from "@/types/chat";
import type { AuthStatus, AuthVerify, PairingState } from "@/types/pairing";
import type { CodexAuthStatus } from "@/types/codex";
import type { LoopOptions, LoopState } from "@/types/loop";
import type { RevertResult } from "@/types/revert";
import type { SessionIndexEntry, SessionPayload } from "@/types/session";
import type { QuickAction } from "@/lib/quickActions";
import type {
  ProjectMapAnswer,
  ProjectMapData,
  ProjectMapQueryResult,
} from "@/types/projectMap";
import type { UnityDiagnosticsSnapshot } from "@/types/unityDiagnostics";
import type {
  CliStatus,
  OnboardingStatus,
  SetupResult,
} from "@/types/onboarding";

export const api = {
  getSettings: () => invoke<Settings>("get_settings"),
  updateSettings: (settings: Settings) =>
    invoke<Settings>("update_settings", { settings }),
  // Liveness probe used during startup/dev.
  ping: () => invoke<string>("ping"),

  // Project selection / validation.
  validateUnityProject: (path: string) =>
    invoke<ProjectInfo>("validate_unity_project", { path }),
  setCurrentProject: (path: string) =>
    invoke<Settings>("set_current_project", { path }),
  readProjectMap: (project: string) =>
    invoke<ProjectMapData | null>("read_project_map", { project }),
  queryProjectMap: (project: string, query: string, limit = 50) =>
    invoke<ProjectMapQueryResult>("query_project_map", {
      project,
      query,
      limit,
    }),
  refreshProjectMap: (project: string) =>
    invoke<ProjectMapData>("refresh_project_map", { project }),
  /** Ask about the project. Read-only: the agent gets no write tools. */
  askProjectMap: (project: string, question: string) =>
    invoke<ProjectMapAnswer>("ask_project_map", { project, question }),

  // Chat: returns the runId to subscribe to (agent:stream/done/error:<runId>).
  chatSend: (
    project: string,
    prompt: string,
    resumeSessionId: string | null,
    options: AgentRunOptions,
  ) => invoke<string>("chat_send", { project, prompt, resumeSessionId, options }),
  chatCancel: (runId: string) => invoke<void>("chat_cancel", { runId }),
  chatSubscribe: (runId: string) =>
    invoke<ChatTerminalEvent | null>("chat_subscribe", { runId }),

  // Models and supported reasoning levels reported by the selected CLI.
  agentModelCatalog: (backend: AgentBackend) =>
    invoke<AgentModelOption[]>("agent_model_catalog", { backend }),

  // Revert: roll the project back to the last studio checkpoint. Availability
  // arrives on the `checkpoint:ready` event; this undoes the last AI turn.
  revertLast: (project: string) =>
    invoke<RevertResult>("revert_last", { project }),

  // Session history: persist + resume past chats under .unity-vibe/studio.
  saveSession: (project: string, payload: SessionPayload) =>
    invoke<void>("save_session", { project, payload }),
  listSessions: (project: string) =>
    invoke<SessionIndexEntry[]>("list_sessions", { project }),
  loadSession: (project: string, sessionId: string) =>
    invoke<SessionPayload>("load_session", { project, sessionId }),
  deleteSession: (project: string, sessionId: string) =>
    invoke<void>("delete_session", { project, sessionId }),

  // Quick actions: effective starter prompts (project override or defaults).
  readQuickActions: (project: string) =>
    invoke<QuickAction[]>("read_quick_actions", { project }),

  // Bridge status poller (emits `status:update`).
  statusStart: (project: string) => invoke<void>("status_start", { project }),
  statusStop: () => invoke<void>("status_stop"),

  // Capture the live game/scene view; returns the on-disk PNG path to render.
  bridgeCapture: (
    project: string,
    kind: "game" | "scene" | "selected" = "game",
  ) =>
    invoke<{ pngPath: string }>("bridge_capture", { project, kind }),
  unityDiagnostics: (project: string) =>
    invoke<UnityDiagnosticsSnapshot>("unity_diagnostics", { project }),
  unityClearConsole: (project: string) =>
    invoke<void>("unity_clear_console", { project }),

  // Resource funnel: copy dropped/pasted files into the project inbox.
  stagePaths: (project: string, paths: string[]) =>
    invoke<StagedResource[]>("stage_paths", { project, paths }),
  pasteClipboard: (project: string) =>
    invoke<StagedResource[]>("paste_clipboard", { project }),
  removeStaged: (path: string) => invoke<void>("remove_staged", { path }),

  // Pairing: hidden-PTY `claude setup-token` flow. State arrives on the
  // `pairing:update` event; pairingStart returns the pairing id for submitCode.
  pairingStart: () => invoke<string>("pairing_start"),
  pairingSubmitCode: (pairingId: string, code: string) =>
    invoke<void>("pairing_submit_code", { pairingId, code }),
  pairingCancel: () => invoke<void>("pairing_cancel"),
  pairingState: () => invoke<PairingState | null>("pairing_state"),

  // Auth: stored company token status / verification / removal.
  authStatus: () => invoke<AuthStatus>("auth_status"),
  authVerify: () => invoke<AuthVerify>("auth_verify"),
  authClear: () => invoke<void>("auth_clear"),

  // Codex sign-in. Credentials stay with the Codex CLI (~/.codex) — nothing
  // here returns a token. Browser sign-in streams progress on `codex:login`.
  // ChatGPT-subscription only: there is no API-key command, because that bills
  // API credits rather than the user's plan (Rust also isolates child auth).
  codexAuthStatus: () => invoke<CodexAuthStatus>("codex_auth_status"),
  codexLoginStart: () => invoke<void>("codex_login_start"),
  codexLoginCancel: () => invoke<void>("codex_login_cancel"),
  codexLogout: () => invoke<void>("codex_logout"),

  // Auto mode: the autonomous dev loop. State arrives on the `loop:update`
  // event; loopStart returns the loop id.
  loopStart: (project: string, goal: string, options: LoopOptions) =>
    invoke<string>("loop_start", { project, goal, options }),
  loopStop: () => invoke<void>("loop_stop"),
  loopFeedback: (comment: string) =>
    invoke<void>("loop_feedback", { comment }),
  loopState: (project: string) =>
    invoke<LoopState | null>("loop_state", { project }),

  // Onboarding wizard. Setup + install stream progress on `onboarding:progress`.
  // The CLI steps take the backend, so only the selected agent must be present.
  onboardingStatus: () => invoke<OnboardingStatus>("onboarding_status"),
  onboardingCheckCli: (backend: AgentBackend) =>
    invoke<CliStatus>("onboarding_check_cli", { backend }),
  onboardingInstallCli: (backend: AgentBackend) =>
    invoke<CliStatus>("onboarding_install_cli", { backend }),
  onboardingSetupProject: (project: string) =>
    invoke<SetupResult>("onboarding_setup_project", { project }),
};

/** Open a native folder picker. Returns null if cancelled. */
export async function pickFolder(title = "Pick your Unity project") {
  const result = await openDialog({ directory: true, multiple: false, title });
  if (typeof result === "string") return result;
  return null;
}

/** Open a URL in the default browser. */
export async function openExternal(url: string) {
  await openUrl(url);
}
