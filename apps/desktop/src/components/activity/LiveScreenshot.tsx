import { convertFileSrc } from "@tauri-apps/api/core";
import { useLiveScreenshot } from "@/hooks/useLiveScreenshot";
import { RefreshIcon } from "@/components/shell/icons";
import type { BridgeState } from "@/types/status";

/** Latest Unity Game, Scene, or selected-object view. */
export default function LiveScreenshot({
  project,
  bridgeState,
}: {
  project: string | null;
  bridgeState: BridgeState;
}) {
  const connected = bridgeState === "connected";
  const { kind, pngPath, version, loading, error, selectKind, capture } =
    useLiveScreenshot(project, connected);
  const viewLabel = viewName(kind);
  // Cache-bust so the webview reloads the overwritten file each capture.
  const src = pngPath ? `${convertFileSrc(pngPath)}?v=${version}` : null;

  return (
    <div className="border-b border-white/5 p-3">
      <div className="mb-2 flex items-center justify-between gap-2">
        <span className="text-xs font-medium uppercase tracking-wide text-fg-dim">
          Unity view
        </span>
        <div className="flex items-center gap-1.5">
          <div
            role="group"
            aria-label="Screenshot view"
            className="flex rounded-md border border-white/10 bg-black/20 p-0.5"
          >
            {(["game", "scene", "selected"] as const).map((option) => (
              <button
                key={option}
                type="button"
                onClick={() => selectKind(option)}
                disabled={loading}
                aria-pressed={kind === option}
                className={`min-h-6 rounded px-2 py-0.5 text-[10px] font-medium transition-colors disabled:opacity-50 ${
                  kind === option
                    ? "bg-white/10 text-fg"
                    : "text-fg-dim hover:text-fg-muted"
                }`}
              >
                {viewName(option)}
              </button>
            ))}
          </div>
          <button
            type="button"
            onClick={() => void capture()}
            disabled={!connected || loading}
            title={`Refresh ${viewLabel} view`}
            aria-label={`Refresh ${viewLabel} view screenshot`}
            className="flex min-h-6 min-w-6 items-center justify-center rounded-md p-1 text-fg-dim transition-colors duration-150 hover:bg-ink-800 hover:text-fg-muted disabled:opacity-40"
          >
            <RefreshIcon className={loading ? "animate-spin" : ""} />
          </button>
        </div>
      </div>

      <div className="relative aspect-video overflow-hidden rounded-lg border border-white/5 bg-ink-950">
        {src ? (
          <img
            src={src}
            alt={`Live ${viewLabel} view`}
            className="h-full w-full animate-appear object-contain"
          />
        ) : (
          <Placeholder bridgeState={bridgeState} error={error} view={viewLabel} />
        )}
        {src && error && (
          <div
            role="alert"
            className="absolute inset-x-2 bottom-2 line-clamp-2 rounded-md border border-danger/20 bg-white/95 px-2 py-1.5 text-[9px] leading-relaxed text-danger shadow-sm"
          >
            {error}
          </div>
        )}
      </div>
    </div>
  );
}

function Placeholder({
  bridgeState,
  error,
  view,
}: {
  bridgeState: BridgeState;
  error: string | null;
  view: "Game" | "Scene" | "Selected";
}) {
  const text = error
    ? error
    : bridgeState === "connected"
      ? `Press refresh to see the ${view} view.`
      : bridgeState === "reloading"
        ? "Unity is reloading scripts. Capture will resume when it reconnects."
        : bridgeState === "identity_mismatch"
          ? "A different Unity project is open. Open this project to capture it."
          : `Open Unity to see the ${view} view here.`;
  return (
    <div className="flex h-full items-center justify-center px-4 text-center text-xs text-fg-dim">
      {text}
    </div>
  );
}

function viewName(kind: "game" | "scene" | "selected") {
  if (kind === "game") return "Game";
  return kind === "scene" ? "Scene" : "Selected";
}
