import { useState } from "react";
import { api, pickFolder } from "@/api";
import { useSettingsStore } from "@/stores/useSettingsStore";
import { useOnboardingProgress } from "@/hooks/useOnboarding";
import Logo from "@/components/shell/Logo";
import type { ProjectInfo } from "@/types/project";

/**
 * First-run / project-switch screen: pick a folder, validate it's a Unity
 * project, and open it. Also lists recent projects for one-click reopening.
 */
interface ProjectPickerProps {
  initialCandidate?: ProjectInfo | null;
  initialError?: string | null;
  onOpened?: (info: ProjectInfo) => void;
}

export default function ProjectPicker({
  initialCandidate = null,
  initialError = null,
  onOpened,
}: ProjectPickerProps = {}) {
  const { settings, setSettings } = useSettingsStore();
  const [checking, setChecking] = useState(false);
  const [preparing, setPreparing] = useState(false);
  const [candidate, setCandidate] = useState<ProjectInfo | null>(
    initialCandidate?.ok ? initialCandidate : null,
  );
  const [error, setError] = useState<string | null>(initialError);
  const { lines: setupLines, reset: resetSetupProgress } =
    useOnboardingProgress();

  const recents = settings?.recentProjects ?? [];

  async function inspect(path: string) {
    setError(null);
    setChecking(true);
    try {
      const info = await api.validateUnityProject(path);
      if (!info.ok) {
        setCandidate(null);
        setError(
          `That folder doesn't look like a Unity project (missing ${
            info.hasAssets ? "" : "Assets/ "
          }${info.hasProjectSettings ? "" : "ProjectSettings/"}).`.trim(),
        );
      } else {
        setCandidate(info);
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setChecking(false);
    }
  }

  async function browse() {
    const path = await pickFolder();
    if (path) await inspect(path);
  }

  async function openPrepared(info: ProjectInfo) {
    // Returns the canonical settings (current project + updated recents); adopt
    // it directly so we don't clobber the recents with a stale re-save.
    setError(null);
    try {
      const saved = await api.setCurrentProject(info.path);
      setSettings(saved);
      onOpened?.(info);
    } catch (e) {
      setError(String(e));
    }
  }

  async function prepareAndOpen(info: ProjectInfo) {
    setError(null);
    setPreparing(true);
    resetSetupProgress();
    try {
      const result = await api.onboardingSetupProject(info.path);
      const failed = result.steps.filter((step) => !step.ok);
      if (failed.length > 0) {
        setError(
          `Project preparation stopped: ${failed
            .map((step) => `${step.id}: ${step.detail}`)
            .join(" · ")}`,
        );
        return;
      }
      const refreshed = await api.validateUnityProject(info.path);
      setCandidate(refreshed);
      if (!refreshed.brainReady) {
        setError(
          "The project scan finished without creating its knowledge manifest. Try preparing it again.",
        );
        return;
      }
      await openPrepared(refreshed);
    } catch (e) {
      setError(String(e));
    } finally {
      setPreparing(false);
    }
  }

  async function openCandidate(info: ProjectInfo) {
    if (info.brainReady) await openPrepared(info);
    else await prepareAndOpen(info);
  }

  async function openRecent(path: string) {
    setError(null);
    setChecking(true);
    try {
      const info = await api.validateUnityProject(path);
      if (!info.ok || !info.brainReady) {
        setCandidate(info.ok ? info : null);
        if (!info.ok) {
          setError("That recent folder is no longer a valid Unity project.");
        }
        return;
      }
      await openPrepared(info);
    } catch (e) {
      setError(String(e));
    } finally {
      setChecking(false);
    }
  }

  return (
    <div className="flex h-full w-full items-center justify-center bg-ink-950 px-8">
      <div className="w-full max-w-md animate-appear">
        <div className="identity-mark">
          <Logo size={26} />
        </div>
        <h1 className="text-2xl font-semibold tracking-tight text-fg">
          Welcome to foundry-unity
        </h1>
        <p className="mt-2 text-sm text-fg-muted">
          Open the folder that holds your game — the one with{" "}
          <code className="text-fg-dim">Assets</code> and{" "}
          <code className="text-fg-dim">ProjectSettings</code>.
        </p>

        <button
          onClick={browse}
          disabled={checking || preparing}
          className="mt-5 w-full rounded-lg bg-accent px-4 py-2.5 text-sm font-medium text-white transition-colors hover:bg-accent-hover disabled:opacity-60"
        >
          {checking ? "Checking…" : "Choose folder…"}
        </button>

        {error && <p className="mt-3 text-xs text-danger">{error}</p>}

        {candidate && (
          <div className="mt-4 animate-appear rounded-xl border border-white/10 bg-ink-900 p-4">
            <div className="text-sm font-medium text-fg">{candidate.name}</div>
            <div className="mt-0.5 truncate text-xs text-fg-dim">
              {candidate.path}
            </div>
            <div className="mt-2 flex flex-wrap gap-2 text-[11px]">
              <Tag>
                Unity {candidate.unityVersion ?? "version unknown"}
              </Tag>
              <Tag ok={candidate.uvibeInitialized}>
                {candidate.uvibeInitialized
                  ? `Vibe OS ready${
                      candidate.safetyMode ? ` · ${candidate.safetyMode}` : ""
                    }`
                  : "Vibe OS not set up"}
              </Tag>
              <Tag ok={candidate.brainReady}>
                {candidate.brainReady
                  ? "Project map ready"
                  : "Project map not built"}
              </Tag>
            </div>
            {!candidate.brainReady && (
              <p className="mt-3 text-xs leading-relaxed text-fg-muted">
                foundry-unity will scan the project once and build its
                searchable map before opening it.
              </p>
            )}
            {preparing && setupLines.length > 0 && (
              <div className="mt-3 truncate rounded-md border border-white/5 bg-black/20 px-2.5 py-2 font-mono text-[11px] text-fg-dim">
                {setupLines[setupLines.length - 1]}
              </div>
            )}
            <button
              onClick={() => void openCandidate(candidate)}
              disabled={checking || preparing}
              className="mt-3 w-full rounded-md bg-ink-700 px-3 py-2 text-sm font-medium text-fg transition-colors hover:bg-ink-600"
            >
              {preparing
                ? "Preparing project…"
                : candidate.brainReady
                  ? "Open project"
                  : "Prepare and open"}
            </button>
          </div>
        )}

        {recents.length > 0 && (
          <div className="mt-8">
            <div className="mb-2 text-xs font-medium uppercase tracking-wide text-fg-dim">
              Recent
            </div>
            <ul className="space-y-1">
              {recents.map((p) => (
                <li key={p}>
                  <button
                    onClick={() => void openRecent(p)}
                    disabled={checking || preparing}
                    className="w-full truncate rounded-md px-3 py-2 text-left text-sm text-fg-muted transition-colors hover:bg-ink-800 hover:text-fg"
                    title={p}
                  >
                    {p.split(/[\\/]/).pop() || p}
                    <span className="ml-2 text-xs text-fg-dim">{p}</span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </div>
  );
}

function Tag({ children, ok }: { children: React.ReactNode; ok?: boolean }) {
  const tone =
    ok === undefined
      ? "border-ink-700 text-fg-muted"
      : ok
        ? "border-success/40 text-success"
        : "border-warning/40 text-warning";
  return (
    <span className={`rounded-full border px-2 py-0.5 ${tone}`}>{children}</span>
  );
}
