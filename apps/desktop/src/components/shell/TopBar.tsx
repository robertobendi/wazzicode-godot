import { useSettingsStore } from "@/stores/useSettingsStore";
import { useChatStore } from "@/stores/useChatStore";
import { useUiStore, type AppMode } from "@/stores/useUiStore";
import { useLoopStore } from "@/stores/useLoopStore";
import { useStatusStore } from "@/stores/useStatusStore";
import { isLoopActive } from "@/types/loop";
import type { BridgeState } from "@/types/status";
import { formatTokens } from "@/lib/formatTokens";
import { useCliInstallActive } from "@/hooks/useOnboarding";
import { createPortal } from "react-dom";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { GearIcon, MapIcon, PanelIcon, SidebarIcon } from "./icons";
import Logo from "./Logo";
import RevertControl from "./RevertControl";
import SettingsPopover from "./SettingsPopover";

const INTERACTIVE =
  "button, input, select, textarea, a, [role='button'], [role='switch'], .no-drag";

/**
 * The header doubles as the title bar (titleBarStyle "Overlay"), so dragging
 * it moves the window. CSS `-webkit-app-region: drag` is unreliable in
 * WKWebView under Overlay; startDragging() is not.
 */
function startWindowDrag(e: React.MouseEvent<HTMLElement>) {
  if (e.button !== 0) return;
  if ((e.target as HTMLElement | null)?.closest(INTERACTIVE)) return;
  void getCurrentWindow().startDragging();
}

/** Double-clicking the title bar zooms the window — native behaviour that the
 *  JS drag above would otherwise swallow. */
function toggleWindowZoom(e: React.MouseEvent<HTMLElement>) {
  if ((e.target as HTMLElement | null)?.closest(INTERACTIVE)) return;
  void getCurrentWindow().toggleMaximize();
}

/** Slim app header: project name, Chat/Auto toggle, activity-panel, settings. */
export default function TopBar() {
  const project = useChatStore((s) => s.project);
  const update = useSettingsStore((s) => s.update);
  const chatRunning = useChatStore((s) => s.running);
  const queuedTaskCount = useChatStore((s) => s.queuedTasks.length);
  const totalCost = useChatStore((s) => s.session.totalCostUsd);
  const totalTokens = useChatStore((s) => s.session.totalTokens);
  const loopRunning = useLoopStore((s) => isLoopActive(s.state?.status));
  const bridge = useStatusStore((s) => s.status);
  const cliInstalling = useCliInstallActive();
  const taskActive = chatRunning || loopRunning;
  const navigationLocked = taskActive || queuedTaskCount > 0 || cliInstalling;
  const {
    activityOpen,
    toggleActivity,
    sessionRailOpen,
    toggleSessionRail,
    settingsOpen,
    setSettingsOpen,
    projectMapOpen,
    setProjectMapOpen,
    mode,
    setMode,
  } = useUiStore();
  const name = project ? project.split(/[\\/]/).pop() || project : "";
  const bridgeLabel = bridge.compiling
    ? "Compiling"
    : bridge.playMode
      ? "Playing"
      : bridge.friendly;
  const usageLabel =
    totalCost > 0
      ? `$${totalCost.toFixed(3)}`
      : totalTokens > 0
        ? formatTokens(totalTokens)
        : null;
  const statusLabel = `Unity: ${bridgeLabel}${usageLabel ? `. Session usage: ${usageLabel}` : ""}`;

  return (
    <header
      className="app-topbar drag-region relative z-30 grid h-12 shrink-0 grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center border-b pl-[4.75rem] pr-3"
      onMouseDown={startWindowDrag}
      onDoubleClick={toggleWindowZoom}
    >
      <div className="flex min-w-0 items-center gap-2 overflow-hidden">
        {mode === "chat" && (
          <IconButton
            label={sessionRailOpen ? "Hide chats" : "Show chats"}
            active={sessionRailOpen}
            onClick={toggleSessionRail}
          >
            <SidebarIcon />
          </IconButton>
        )}
        <span className="foundry-lockup flex shrink-0 items-center gap-2">
          <Logo />
          <span className="foundry-wordmark text-sm font-semibold tracking-tight text-fg">
            foundry-unity
          </span>
        </span>
        <span aria-hidden className="h-4 w-px shrink-0 bg-ink-700" />
        <span className="truncate text-sm font-medium text-fg-muted">{name}</span>
        <button
          onClick={() => {
            setProjectMapOpen(false);
            void update({ currentProject: null });
          }}
          disabled={navigationLocked}
          title={
            navigationLocked
              ? "Finish or clear pending tasks before switching projects"
              : undefined
          }
          className="rounded-md px-1.5 py-0.5 text-xs text-fg-dim transition-colors duration-150 hover:bg-ink-800 hover:text-fg-muted disabled:cursor-not-allowed disabled:opacity-40"
        >
          Switch
        </button>
      </div>

      <div className="justify-self-center">
        <ModeToggle mode={mode} setMode={setMode} disabled={navigationLocked} />
      </div>

      <div className="flex min-w-0 items-center justify-end gap-1">
        <div
          className="flex min-w-0 items-center gap-1.5 rounded-lg border border-white/[0.07] bg-black/20 px-2 py-1 text-[11px] text-fg-dim"
          role="status"
          aria-label={statusLabel}
          title={statusLabel}
        >
          <span
            aria-hidden
            className={`h-1.5 w-1.5 shrink-0 rounded-full ${bridgeDot(bridge.state)}`}
          />
          <span className="hidden max-w-24 truncate lg:inline">{bridgeLabel}</span>
        </div>
        {usageLabel && (
          <span className="hidden whitespace-nowrap px-1 text-[11px] tabular-nums text-fg-dim xl:inline">
            {usageLabel}
          </span>
        )}
        <RevertControl />
        <IconButton
          id="project-map-trigger"
          label={projectMapOpen ? "Close project map" : "Open project map"}
          active={projectMapOpen}
          expanded={projectMapOpen}
          controls="project-map-drawer"
          onClick={() => {
            setSettingsOpen(false);
            setProjectMapOpen(!projectMapOpen);
          }}
        >
          <MapIcon />
        </IconButton>
        {mode === "chat" && (
          <div className="activity-toggle">
            <IconButton
              label={
                activityOpen
                  ? "Hide Unity checks and activity"
                  : "Show Unity checks and activity"
              }
              active={activityOpen}
              onClick={toggleActivity}
            >
              <PanelIcon />
            </IconButton>
          </div>
        )}
        <IconButton
          id="settings-trigger"
          label="Settings"
          active={settingsOpen}
          expanded={settingsOpen}
          controls="settings-popover"
          onClick={() => {
            setProjectMapOpen(false);
            setSettingsOpen(!settingsOpen);
          }}
        >
          <GearIcon />
        </IconButton>
      </div>

      {settingsOpen &&
        createPortal(
          <>
            <div
              className="settings-backdrop fixed inset-0 z-[80]"
              aria-hidden="true"
              onMouseDown={() => {
                setSettingsOpen(false);
                requestAnimationFrame(() =>
                  document.getElementById("settings-trigger")?.focus(),
                );
              }}
            />
            <SettingsPopover />
          </>,
          document.body,
        )}
    </header>
  );
}

function bridgeDot(state: BridgeState): string {
  switch (state) {
    case "connected":
      return "bg-success";
    case "reloading":
      return "bg-warning animate-dot-pulse";
    case "identity_mismatch":
      return "bg-warning";
    case "disconnected":
    default:
      return "bg-danger";
  }
}

/** Quiet segmented control switching between manual chat and auto mode. */
function ModeToggle({
  mode,
  setMode,
  disabled,
}: {
  mode: AppMode;
  setMode: (m: AppMode) => void;
  disabled: boolean;
}) {
  const options: { value: AppMode; label: string }[] = [
    { value: "chat", label: "Chat" },
    { value: "auto", label: "Auto" },
  ];
  return (
    <div className="mode-toggle flex rounded-lg border border-white/10 bg-black/20 p-0.5 shadow-inner shadow-black/30">
      {options.map((o) => (
        <button
          key={o.value}
          onClick={() => setMode(o.value)}
          disabled={disabled}
          title={
            disabled
              ? "Finish or clear pending tasks before changing modes"
              : undefined
          }
          className={`rounded-md px-3 py-1 text-xs font-medium transition-colors duration-150 disabled:cursor-not-allowed disabled:opacity-50 ${
            mode === o.value
              ? "bg-white/10 text-fg shadow-sm shadow-black/30"
              : "text-fg-dim hover:text-fg-muted"
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

function IconButton({
  children,
  id,
  label,
  active,
  expanded,
  controls,
  onClick,
}: {
  children: React.ReactNode;
  id?: string;
  label: string;
  active?: boolean;
  expanded?: boolean;
  controls?: string;
  onClick: () => void;
}) {
  return (
    <button
      id={id}
      onClick={onClick}
      title={label}
      aria-label={label}
      aria-expanded={expanded}
      aria-controls={controls}
      className={`icon-button rounded-lg p-1.5 transition-colors duration-150 hover:bg-white/5 ${
        active ? "text-fg" : "text-fg-dim hover:text-fg-muted"
      }`}
    >
      {children}
    </button>
  );
}
