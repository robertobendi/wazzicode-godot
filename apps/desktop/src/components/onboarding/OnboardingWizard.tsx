import { useEffect, useState } from "react";
import { api } from "@/api";
import { useSettingsStore } from "@/stores/useSettingsStore";
import PairingScreen from "@/components/pairing/PairingScreen";
import CodexAuthScreen from "@/components/codex/CodexAuthScreen";
import type { OnboardingStatus } from "@/types/onboarding";
import type { ProjectInfo } from "@/types/project";
import type { AgentBackend } from "@/types/settings";
import { Spinner, Stepper } from "./_shared";
import WelcomeStep from "./WelcomeStep";
import ProjectStep from "./ProjectStep";
import SetupStep from "./SetupStep";
import ReadyStep from "./ReadyStep";

const STEP = {
  welcome: 0,
  project: 1,
  setup: 2,
  connect: 3,
  ready: 4,
} as const;

/**
 * First-run wizard. Subsumes the pairing gate + project pick on a fresh install:
 * pick the agent and detect/install its CLI → pick project → prepare it →
 * sign in / connect the account → confirm Unity connects. Completing sets
 * settings.onboarded.
 *
 * Everything after step 1 is backend-aware: the "Connect" step routes to the
 * Claude pairing flow or the Codex sign-in flow, which have nothing in common
 * beyond "the agent can now talk to its provider".
 */
export default function OnboardingWizard({ onComplete }: { onComplete: () => void }) {
  const setSettings = useSettingsStore((s) => s.setSettings);
  const updateSettings = useSettingsStore((s) => s.update);
  const settingsError = useSettingsStore((s) => s.error);
  const [status, setStatus] = useState<OnboardingStatus | null>(null);
  const [backend, setBackend] = useState<AgentBackend>("claude");
  const [step, setStep] = useState<number>(STEP.welcome);
  const [project, setProject] = useState<ProjectInfo | null>(null);

  // Load status once to pre-fill completed prerequisites. The agent choice is
  // always shown first: an installed default CLI is not a user selection.
  useEffect(() => {
    let alive = true;
    void api
      .onboardingStatus()
      .then((s) => {
        if (!alive) return;
        setStatus(s);
        setBackend(s.agentBackend);
        if (s.projectReady?.ok) setProject(s.projectReady);
      })
      .catch(() => alive && setStatus(EMPTY_STATUS));
    return () => {
      alive = false;
    };
  }, []);

  function pickBackend(next: AgentBackend) {
    setBackend(next);
    // Persist immediately — chat/loop runs read this from settings, and the
    // wizard can be abandoned halfway.
    void updateSettings({ agentBackend: next });
  }

  async function continueFromWelcome() {
    // Queue one final save and wait for it. Project selection writes the full
    // canonical Settings object through a separate command, so the two writes
    // must never overlap and lose the selected backend.
    await updateSettings({ agentBackend: backend });
    if (!useSettingsStore.getState().error) setStep(STEP.project);
  }

  async function pickProject(info: ProjectInfo) {
    setProject(info);
    try {
      // Persist so ReadyStep's bridge poll + the post-onboarding app see it.
      const saved = await api.setCurrentProject(info.path);
      setSettings(saved);
    } catch {
      // Non-fatal — setup still runs against the chosen path.
    }
    setStep(STEP.setup);
  }

  if (!status) {
    return (
      <div className="flex h-full w-full items-center justify-center bg-ink-950 text-sm text-fg-dim">
        <Spinner /> <span className="ml-2">Getting things ready…</span>
      </div>
    );
  }

  // Connect step: hand off to the selected backend's full-screen auth flow. Both
  // check-first (already connected → a tick and continue) and replace the wizard
  // chrome with their own. Codex has no `pairedOk` — being signed in with the
  // CLI *is* the satisfied state, and CodexAuthScreen probes that itself.
  if (step === STEP.connect) {
    if (backend === "codex") {
      return (
        <CodexAuthScreen
          onDone={() => setStep(STEP.ready)}
          onChooseAgent={() => setStep(STEP.welcome)}
        />
      );
    }
    return (
      <PairingScreen
        onDone={() => {
          void updateSettings({ pairedOk: true });
          setStep(STEP.ready);
        }}
        onChooseAgent={() => setStep(STEP.welcome)}
        forcePair={!status?.pairedOk}
      />
    );
  }

  const projectName = project?.name ?? "your project";

  return (
    <div className="flex h-full w-full items-center justify-center bg-ink-950 px-8">
      <div className="w-full max-w-lg animate-appear">
        <Stepper current={step} />

        {step === STEP.welcome && (
          <WelcomeStep
            key={backend}
            backend={backend}
            onBackendChange={pickBackend}
            initial={cliFor(status, backend)}
            settingsError={settingsError}
            onContinue={() => void continueFromWelcome()}
          />
        )}

        {step === STEP.project && (
          <ProjectStep
            initial={project ?? status.projectReady}
            onPicked={(info) => void pickProject(info)}
            onBack={() => setStep(STEP.welcome)}
          />
        )}

        {step === STEP.setup && project && (
          <SetupStep
            project={project.path}
            projectName={projectName}
            onDone={() => setStep(STEP.connect)}
            onBack={() => setStep(STEP.project)}
          />
        )}

        {step === STEP.ready && project && (
          <ReadyStep
            project={project.path}
            projectName={projectName}
            onFinish={onComplete}
          />
        )}
      </div>
    </div>
  );
}

/** The CLI status that matters for the selected backend. */
function cliFor(s: OnboardingStatus, backend: AgentBackend) {
  return backend === "codex" ? s.codexCli : s.claudeCli;
}

const EMPTY_STATUS: OnboardingStatus = {
  agentBackend: "claude",
  claudeCli: { found: false, path: null, version: null, error: null },
  codexCli: { found: false, path: null, version: null, error: null },
  nodeSidecar: { bundled: false },
  currentProject: null,
  projectReady: null,
  pairedOk: false,
};
