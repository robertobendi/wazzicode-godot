import { useState } from "react";
import { api } from "@/api";
import { useSyncStatus } from "@/hooks/useSyncStatus";
import { runTaskAndWait, syncCommitMessage, syncPromptFor } from "@/lib/syncPrompt";
import { useChatStore } from "@/stores/useChatStore";
import { useSettingsStore } from "@/stores/useSettingsStore";
import { useToastStore } from "@/stores/useToastStore";

type Phase = "idle" | "syncing" | "prompt" | "pushing";

/**
 * Keep the project in sync with its remote. The rainbow shimmer is reserved for
 * when there is actually something to do — uncommitted work, commits to push, or
 * upstream commits to pull/merge — so it doesn't beg for attention on a clean,
 * already-synced repo. Under `prefers-reduced-motion` the rainbow is static.
 *
 * With a sync prompt set for this project (Settings → Synchronize), a press
 * syncs, runs the prompt on the freshly pulled project as a normal chat task,
 * then syncs again so whatever it changed is committed and pushed too.
 */
export default function SynchronizeButton() {
  const project = useChatStore((s) => s.project);
  const chatBusy = useChatStore((s) => s.running || s.queuedTasks.length > 0);
  const syncPrompt = useSettingsStore((s) => syncPromptFor(s.settings, project));
  const showToast = useToastStore((s) => s.show);
  const { status, checking, refresh } = useSyncStatus();
  const [phase, setPhase] = useState<Phase>("idle");
  const syncing = phase !== "idle";

  const attention = syncing || (status?.actionNeeded ?? false);
  const title =
    phase === "prompt"
      ? "Running your sync prompt…"
      : syncing
        ? "Synchronizing…"
        : checking && !status
          ? "Checking for changes…"
          : [
              status?.summary ?? "Check for changes to commit, pull or push",
              syncPrompt && "Then runs your sync prompt and pushes what it changes.",
            ]
              .filter(Boolean)
              .join("\n");

  async function synchronize() {
    if (!project || syncing) return;
    // The prompt runs as a chat task, which needs the chat to itself.
    if (syncPrompt && chatBusy) {
      showToast("Finish the current task first — Synchronize runs your sync prompt as a task.");
      return;
    }
    setPhase("syncing");
    try {
      const report = await api.syncRepo(project);
      if (!syncPrompt || !report.ok) {
        showToast(report.summary);
        return;
      }
      setPhase("prompt");
      const finished = await runTaskAndWait(syncPrompt);
      if (!finished) {
        showToast(`${report.summary} The sync prompt didn't finish, so its changes weren't pushed.`);
        return;
      }
      setPhase("pushing");
      const after = await api.syncRepo(project, syncCommitMessage(syncPrompt));
      showToast(
        after.ok
          ? after.committed
            ? "Synchronized, ran your sync prompt and pushed its changes."
            : "Synchronized and ran your sync prompt — it changed nothing."
          : after.summary,
      );
    } catch (error) {
      showToast(String(error));
    } finally {
      setPhase("idle");
      await refresh(true);
    }
  }

  const label =
    phase === "prompt" ? "Running prompt…" : syncing ? "Syncing…" : "Synchronize";

  return (
    <button
      onClick={() => void synchronize()}
      disabled={!project || syncing}
      title={title}
      aria-busy={syncing}
      className={`flex shrink-0 items-center gap-1.5 rounded-lg px-3 py-2 text-xs font-semibold transition-[box-shadow,filter,background-color,color,border-color] disabled:cursor-not-allowed ${
        attention
          ? "sync-rainbow"
          : "border border-white/10 bg-white/[0.04] text-fg-muted hover:bg-white/[0.08] hover:text-fg"
      }`}
    >
      <span aria-hidden className={syncing ? "animate-spin" : undefined}>
        ⟳
      </span>
      {label}
      {syncPrompt && !syncing && (
        <span aria-hidden className="text-[10px] opacity-70">
          ✦
        </span>
      )}
      {attention && !syncing && (
        <span
          aria-hidden
          className="ml-0.5 h-1.5 w-1.5 rounded-full bg-black/40"
        />
      )}
    </button>
  );
}
