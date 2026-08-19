import { useChatStore } from "@/stores/useChatStore";
import { BACKENDS } from "@/types/settings";

/** Active-task feedback plus the ordered work waiting behind it. */
export default function TaskFeedback() {
  const running = useChatStore((s) => s.running);
  const activeRunId = useChatStore((s) => s.activeRunId);
  const cancelRequested = useChatStore((s) => s.cancelRequested);
  const draft = useChatStore((s) => s.draft);
  const backend = useChatStore((s) => s.session.backend ?? "claude");
  const queuedTasks = useChatStore((s) => s.queuedTasks);
  const queuePauseReason = useChatStore((s) => s.queuePauseReason);
  const resumeQueue = useChatStore((s) => s.resumeQueue);
  const pauseQueue = useChatStore((s) => s.pauseQueue);
  const removeQueued = useChatStore((s) => s.removeQueued);
  const clearQueue = useChatStore((s) => s.clearQueue);

  if (!running && queuedTasks.length === 0) return null;

  const activities = draft?.activities ?? [];
  const complete = activities.filter((a) => a.status !== "running").length;
  const current = [...activities].reverse().find((a) => a.status === "running");

  let label = "";
  let detail = "";
  if (cancelRequested) {
    label = "Stopping safely…";
    detail = "Finishing the current operation";
  } else if (!activeRunId) {
    label = "Starting your task…";
    detail = `Connecting ${BACKENDS[backend].label} to the project`;
  } else if (current) {
    label = current.friendlyLabel;
    detail =
      complete > 0
        ? `${complete} ${complete === 1 ? "step" : "steps"} complete`
        : "Working in your project";
  } else if (draft?.text.trim()) {
    label = "Writing up the result…";
    detail =
      complete > 0
        ? `${complete} ${complete === 1 ? "step" : "steps"} complete`
        : "Almost done";
  } else {
    label = "Planning the next step…";
    detail =
      complete > 0
        ? `${complete} ${complete === 1 ? "step" : "steps"} complete`
        : "Your task is running";
  }

  return (
    <div
      className={`mx-3 mb-2 shrink-0 overflow-hidden rounded-xl border ${
        queuePauseReason
          ? "border-warning/25 bg-warning/[0.055]"
          : "border-accent/20 bg-accent/[0.055]"
      }`}
    >
      {running && (
        <div
          role="status"
          aria-live="polite"
          className="flex items-center gap-3 px-3.5 py-2"
        >
          <span className="relative flex h-2.5 w-2.5 shrink-0">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-accent opacity-35" />
            <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-accent" />
          </span>
          <div className="min-w-0 flex-1">
            <div className="truncate text-xs font-medium text-fg">{label}</div>
            <div className="truncate text-[11px] text-fg-dim">{detail}</div>
          </div>
          {queuedTasks.length > 0 && (
            <span className="shrink-0 rounded-full border border-accent/20 bg-black/15 px-2 py-0.5 text-[10px] font-medium text-fg-muted">
              {queuedTasks.length} queued
            </span>
          )}
        </div>
      )}

      {queuedTasks.length > 0 && (
        <section
          aria-label="Task queue"
          className={running ? "border-t border-white/[0.07]" : undefined}
        >
          <div className="flex items-start gap-3 px-3.5 py-2.5">
            <div className="min-w-0 flex-1">
              <div className="text-xs font-semibold text-fg">
                {queuePauseReason ? "Queue paused" : "Next up"}
              </div>
              <p className="mt-0.5 text-[11px] leading-relaxed text-fg-dim">
                {queuePauseReason ??
                  (running
                    ? "Starts automatically after the current task is fully finished."
                    : "Preparing the next task…")}
              </p>
            </div>
            <div className="flex shrink-0 items-center gap-1.5">
              {queuePauseReason ? (
                <button
                  onClick={() => void resumeQueue()}
                  title={
                    running
                      ? "Let the queue continue once this task finishes"
                      : "Start the next task now"
                  }
                  className="rounded-md bg-accent px-2.5 py-1.5 text-[11px] font-semibold text-white hover:bg-accent-hover"
                >
                  Resume
                </button>
              ) : (
                <button
                  onClick={() =>
                    pauseQueue(
                      running
                        ? "Paused. This task finishes, then the queue holds."
                        : "Paused. Nothing starts until you resume.",
                    )
                  }
                  title="Hold the queue without losing it"
                  className="rounded-md border border-white/10 px-2.5 py-1.5 text-[11px] font-medium text-fg-muted hover:bg-white/[0.06] hover:text-fg"
                >
                  Pause
                </button>
              )}
              <button
                onClick={() => void clearQueue()}
                className="rounded-md px-2 py-1.5 text-[11px] font-medium text-fg-dim hover:bg-white/[0.06] hover:text-fg-muted"
              >
                Clear
              </button>
            </div>
          </div>

          <ol className="max-h-28 overflow-y-auto border-t border-white/[0.055] px-2 py-1.5">
            {queuedTasks.map((task, index) => (
              <li
                key={task.id}
                className="group flex min-w-0 items-center gap-2 rounded-lg px-1.5 py-1.5 hover:bg-white/[0.035]"
              >
                <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-md bg-white/[0.06] text-[10px] font-semibold tabular-nums text-fg-dim">
                  {index + 1}
                </span>
                <span className="min-w-0 flex-1 truncate text-xs text-fg-muted">
                  {task.prompt ||
                    `${task.attachments.length} attached ${task.attachments.length === 1 ? "file" : "files"}`}
                </span>
                {task.attachments.length > 0 && task.prompt && (
                  <span className="shrink-0 text-[10px] text-fg-dim">
                    +{task.attachments.length} file
                    {task.attachments.length === 1 ? "" : "s"}
                  </span>
                )}
                <button
                  onClick={() => void removeQueued(task.id)}
                  aria-label={`Remove queued task ${index + 1}`}
                  title="Remove from queue"
                  className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-sm text-fg-dim hover:bg-white/[0.07] hover:text-fg"
                >
                  ×
                </button>
              </li>
            ))}
          </ol>
        </section>
      )}
    </div>
  );
}
