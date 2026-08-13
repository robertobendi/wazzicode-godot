import { useState } from "react";
import { useSessionsStore } from "@/stores/useSessionsStore";
import { useChatStore } from "@/stores/useChatStore";
import { useToastStore } from "@/stores/useToastStore";
import { useSettingsStore } from "@/stores/useSettingsStore";
import { relativeTime } from "@/lib/relativeTime";
import { BACKENDS } from "@/types/settings";
import { PlusIcon, TrashIcon } from "../shell/icons";

/** Left rail: past conversations, newest-first, with resume + delete. */
export default function SessionRail() {
  const index = useSessionsStore((s) => s.index);
  const activeId = useSessionsStore((s) => s.activeSessionId);
  const open = useSessionsStore((s) => s.open);
  const remove = useSessionsStore((s) => s.remove);
  const newChat = useSessionsStore((s) => s.newChat);
  const project = useChatStore((s) => s.project);
  const running = useChatStore((s) => s.running);
  const queuedTaskCount = useChatStore((s) => s.queuedTasks.length);
  const showToast = useToastStore((s) => s.show);
  const agentLabel = useSettingsStore(
    (s) => BACKENDS[s.settings?.agentBackend ?? "claude"].label,
  );
  const [confirmId, setConfirmId] = useState<string | null>(null);

  if (!project) return null;
  const proj = project;
  const workPending = running || queuedTaskCount > 0;
  const busyCopy =
    queuedTaskCount > 0
      ? "Finish or clear the task queue before changing chats."
      : `${agentLabel} is still working on the last message.`;

  async function onOpen(id: string) {
    if (workPending) {
      showToast(busyCopy);
      return;
    }
    const ok = await open(proj, id);
    if (!ok) showToast(busyCopy);
  }

  function onNewChat() {
    if (workPending) {
      showToast(busyCopy);
      return;
    }
    void newChat(proj);
  }

  return (
    <aside className="session-rail glass-panel m-3 mr-0 flex w-60 shrink-0 flex-col overflow-hidden rounded-xl border">
      <div className="session-rail__header flex items-center justify-between border-b border-white/[0.07] px-3 py-3">
        <span className="text-xs font-semibold uppercase tracking-wide text-fg-dim">
          Chats
        </span>
        <button
          onClick={onNewChat}
          title="Start a new chat"
          className="flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium text-fg-muted transition-colors duration-150 hover:bg-ink-800 hover:text-fg"
        >
          <PlusIcon className="h-3.5 w-3.5" />
          New chat
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
        {index.length === 0 ? (
          <p className="px-2 py-6 text-center text-xs leading-relaxed text-fg-dim">
            Your past conversations will appear here.
          </p>
        ) : (
          <ul className="flex flex-col gap-0.5">
            {index.map((s) => {
              const active = s.sessionId === activeId;
              const confirming = confirmId === s.sessionId;
              return (
                <li key={s.sessionId} className="group relative">
                  <button
                    onClick={() => void onOpen(s.sessionId)}
                    className={`w-full rounded-lg px-2.5 py-2 text-left transition-colors duration-150 ${
                      active ? "bg-ink-800" : "hover:bg-ink-850"
                    }`}
                  >
                    <div className="truncate pr-5 text-sm text-fg">
                      {s.title}
                    </div>
                    <div className="mt-0.5 flex items-center gap-2 text-[11px] text-fg-dim">
                      <span>{relativeTime(s.updatedAt)}</span>
                      {s.totalCostUsd > 0 && (
                        <span className="tabular-nums">
                          {formatCost(s.totalCostUsd)}
                        </span>
                      )}
                    </div>
                  </button>

                  {!confirming && (
                    <button
                      onClick={() => setConfirmId(s.sessionId)}
                      title="Delete this chat"
                      aria-label="Delete this chat"
                      className="absolute right-1 top-1 rounded-md p-1.5 text-fg-dim opacity-0 transition-opacity duration-150 hover:bg-ink-700 hover:text-fg focus:opacity-100 group-hover:opacity-100 group-focus-within:opacity-100"
                    >
                      <TrashIcon className="h-3.5 w-3.5" />
                    </button>
                  )}

                  {confirming && (
                    <div className="absolute inset-0 flex items-center justify-end gap-1.5 rounded-lg bg-ink-850/95 px-2.5">
                      <span className="mr-auto text-[11px] text-fg-muted">
                        Delete?
                      </span>
                      <button
                        onClick={() => setConfirmId(null)}
                        className="rounded-md px-2 py-1 text-[11px] font-medium text-fg-muted transition-colors duration-150 hover:bg-ink-800 hover:text-fg"
                      >
                        Keep
                      </button>
                      <button
                        onClick={() => {
                          setConfirmId(null);
                          void remove(proj, s.sessionId);
                        }}
                        className="rounded-md bg-danger/20 px-2 py-1 text-[11px] font-medium text-danger transition-colors duration-150 hover:bg-danger/30"
                      >
                        Delete
                      </button>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </aside>
  );
}

/** Friendly per-chat cost: tiny amounts collapse to "<$0.01". */
function formatCost(usd: number): string {
  return usd < 0.01 ? "<$0.01" : `$${usd.toFixed(2)}`;
}
