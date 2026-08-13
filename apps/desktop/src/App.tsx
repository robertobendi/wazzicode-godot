import { useEffect, useState } from "react";
import { api } from "@/api";
import { useSettingsStore } from "@/stores/useSettingsStore";
import { useChatStore } from "@/stores/useChatStore";
import { useUiStore } from "@/stores/useUiStore";
import { useSessionsStore } from "@/stores/useSessionsStore";
import { useRevertStore } from "@/stores/useRevertStore";
import { useBridgeStatus } from "@/hooks/useBridgeStatus";
import { useDebugCapture } from "@/hooks/useDebugCapture";
import { useLoopEvents } from "@/hooks/useLoopEvents";
import { useCheckpointEvents } from "@/hooks/useCheckpointEvents";
import { useAgentStream } from "@/hooks/useAgentStream";
import { useTheme } from "@/hooks/useTheme";
import { useLoopStore } from "@/stores/useLoopStore";
import { authenticationBackend } from "@/lib/appRouting";
import PairingScreen from "@/components/pairing/PairingScreen";
import CodexAuthScreen from "@/components/codex/CodexAuthScreen";
import OnboardingWizard from "@/components/onboarding/OnboardingWizard";
import ProjectPicker from "@/components/project/ProjectPicker";
import ProjectMapDrawer from "@/components/project/ProjectMapDrawer";
import ChatView from "@/components/chat/ChatView";
import SessionRail from "@/components/chat/SessionRail";
import LoopPanel from "@/components/loop/LoopPanel";
import ActivityPanel from "@/components/activity/ActivityPanel";
import TopBar from "@/components/shell/TopBar";
import ConnectionBanner from "@/components/shell/ConnectionBanner";
import DebugDrawer from "@/components/shell/DebugDrawer";
import ToastHost from "@/components/shell/Toast";
import type { ProjectInfo } from "@/types/project";

interface ProjectReadiness {
  path: string;
  checking: boolean;
  info: ProjectInfo | null;
  error: string | null;
}

export default function App() {
  const { settings, load } = useSettingsStore();
  const updateSettings = useSettingsStore((s) => s.update);
  const setProject = useChatStore((s) => s.setProject);
  const activityOpen = useUiStore((s) => s.activityOpen);
  const sessionRailOpen = useUiStore((s) => s.sessionRailOpen);
  const mode = useUiStore((s) => s.mode);
  const repairing = useUiStore((s) => s.repairing);
  const setRepairing = useUiStore((s) => s.setRepairing);
  const setSettingsOpen = useUiStore((s) => s.setSettingsOpen);
  const hydrateLoop = useLoopStore((s) => s.hydrate);

  useTheme(settings?.theme);

  useEffect(() => {
    void load();
  }, [load]);

  const project = settings?.currentProject ?? null;
  const [projectReadiness, setProjectReadiness] =
    useState<ProjectReadiness | null>(null);

  // A persisted project may predate the project knowledge store. Inspect it
  // before mounting chat so it is explicitly prepared instead of silently
  // opening without the context future tasks rely on.
  useEffect(() => {
    if (!project || !settings?.onboarded) {
      setProjectReadiness(null);
      return;
    }
    let alive = true;
    setProjectReadiness({
      path: project,
      checking: true,
      info: null,
      error: null,
    });
    void api
      .validateUnityProject(project)
      .then((info) => {
        if (alive) {
          setProjectReadiness({
            path: project,
            checking: false,
            info,
            error: null,
          });
        }
      })
      .catch((error) => {
        if (alive) {
          setProjectReadiness({
            path: project,
            checking: false,
            info: null,
            error: String(error),
          });
        }
      });
    return () => {
      alive = false;
    };
  }, [project, settings?.onboarded]);

  function leaveAuthentication() {
    setRepairing(false);
    setSettingsOpen(true);
  }

  // Keep the chat store's project in sync (resets the conversation on change).
  // On a real switch, autosave the outgoing chat and reload history for the new
  // project; clear the stale revert checkpoint.
  useEffect(() => {
    const prev = useChatStore.getState();
    if (prev.project && prev.project !== project) {
      void useSessionsStore.getState().autosave(prev.project);
      useSessionsStore.getState().reset();
      useRevertStore.getState().clear();
    }
    setProject(project);
    if (project) void useSessionsStore.getState().refresh(project);
  }, [project, setProject]);

  // Load any persisted auto-mode loop for the open project.
  useEffect(() => {
    if (project) void hydrateLoop(project);
  }, [project, hydrateLoop]);

  // Poll the Unity bridge whenever a project is open; capture raw debug events;
  // mirror the auto-loop broadcasts (kept mounted in both modes).
  useBridgeStatus(project);
  useAgentStream();
  useDebugCapture();
  useLoopEvents();
  useCheckpointEvents();

  if (!settings) {
    return (
      <div className="flex h-full w-full items-center justify-center bg-ink-950 text-sm text-fg-dim">
        Loading…
      </div>
    );
  }

  // First run: the onboarding wizard subsumes the pairing gate + project pick.
  if (!settings.onboarded) {
    return (
      <OnboardingWizard
        onComplete={() => {
          void updateSettings({ onboarded: true });
        }}
      />
    );
  }

  // Selecting an agent must never unmount the project shell. Authentication is
  // a separate, explicit Settings action; onboarding has already checked it on
  // first run. This keeps a routine Claude/Codex switch from looking like the
  // whole app closed.
  const authBackend = authenticationBackend(settings.agentBackend, repairing);
  if (authBackend === "codex") {
    return (
      <CodexAuthScreen
        onDone={() => setRepairing(false)}
        onChooseAgent={leaveAuthentication}
        forceSignIn
      />
    );
  }
  if (authBackend === "claude") {
    return (
      <PairingScreen
        onDone={() => {
          void updateSettings({ pairedOk: true });
          setRepairing(false);
        }}
        onChooseAgent={leaveAuthentication}
        forcePair
      />
    );
  }

  if (!project) {
    return <ProjectPicker />;
  }

  if (
    !projectReadiness ||
    projectReadiness.path !== project ||
    projectReadiness.checking
  ) {
    return (
      <div className="flex h-full w-full items-center justify-center bg-ink-950 text-sm text-fg-dim">
        Checking project map…
      </div>
    );
  }

  if (
    projectReadiness.error ||
    !projectReadiness.info?.ok ||
    !projectReadiness.info.brainReady
  ) {
    return (
      <ProjectPicker
        initialCandidate={projectReadiness.info}
        initialError={
          projectReadiness.error ??
          (projectReadiness.info?.ok
            ? null
            : "The selected folder is no longer a valid Unity project.")
        }
        onOpened={(info) =>
          setProjectReadiness({
            path: info.path,
            checking: false,
            info,
            error: null,
          })
        }
      />
    );
  }

  return (
    <div className="app-shell flex h-full w-full flex-col bg-ink-950 text-fg">
      <TopBar />
      <ProjectMapDrawer project={project} />
      <ConnectionBanner />
      <div className="workspace-shell relative flex min-h-0 flex-1">
        {mode === "auto" ? (
          <LoopPanel />
        ) : (
          <>
            {sessionRailOpen && <SessionRail />}
            <ChatView />
            {activityOpen && <ActivityPanel />}
          </>
        )}
      </div>
      {settings.debugDrawer && <DebugDrawer />}
      <ToastHost />
    </div>
  );
}
