import { useEffect, useRef, useState } from "react";
import { api } from "@/api";
import { useCliSetup, useOnboardingProgress } from "@/hooks/useOnboarding";
import { useSettingsStore } from "@/stores/useSettingsStore";
import { usePairingStore } from "@/stores/usePairingStore";
import { useChatStore } from "@/stores/useChatStore";
import { useSessionsStore } from "@/stores/useSessionsStore";
import { useLoopStore } from "@/stores/useLoopStore";
import { useToastStore } from "@/stores/useToastStore";
import { isLoopActive } from "@/types/loop";
import { useUiStore } from "@/stores/useUiStore";
import { BACKENDS, type AgentBackend } from "@/types/settings";
import BackendPicker from "./BackendPicker";
import ThemePicker from "./ThemePicker";

/**
 * Focused settings dialog. Model/thinking controls stay in the composer where
 * they affect the next task; this surface only contains app-wide choices.
 *
 * Model override and sign-in are per-backend: we only ever show the selected
 * backend's, so a Claude model id can't be handed to Codex or vice versa.
 */
export default function SettingsPopover() {
  const settings = useSettingsStore((s) => s.settings);
  const saveError = useSettingsStore((s) => s.error);
  const update = useSettingsStore((s) => s.update);
  const setOpen = useUiStore((s) => s.setSettingsOpen);
  const setRepairing = useUiStore((s) => s.setRepairing);
  const showToast = useToastStore((s) => s.show);
  const ref = useRef<HTMLDivElement>(null);
  const chatRunning = useChatStore((s) => s.running);
  const queuedTaskCount = useChatStore((s) => s.queuedTasks.length);
  const loopRunning = useLoopStore((s) => isLoopActive(s.state?.status));
  const taskActive = chatRunning || queuedTaskCount > 0 || loopRunning;

  const backend: AgentBackend = settings?.agentBackend ?? "claude";
  const cli = useCliSetup(backend);
  const progress = useOnboardingProgress("install_cli");
  const [codexSignedIn, setCodexSignedIn] = useState<boolean | null>(null);
  const [switchingBackend, setSwitchingBackend] = useState(false);

  useEffect(() => {
    let alive = true;
    setCodexSignedIn(null);
    if (backend === "codex" && cli.status?.found && !cli.error) {
      void api
        .codexAuthStatus()
        .then((s) => alive && setCodexSignedIn(s.loggedIn))
        .catch(() => alive && setCodexSignedIn(null));
    }

    return () => {
      alive = false;
    };
  }, [backend, cli.error, cli.status?.found, cli.status?.version]);

  async function switchBackend(next: AgentBackend) {
    if (next === backend || taskActive || cli.installing || switchingBackend) {
      return;
    }
    setSwitchingBackend(true);
    try {
      await update({ agentBackend: next });
      const saved = useSettingsStore.getState();
      if (saved.error || saved.settings?.agentBackend !== next) return;

      // A provider session cannot be resumed by another provider. Preserve the
      // old conversation in history, then clear its frozen run options so the
      // very next message actually uses the newly selected agent.
      const project = useChatStore.getState().project;
      const hadConversation = useChatStore.getState().messages.length > 0;
      if (project) await useSessionsStore.getState().newChat(project);

      showToast(
        hadConversation
          ? `${BACKENDS[next].label} selected. The previous chat was saved.`
          : `${BACKENDS[next].label} selected.`,
      );
    } finally {
      setSwitchingBackend(false);
    }
  }

  async function installCli() {
    if (taskActive) return;
    progress.reset();
    await cli.install();
  }

  async function repair() {
    if (taskActive) return;
    // Keep the working token until the replacement is verified and promoted.
    await usePairingStore.getState().cancel();
    setOpen(false);
    setRepairing(true);
  }

  // Codex sign-in lives on its own full-screen surface (App routes `repairing`
  // by backend), so the popover just hands off.
  function signInToCodex() {
    if (taskActive) return;
    setOpen(false);
    setRepairing(true);
  }

  function close() {
    setOpen(false);
    requestAnimationFrame(() =>
      document.getElementById("settings-trigger")?.focus(),
    );
  }

  // The backdrop owns pointer dismissal. Keeping one explicit Escape listener
  // avoids a document-wide hit-test trap competing with controls in the dialog.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        close();
        return;
      }
      if (e.key !== "Tab" || !ref.current) return;
      const focusable = Array.from(
        ref.current.querySelectorAll<HTMLElement>(
          'button:not(:disabled), select:not(:disabled), input:not(:disabled), summary, [tabindex]:not([tabindex="-1"])',
        ),
      );
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (
        e.shiftKey &&
        (document.activeElement === first || document.activeElement === ref.current)
      ) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }
    requestAnimationFrame(() => ref.current?.focus());
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
    };
  }, [setOpen]);

  if (!settings) return null;

  const meta = BACKENDS[backend];

  return (
    <div
      ref={ref}
      id="settings-popover"
      role="dialog"
      aria-modal="true"
      aria-label="Settings"
      tabIndex={-1}
      className="settings-surface fixed right-4 top-14 z-[90] max-h-[calc(100vh-4.5rem)] w-[22rem] max-w-[calc(100vw-2rem)] animate-appear overflow-y-auto rounded-2xl border p-5 focus:outline-none"
    >
      <div className="flex items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold text-fg">Settings</h2>
          <p className="mt-0.5 text-xs text-fg-dim">
            Choose the agent for new chats.
          </p>
        </div>
        <button
          onClick={close}
          aria-label="Close settings"
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-white/10 bg-white/[0.04] text-xl leading-none text-fg-muted hover:bg-white/[0.08] hover:text-fg"
        >
          ×
        </button>
      </div>

      <div className="mt-5 text-[11px] font-semibold uppercase tracking-[0.16em] text-fg-dim">
        Agent
      </div>
      <div className="mt-2">
        <BackendPicker
          value={backend}
          onChange={(b) => void switchBackend(b)}
          disabled={cli.installing || taskActive || switchingBackend}
        />
      </div>
      <div
        role="status"
        aria-live="polite"
        className="mt-2 flex items-center gap-2 text-xs text-fg-dim"
      >
        <span
          aria-hidden
          className={`h-1.5 w-1.5 rounded-full ${
            switchingBackend ? "animate-dot-pulse bg-warning" : "bg-success"
          }`}
        />
        {switchingBackend ? "Switching agent…" : `${meta.label} selected`}
      </div>
      <p className="mt-2 text-xs leading-relaxed text-fg-dim">{meta.blurb}</p>
      {taskActive && (
        <p className="mt-2 rounded-lg border border-warning/20 bg-warning/5 px-2.5 py-2 text-xs leading-relaxed text-fg-muted">
          {queuedTaskCount > 0
            ? "Finish or clear the task queue before changing agents or setup."
            : "Stop the current task before changing agents, installing a CLI, or reconnecting an account."}
        </p>
      )}

      {saveError && (
        <div
          role="alert"
          className="mt-3 rounded-lg border border-danger/30 bg-danger/5 p-3"
        >
          <p className="text-xs leading-relaxed text-danger">
            Settings could not be saved. The visible changes are temporary.
          </p>
          <pre className="selectable mt-1 whitespace-pre-wrap break-words font-sans text-[11px] text-fg-muted">
            {saveError}
          </pre>
          <button
            onClick={() => void update({})}
            className="mt-2 rounded-md border border-danger/30 px-2.5 py-1.5 text-xs font-medium text-fg transition-colors hover:border-danger/60"
          >
            Retry save
          </button>
        </div>
      )}

      {!cli.checking && (!cli.status?.found || cli.error) && (
        <div className="mt-4 rounded-lg border border-warning/30 bg-warning/5 p-3">
          <p className="text-xs leading-relaxed text-fg-muted">
            The <span className="font-mono text-fg">{meta.cli}</span> helper is
            not ready.
          </p>
          {cli.error && (
            <pre className="selectable mt-2 whitespace-pre-wrap break-words font-sans text-[11px] leading-relaxed text-warning">
              {cli.error}
            </pre>
          )}
          <div className="mt-3 grid grid-cols-2 gap-2">
            <button
              onClick={() => void installCli()}
              disabled={cli.installing || taskActive}
              className="rounded-md bg-accent px-2.5 py-2 text-xs font-medium text-white transition-colors hover:bg-accent-hover disabled:opacity-50"
            >
              {cli.installing ? "Installing…" : "Install CLI"}
            </button>
            <button
              onClick={() => void cli.check()}
              disabled={cli.installing}
              className="rounded-md border border-ink-700 px-2.5 py-2 text-xs font-medium text-fg-muted transition-colors hover:border-ink-600 hover:text-fg disabled:opacity-50"
            >
              Check again
            </button>
          </div>
          {progress.lines.length > 0 && (
            <pre className="selectable mt-3 max-h-28 overflow-auto whitespace-pre-wrap rounded-md bg-ink-950 p-2 text-[10px] leading-relaxed text-fg-dim">
              {progress.lines.join("\n")}
            </pre>
          )}
        </div>
      )}

      <div className="mt-5 flex items-center justify-between gap-3 rounded-xl border border-white/[0.08] bg-white/[0.025] p-3.5">
        <span className="min-w-0">
          <span className="block text-sm text-fg">
            {backend === "codex" ? "ChatGPT account" : "Company account"}
          </span>
          <span className="block truncate text-xs text-fg-dim">
            {backend === "codex"
              ? codexSignedIn === null
                ? "Checking…"
                : codexSignedIn
                  ? "Signed in"
                  : "Not signed in"
              : settings.pairedOk
                ? "Connected"
                : "Not connected"}
          </span>
        </span>
        {backend === "codex" ? (
          <button
            onClick={signInToCodex}
            disabled={
              !cli.status?.found || !!cli.error || cli.installing || taskActive
            }
            className="shrink-0 rounded-md bg-ink-700 px-2.5 py-1.5 text-xs font-medium text-fg transition-colors hover:bg-ink-600 disabled:opacity-50"
          >
            {codexSignedIn ? "Re-sign in" : "Sign in"}
          </button>
        ) : (
          <button
            onClick={() => void repair()}
            disabled={
              !cli.status?.found || !!cli.error || cli.installing || taskActive
            }
            className="shrink-0 rounded-md bg-ink-700 px-2.5 py-1.5 text-xs font-medium text-fg transition-colors hover:bg-ink-600 disabled:opacity-50"
          >
            Re-pair
          </button>
        )}
      </div>

      <div className="mt-5 text-[11px] font-semibold uppercase tracking-[0.16em] text-fg-dim">
        Appearance
      </div>
      <div className="mt-2">
        <ThemePicker
          value={settings.theme}
          onChange={(theme) => void update({ theme })}
        />
      </div>

      <details className="mt-4 border-t border-white/[0.08] pt-3">
        <summary className="cursor-pointer text-xs font-medium text-fg-muted transition-colors hover:text-fg">
          Advanced
        </summary>
        <div className="mt-2 rounded-xl border border-white/[0.07] bg-black/10 px-3.5 pb-3.5">
          <Toggle
            label="Debug drawer"
            hint="Show raw events for troubleshooting."
            checked={settings.debugDrawer}
            onChange={(v) => void update({ debugDrawer: v })}
          />
          <div className="mt-4 flex items-center justify-between gap-3 border-t border-white/[0.07] pt-3.5">
            <span>
              <span className="block text-sm text-fg">Repair setup</span>
              <span className="block text-xs text-fg-dim">
                Recheck the agent, project, and Unity.
              </span>
            </span>
            <button
              onClick={() => {
                void update({ onboarded: false });
                setOpen(false);
              }}
              disabled={cli.installing || taskActive}
              className="shrink-0 rounded-md bg-ink-700 px-2.5 py-1.5 text-xs font-medium text-fg transition-colors hover:bg-ink-600 disabled:cursor-not-allowed disabled:opacity-50"
            >
              Repair
            </button>
          </div>
        </div>
      </details>
    </div>
  );
}

function Toggle({
  label,
  hint,
  checked,
  onChange,
}: {
  label: string;
  hint: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <button
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      className="mt-3 flex w-full items-start justify-between gap-3 text-left"
    >
      <span>
        <span className="block text-sm text-fg">{label}</span>
        <span className="block text-xs text-fg-dim">{hint}</span>
      </span>
      <span
        className={`mt-0.5 h-5 w-9 shrink-0 rounded-full p-0.5 transition-colors duration-150 ${
          checked ? "bg-accent" : "bg-ink-700"
        }`}
      >
        <span
          className={`block h-4 w-4 rounded-full transition-transform duration-150 ${
            checked ? "translate-x-4 bg-ink-950" : "translate-x-0 bg-fg-dim"
          }`}
        />
      </span>
    </button>
  );
}
