import { useEffect, useMemo, useRef } from "react";
import { useChatStore } from "@/stores/useChatStore";
import type { ChatMessage, ToolActivity } from "@/types/chat";

/** A turn's worth of activity: the prompt that triggered it + its tool calls. */
interface TurnGroup {
  id: string;
  prompt: string;
  activities: ToolActivity[];
}

/**
 * Chronological feed of tool activity, grouped per assistant turn. Auto-scrolls
 * to the newest entry unless the user has scrolled up to read history.
 */
export default function ToolTimeline() {
  const messages = useChatStore((s) => s.messages);
  const scrollRef = useRef<HTMLDivElement>(null);
  const pinnedRef = useRef(true);

  const groups = useMemo(() => buildGroups(messages), [messages]);
  const activityCount = groups.reduce((n, g) => n + g.activities.length, 0);

  // Track whether the user is pinned to the bottom.
  function onScroll() {
    const el = scrollRef.current;
    if (!el) return;
    pinnedRef.current =
      el.scrollHeight - el.scrollTop - el.clientHeight < 40;
  }

  useEffect(() => {
    const el = scrollRef.current;
    if (el && pinnedRef.current) el.scrollTop = el.scrollHeight;
  }, [activityCount, groups.length]);

  return (
    <div className="flex h-full flex-col">
      <div className="px-3 py-2 text-xs font-medium uppercase tracking-wide text-fg-dim">
        Activity
      </div>
      <div
        ref={scrollRef}
        onScroll={onScroll}
        className="min-h-0 flex-1 overflow-y-auto px-3 pb-3"
      >
        {activityCount === 0 ? (
          <div className="px-1 py-6 text-center text-xs text-fg-dim">
            Steps the AI takes in Unity will show up here.
          </div>
        ) : (
          <div className="space-y-4">
            {groups.map((g) => (
              <TurnBlock key={g.id} group={g} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function TurnBlock({ group }: { group: TurnGroup }) {
  if (group.activities.length === 0) return null;
  return (
    <div className="animate-appear">
      {group.prompt && (
        <div className="mb-1.5 truncate text-[11px] text-fg-dim" title={group.prompt}>
          {group.prompt}
        </div>
      )}
      <ol className="space-y-0.5 border-l border-white/5 pl-3">
        {group.activities.map((a) => (
          <TimelineRow key={a.id} activity={a} />
        ))}
      </ol>
    </div>
  );
}

function TimelineRow({ activity }: { activity: ToolActivity }) {
  return (
    <li className="flex items-center gap-2 py-0.5 text-xs">
      <StatusDot status={activity.status} />
      <span className="min-w-0 flex-1 truncate text-fg-muted" title={activity.name}>
        {activity.friendlyLabel}
      </span>
      <span className="shrink-0 tabular-nums text-[10px] text-fg-dim">
        {formatDuration(activity)}
      </span>
    </li>
  );
}

function StatusDot({ status }: { status: ToolActivity["status"] }) {
  const cls =
    status === "running"
      ? "bg-accent animate-dot-pulse"
      : status === "ok"
        ? "bg-success"
        : "bg-danger";
  return <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${cls}`} />;
}

/** Human duration for a finished activity; empty while still running. */
function formatDuration(a: ToolActivity): string {
  if (a.status === "running" || !a.endedAt) return "";
  const ms = a.endedAt - a.startedAt;
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

/** Pair each assistant turn with the user prompt immediately before it. */
function buildGroups(messages: ChatMessage[]): TurnGroup[] {
  const groups: TurnGroup[] = [];
  let lastPrompt = "";
  for (const m of messages) {
    if (m.role === "user") {
      lastPrompt = m.text;
      continue;
    }
    if (m.activities.length > 0) {
      groups.push({ id: m.id, prompt: lastPrompt, activities: m.activities });
    }
  }
  return groups;
}
