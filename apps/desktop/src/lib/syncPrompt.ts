import { useChatStore } from "@/stores/useChatStore";
import type { Settings } from "@/types/settings";

/** The prompt Synchronize runs for `project`, or null when none is enabled. */
export function syncPromptFor(
  settings: Settings | null,
  project: string | null,
): string | null {
  if (!settings || !project) return null;
  const entry = settings.syncPrompts?.[project];
  const prompt = entry?.prompt.trim();
  return entry?.enabled && prompt ? prompt : null;
}

/** Commit message for the work a sync prompt produced: its first line, short. */
export function syncCommitMessage(prompt: string): string {
  const line = prompt.trim().split(/\r?\n/, 1)[0].replace(/\s+/g, " ");
  const short = line.length > 60 ? `${line.slice(0, 57).trimEnd()}…` : line;
  return `sync: ${short}`;
}

/**
 * Send `prompt` as an ordinary chat task (so it shows in the conversation and
 * gets a checkpoint like any other) and resolve once it ends: true when it
 * finished cleanly, false on error, cancel, or the chat being reset under it.
 * The chat must be idle; returns false straight away otherwise.
 */
export function runTaskAndWait(prompt: string): Promise<boolean> {
  const chat = useChatStore.getState();
  if (chat.running || chat.queuedTasks.length > 0) return Promise.resolve(false);
  if (chat.submitTask(prompt) !== "sent") return Promise.resolve(false);
  // `send` appends the reply bubble synchronously, before its first await.
  const replyId = useChatStore.getState().assistantId;
  if (!replyId) return Promise.resolve(false);

  return new Promise((resolve) => {
    const settle = (state: ReturnType<typeof useChatStore.getState>) => {
      const reply = state.messages.find((m) => m.id === replyId);
      if (!reply) return finish(false);
      if (!reply.streaming) return finish(!reply.error);
    };
    const finish = (ok: boolean) => {
      unsubscribe();
      resolve(ok);
    };
    const unsubscribe = useChatStore.subscribe(settle);
    settle(useChatStore.getState());
  });
}
