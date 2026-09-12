import { useState } from "react";
import { api } from "@/api";
import { useChatStore } from "@/stores/useChatStore";
import { useToastStore } from "@/stores/useToastStore";

/**
 * One-press "keep me in sync with the remote": commits local work, fetches,
 * fast-forwards or merges the upstream, then pushes. The rainbow shimmer is
 * pure decoration — the button is a normal, keyboard-focusable control and
 * falls back to a static gradient under `prefers-reduced-motion`.
 */
export default function SynchronizeButton() {
  const project = useChatStore((s) => s.project);
  const showToast = useToastStore((s) => s.show);
  const [syncing, setSyncing] = useState(false);

  async function synchronize() {
    if (!project || syncing) return;
    setSyncing(true);
    try {
      const report = await api.syncRepo(project);
      showToast(report.summary);
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
      title="Commit, fetch, pull, merge and push"
      aria-busy={syncing}
      className="sync-rainbow flex shrink-0 items-center gap-1.5 rounded-lg px-3 py-2 text-xs font-semibold shadow-sm transition-[box-shadow,filter] disabled:cursor-not-allowed"
    >
      <span aria-hidden className={syncing ? "animate-spin" : undefined}>
        ⟳
      </span>
      {syncing ? "Syncing…" : "Synchronize"}
    </button>
  );
}
