import { useState } from "react";
import { api } from "@/api";
import { useSyncStatus } from "@/hooks/useSyncStatus";
import { useChatStore } from "@/stores/useChatStore";
import { useToastStore } from "@/stores/useToastStore";

/**
 * Keep the project in sync with its remote. The rainbow shimmer is reserved for
 * when there is actually something to do — uncommitted work, commits to push, or
 * upstream commits to pull/merge — so it doesn't beg for attention on a clean,
 * already-synced repo. Under `prefers-reduced-motion` the rainbow is static.
 */
export default function SynchronizeButton() {
  const project = useChatStore((s) => s.project);
  const showToast = useToastStore((s) => s.show);
  const { status, checking, refresh } = useSyncStatus();
  const [syncing, setSyncing] = useState(false);

  const attention = syncing || (status?.actionNeeded ?? false);
  const title = syncing
    ? "Synchronizing…"
    : checking && !status
      ? "Checking for changes…"
      : (status?.summary ?? "Check for changes to commit, pull or push");

  async function synchronize() {
    if (!project || syncing) return;
    setSyncing(true);
    try {
      const report = await api.syncRepo(project);
      showToast(report.summary);
      await refresh(true);
    } catch (error) {
      showToast(String(error));
    } finally {
      setSyncing(false);
    }
  }

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
      {syncing ? "Syncing…" : "Synchronize"}
      {attention && !syncing && (
        <span
          aria-hidden
          className="ml-0.5 h-1.5 w-1.5 rounded-full bg-black/40"
        />
      )}
    </button>
  );
}
