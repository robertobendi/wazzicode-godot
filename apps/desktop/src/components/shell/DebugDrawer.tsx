import { useEffect, useMemo, useRef, useState } from "react";
import { useDebugStore, type DebugEntry } from "@/stores/useDebugStore";
import { useUiStore } from "@/stores/useUiStore";
import { ChevronIcon } from "./icons";

/**
 * Collapsible admin log at the bottom of the shell. Only rendered when
 * settings.debugDrawer is on.
 *
 * Each row is a one-line summary (`unity_verify`, `shell exit 1`,
 * `turn.failed`) rather than a raw JSON blob — `summarizeEvent` normalizes both
 * agent backends into the same shape, so this reads identically on Claude and
 * Codex. Click a row for the full event. The filter box and Errors-only toggle
 * exist because the thing you're almost always hunting is one failed Unity tool
 * call buried in a few hundred token deltas.
 */
export default function DebugDrawer() {
  const entries = useDebugStore((s) => s.entries);
  const clear = useDebugStore((s) => s.clear);
  const { debugOpen, toggleDebug } = useUiStore();
  const [copied, setCopied] = useState(false);
  const [filter, setFilter] = useState("");
  const [errorsOnly, setErrorsOnly] = useState(false);
  const [expanded, setExpanded] = useState<number | null>(null);
  const logRef = useRef<HTMLDivElement>(null);

  const shown = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return entries.filter((e) => {
      if (errorsOnly && e.level !== "error") return false;
      if (!q) return true;
      return (
        e.label.toLowerCase().includes(q) ||
        (e.detail?.toLowerCase().includes(q) ?? false) ||
        e.kind.toLowerCase().includes(q)
      );
    });
  }, [entries, filter, errorsOnly]);

  const errorCount = useMemo(
    () => entries.filter((e) => e.level === "error").length,
    [entries],
  );

  // Follow the tail while open — unless the user is reading an expanded row.
  useEffect(() => {
    if (debugOpen && expanded === null && logRef.current) {
      logRef.current.scrollTop = logRef.current.scrollHeight;
    }
  }, [shown, debugOpen, expanded]);

  async function copyAll() {
    // Copy what's on screen (filtered), with the raw event — that's what gets
    // pasted into a bug report.
    const text = shown
      .map(
        (e) =>
          `${new Date(e.t).toISOString()} [${e.kind}] ${e.label}` +
          `${e.detail ? ` — ${e.detail}` : ""}\n${e.raw}`,
      )
      .join("\n\n");
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch {
      // Clipboard can be unavailable; silently ignore.
    }
  }

  return (
    <div className="glass-panel mx-3 mb-2 shrink-0 overflow-hidden rounded-2xl border">
      <div className="flex h-8 items-center justify-between px-3 text-xs text-fg-dim">
        <button
          onClick={toggleDebug}
          className="flex items-center gap-1.5 rounded px-1 py-0.5 transition-colors duration-150 hover:text-fg-muted"
        >
          <ChevronIcon
            className={`transition-transform duration-150 ${
              debugOpen ? "" : "-rotate-90"
            }`}
          />
          <span>Debug log</span>
          <span className="text-fg-dim">({entries.length})</span>
          {errorCount > 0 && (
            <span className="rounded-full bg-danger/15 px-1.5 py-0.5 text-[10px] font-medium text-danger">
              {errorCount}
            </span>
          )}
        </button>
        {debugOpen && (
          <div className="flex items-center gap-1">
            <input
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="Filter…"
              spellCheck={false}
              className="selectable mr-1 w-32 rounded border border-ink-700 bg-ink-950 px-1.5 py-0.5 text-[11px] text-fg placeholder:text-fg-dim focus:border-ink-600 focus:outline-none"
            />
            <button
              onClick={() => setErrorsOnly((v) => !v)}
              className={`rounded px-1.5 py-0.5 transition-colors duration-150 hover:bg-ink-800 ${
                errorsOnly ? "bg-danger/15 text-danger" : "hover:text-fg-muted"
              }`}
            >
              Errors
            </button>
            <button
              onClick={copyAll}
              className="rounded px-1.5 py-0.5 transition-colors duration-150 hover:bg-ink-800 hover:text-fg-muted"
            >
              {copied ? "Copied" : "Copy"}
            </button>
            <button
              onClick={clear}
              className="rounded px-1.5 py-0.5 transition-colors duration-150 hover:bg-ink-800 hover:text-fg-muted"
            >
              Clear
            </button>
          </div>
        )}
      </div>

      {debugOpen && (
        <div
          ref={logRef}
          className="selectable h-48 overflow-y-auto border-t border-white/5 bg-ink-950 px-3 py-2 font-mono text-[11px] leading-relaxed text-fg-muted"
        >
          {shown.length === 0 ? (
            <div className="text-fg-dim">
              {entries.length === 0 ? "No events yet." : "Nothing matches."}
            </div>
          ) : (
            shown.map((e) => (
              <Row
                key={e.id}
                entry={e}
                open={expanded === e.id}
                onToggle={() =>
                  setExpanded((cur) => (cur === e.id ? null : e.id))
                }
              />
            ))
          )}
        </div>
      )}
    </div>
  );
}

function Row({
  entry,
  open,
  onToggle,
}: {
  entry: DebugEntry;
  open: boolean;
  onToggle: () => void;
}) {
  return (
    <div>
      <button
        onClick={onToggle}
        className="flex w-full items-baseline gap-1.5 rounded px-1 text-left transition-colors hover:bg-ink-900"
      >
        <span className="shrink-0 text-fg-dim">
          {new Date(entry.t).toLocaleTimeString()}
        </span>
        <span className={`shrink-0 font-medium ${levelClass(entry.level)}`}>
          {entry.label}
        </span>
        {entry.detail && (
          <span className="min-w-0 flex-1 truncate text-fg-dim">
            {entry.detail}
          </span>
        )}
      </button>
      {open && (
        <pre className="mx-1 mb-1 mt-0.5 max-h-56 overflow-auto whitespace-pre-wrap break-all rounded border border-white/5 bg-ink-900 p-2 text-[10px] text-fg-muted">
          {entry.raw}
        </pre>
      )}
    </div>
  );
}

function levelClass(level: DebugEntry["level"]): string {
  switch (level) {
    case "error":
      return "text-danger";
    case "tool":
      return "text-accent/90";
    case "text":
      return "text-fg-muted";
    default:
      return "text-fg-dim";
  }
}
