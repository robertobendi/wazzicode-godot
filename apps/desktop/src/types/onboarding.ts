// Mirrors the Rust payloads in src-tauri/src/commands/onboarding.rs (serde
// camelCase). Keep the two in sync.

import type { ProjectInfo } from "@/types/project";
import type { AgentBackend } from "@/types/settings";

export interface CliStatus {
  found: boolean;
  path: string | null;
  version: string | null;
  /** Probe/install detail when the command exists but is not usable. */
  error: string | null;
}

export interface NodeSidecar {
  /** True in a packaged build (bundled node + gvibe.cjs present). */
  bundled: boolean;
}

export interface OnboardingStatus {
  /** The backend the user has selected — decides which CLI status matters. */
  agentBackend: AgentBackend;
  claudeCli: CliStatus;
  codexCli: CliStatus;
  nodeSidecar: NodeSidecar;
  currentProject: string | null;
  projectReady: ProjectInfo | null;
  pairedOk: boolean;
}

export interface SetupStep {
  id: string;
  ok: boolean;
  detail: string;
}

export interface DoctorSummary {
  projectValid: boolean;
  configOk: boolean;
  addonDetected: boolean;
  addonEnabled: boolean;
  runtimeProbeConfigured: boolean;
  brainReady: boolean;
  bridgeReachable: boolean;
  ok: boolean;
}

export interface SetupResult {
  steps: SetupStep[];
  summary: DoctorSummary | null;
}

/** Payload of the `onboarding:progress` event. */
export interface OnboardingProgress {
  step: string;
  line: string;
}
