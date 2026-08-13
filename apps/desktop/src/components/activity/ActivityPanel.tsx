import { useState } from "react";
import { useChatStore } from "@/stores/useChatStore";
import { useStatusStore } from "@/stores/useStatusStore";
import ToolTimeline from "./ToolTimeline";
import LiveScreenshot from "./LiveScreenshot";
import UnityChecks from "./UnityChecks";

/**
 * Right-hand Unity workspace: live captures above checks and agent activity.
 * Collapsed via the TopBar toggle (this component isn't rendered when closed).
 */
export default function ActivityPanel() {
  const project = useChatStore((s) => s.project);
  const bridgeState = useStatusStore((s) => s.status.state);
  const [tab, setTab] = useState<"checks" | "activity">("checks");

  return (
    <aside className="activity-panel glass-panel m-3 ml-0 flex w-80 shrink-0 flex-col overflow-hidden rounded-xl border">
      <LiveScreenshot project={project} bridgeState={bridgeState} />
      <div
        role="tablist"
        aria-label="Unity workspace"
        className="grid shrink-0 grid-cols-2 gap-1 border-b border-ink-700 bg-ink-850 p-1.5"
        onKeyDown={(event) => {
          if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
          event.preventDefault();
          const next = tab === "checks" ? "activity" : "checks";
          setTab(next);
          requestAnimationFrame(() => {
            document.getElementById(`activity-tab-${next}`)?.focus();
          });
        }}
      >
        {(["checks", "activity"] as const).map((item) => (
          <button
            key={item}
            id={`activity-tab-${item}`}
            type="button"
            role="tab"
            aria-selected={tab === item}
            aria-controls={`activity-panel-${item}`}
            tabIndex={tab === item ? 0 : -1}
            onClick={() => setTab(item)}
            className={`rounded-md px-3 py-1.5 text-[11px] font-medium capitalize transition-colors ${
              tab === item
                ? "bg-white text-fg shadow-sm"
                : "text-fg-dim hover:bg-ink-800 hover:text-fg"
            }`}
          >
            {item}
          </button>
        ))}
      </div>
      <div
        id={`activity-panel-${tab}`}
        role="tabpanel"
        aria-labelledby={`activity-tab-${tab}`}
        className="min-h-0 flex-1"
      >
        {tab === "checks" ? (
          <UnityChecks project={project} bridgeState={bridgeState} active />
        ) : (
          <ToolTimeline />
        )}
      </div>
    </aside>
  );
}
