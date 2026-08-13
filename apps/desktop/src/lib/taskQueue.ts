export type TaskOutcome = "completed" | "failed" | "stopped";

interface SettleTaskQueueOptions {
  outcome: TaskOutcome;
  /** Persist the completed turn before another process can start. */
  persist?: () => Promise<void>;
  advance: () => Promise<boolean>;
  pause: (reason: string) => void;
}

/**
 * Cross the terminal boundary for one task. Normal completion drains the queue
 * only after persistence settles; errors and explicit stops preserve the queue
 * for the user to review and resume.
 */
export async function settleTaskQueue({
  outcome,
  persist,
  advance,
  pause,
}: SettleTaskQueueOptions): Promise<void> {
  if (persist) await persist();

  if (outcome === "completed") {
    await advance();
    return;
  }

  pause(
    outcome === "stopped"
      ? "The current task was stopped. Resume when you are ready."
      : "The current task needs attention. Review the error, then resume.",
  );
}
