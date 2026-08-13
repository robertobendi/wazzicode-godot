import { useState } from "react";
import { useRevertStore } from "@/stores/useRevertStore";
import { useChatStore } from "@/stores/useChatStore";
import { useLoopStore } from "@/stores/useLoopStore";
import { useToastStore } from "@/stores/useToastStore";
import { isLoopActive } from "@/types/loop";
import { UndoIcon } from "./icons";

/**
 * "Undo last change" — the safety net. Appears in the TopBar only when a studio
 * checkpoint is available AND nothing is currently running, so an employee can
 * always take the project back to just before the last AI change.
 */
export default function RevertControl() {
  const checkpoint = useRevertStore((s) => s.checkpoint);
  const reverting = useRevertStore((s) => s.reverting);
  const revert = useRevertStore((s) => s.revert);
  const running = useChatStore((s) => s.running);
  const queuedTaskCount = useChatStore((s) => s.queuedTasks.length);
  const project = useChatStore((s) => s.project);
  const appendNotice = useChatStore((s) => s.appendNotice);
  const loopRunning = useLoopStore((s) => isLoopActive(s.state?.status));
  const showToast = useToastStore((s) => s.show);
  const [confirming, setConfirming] = useState(false);

  // Available only once a turn has finished, and never mid-run.
  if (!checkpoint || running || queuedTaskCount > 0 || loopRunning || !project) {
    return null;
  }
  const proj = project;

  async function onConfirm() {
    try {
      await revert(proj);
      setConfirming(false);
      showToast("Restored ✓ Unity will reload the files.");
      appendNotice(
        "Undid the last change — the project is back to how it was before.",
      );
    } catch (e) {
      setConfirming(false);
      showToast(
        e instanceof Error ? e.message : "Couldn't undo the last change.",
      );
    }
  }

  return (
    <div className="relative">
      <button
        onClick={() => setConfirming((v) => !v)}
        title="Undo last change"
        className="flex items-center gap-1.5 rounded-md px-2 py-1 text-xs font-medium text-fg-muted transition-colors duration-150 hover:bg-ink-800 hover:text-fg"
      >
        <UndoIcon className="h-3.5 w-3.5" />
        Undo last change
      </button>

      {confirming && (
        <>
          {/* Click-away shield. */}
          <div
            className="fixed inset-0 z-40"
            onClick={() => setConfirming(false)}
          />
          <div className="glass-card absolute right-0 top-full z-50 mt-2 w-72 animate-appear rounded-2xl border p-3.5">
            <p className="text-sm leading-relaxed text-fg">
              Take the project back to just before the last AI change? Files the
              AI created will be removed.
            </p>
            <div className="mt-3 flex justify-end gap-2">
              <button
                onClick={() => setConfirming(false)}
                className="rounded-lg px-3 py-1.5 text-xs font-medium text-fg-muted transition-colors duration-150 hover:bg-ink-800 hover:text-fg"
              >
                Keep changes
              </button>
              <button
                onClick={() => void onConfirm()}
                disabled={reverting}
                className="rounded-lg bg-accent px-3 py-1.5 text-xs font-medium text-white transition-colors duration-150 hover:bg-accent-hover disabled:opacity-50"
              >
                {reverting ? "Undoing…" : "Undo last change"}
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
