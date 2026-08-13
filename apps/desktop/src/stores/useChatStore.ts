import { create } from "zustand";
import { api } from "@/api";
import {
  initialDraft,
  reduceStream,
  type StreamDraft,
} from "@/lib/streamMapper";
import { friendlyError } from "@/lib/errorMessages";
import {
  compatibleResumeSessionId,
  inferSessionRunOptions,
  resolveChatRunOptions,
} from "@/lib/agentOptions";
import { assemblePrompt } from "@/lib/promptAssembly";
import { useSettingsStore } from "@/stores/useSettingsStore";
import type { AgentRunOptions } from "@/types/agent";
import { BACKENDS } from "@/types/settings";
import type {
  Attachment,
  ChatMessage,
  ChatSession,
  DoneEvent,
  ErrorEvent,
  QueuedTask,
} from "@/types/chat";
import type { SessionPayload } from "@/types/session";

function newId(): string {
  const c = globalThis.crypto;
  if (c?.randomUUID) return c.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function emptySession(): ChatSession {
  return {
    sessionId: null,
    activeRunId: null,
    totalCostUsd: 0,
    totalTokens: 0,
    backend: null,
    runOptions: null,
  };
}

function discardQueuedAttachments(tasks: QueuedTask[]): void {
  for (const task of tasks) {
    for (const attachment of task.attachments) {
      void api.removeStaged(attachment.path).catch(() => {
        // The staged file is disposable and may already have been removed.
      });
    }
  }
}

interface ChatState {
  project: string | null;
  messages: ChatMessage[];
  session: ChatSession;
  running: boolean;
  activeRunId: string | null;
  cancelRequested: boolean;
  queuedTasks: QueuedTask[];
  /** Non-null when a failed/stopped task requires confirmation to continue. */
  queuePauseReason: string | null;

  /** Assistant message currently being streamed + its running draft. */
  assistantId: string | null;
  draft: StreamDraft | null;

  /** Point the store at a project; resets the conversation if it changed. */
  setProject: (project: string | null) => void;
  send: (
    prompt: string,
    attachments?: Attachment[],
    options?: AgentRunOptions,
  ) => Promise<void>;
  /** Atomically start now or enqueue, avoiding terminal-event click races. */
  submitTask: (
    prompt: string,
    attachments?: Attachment[],
    options?: AgentRunOptions,
  ) => "sent" | "queued" | null;
  enqueue: (
    prompt: string,
    attachments?: Attachment[],
    options?: AgentRunOptions,
  ) => string | null;
  runNextQueued: () => Promise<boolean>;
  removeQueued: (id: string) => Promise<void>;
  clearQueue: () => Promise<void>;
  pauseQueue: (reason: string) => void;
  cancel: () => Promise<void>;
  reset: () => void;
  /** Append a quiet, system-style notice line (e.g. after a revert). */
  appendNotice: (text: string) => void;
  /** Replace the conversation with a loaded past session (enables --resume). */
  loadSession: (payload: SessionPayload) => void;

  // Called by useAgentStream — not part of the public UI surface.
  ingest: (runId: string, raw: unknown) => void;
  finish: (runId: string, done: DoneEvent) => void;
  fail: (runId: string, err: ErrorEvent) => void;
}

export const useChatStore = create<ChatState>((set, get) => ({
  project: null,
  messages: [],
  session: emptySession(),
  running: false,
  activeRunId: null,
  cancelRequested: false,
  queuedTasks: [],
  queuePauseReason: null,
  assistantId: null,
  draft: null,

  setProject: (project) => {
    const state = get();
    if (state.project === project) return;
    discardQueuedAttachments(state.queuedTasks);
    set({
      project,
      messages: [],
      session: emptySession(),
      running: false,
      activeRunId: null,
      cancelRequested: false,
      queuedTasks: [],
      queuePauseReason: null,
      assistantId: null,
      draft: null,
    });
  },

  reset: () => {
    discardQueuedAttachments(get().queuedTasks);
    set({
      messages: [],
      session: emptySession(),
      running: false,
      activeRunId: null,
      cancelRequested: false,
      queuedTasks: [],
      queuePauseReason: null,
      assistantId: null,
      draft: null,
    });
  },

  appendNotice: (text) =>
    set((state) => ({
      messages: [
        ...state.messages,
        {
          id: newId(),
          role: "system",
          text,
          streaming: false,
          attachments: [],
          activities: [],
          createdAt: Date.now(),
        },
      ],
    })),

  loadSession: (payload) => {
    discardQueuedAttachments(get().queuedTasks);
    const messages = payload.messages ?? [];
    const runOptions = inferSessionRunOptions(payload);
    set({
      messages,
      session: {
        sessionId: payload.sessionId,
        activeRunId: null,
        totalCostUsd: payload.totalCostUsd ?? 0,
        // Not persisted (the session file predates it) — re-derive from the
        // messages so a resumed Codex chat still shows its running total.
        totalTokens: messages.reduce((n, m) => n + (m.tokens ?? 0), 0),
        backend: runOptions.backend,
        runOptions,
      },
      running: false,
      activeRunId: null,
      cancelRequested: false,
      queuedTasks: [],
      queuePauseReason: null,
      assistantId: null,
      draft: null,
    });
  },

  send: async (prompt, attachments = [], options) => {
    const state = get();
    const text = prompt.trim();
    if ((!text && attachments.length === 0) || state.running || !state.project) {
      return;
    }

    // The bubble shows the user's verbatim text + chips; the prompt sent to
    // Claude appends per-attachment instructions (promptAssembly).
    const finalPrompt = assemblePrompt(text, attachments);
    const runOptions = resolveChatRunOptions({
      sessionRunOptions: state.session.runOptions,
      sessionBackend: state.session.backend,
      requested: options,
      settings: useSettingsStore.getState().settings,
    });
    const resumeSessionId = compatibleResumeSessionId(
      state.session.sessionId,
      state.session.backend,
      runOptions,
    );
    const runAgentLabel = BACKENDS[runOptions.backend].label;

    const userMsg: ChatMessage = {
      id: newId(),
      role: "user",
      text,
      streaming: false,
      attachments,
      activities: [],
      createdAt: Date.now(),
    };
    const assistantMsg: ChatMessage = {
      id: newId(),
      role: "assistant",
      text: "",
      streaming: true,
      attachments: [],
      activities: [],
      createdAt: Date.now(),
    };
    set({
      messages: [...state.messages, userMsg, assistantMsg],
      assistantId: assistantMsg.id,
      draft: initialDraft(),
      running: true,
      cancelRequested: false,
      session: {
        ...state.session,
        sessionId: resumeSessionId,
        backend: runOptions.backend,
        runOptions,
      },
    });

    try {
      const runId = await api.chatSend(
        state.project,
        finalPrompt,
        resumeSessionId,
        runOptions,
      );
      set((s) => ({
        activeRunId: runId,
        session: { ...s.session, activeRunId: runId },
      }));
      if (get().cancelRequested) {
        try {
          await api.chatCancel(runId);
        } catch {
          // The reader task still emits an error/done event.
        }
      }
    } catch (e) {
      const raw = String(e);
      let friendly: string;
      if (raw.includes("auto mode")) {
        friendly = "Auto mode is running — stop it to chat.";
      } else if (raw.startsWith("busy")) {
        friendly = `${runAgentLabel} is still working on the last message.`;
      } else {
        friendly = friendlyError(
          raw,
          `Couldn't start ${runAgentLabel}.`,
          runOptions.backend,
        );
      }
      get().fail("", { friendly, raw });
      // A brand-new conversation is only frozen after the backend accepts the
      // run. If startup failed, restore the prior empty session so the user can
      // change model/effort and retry without creating another chat.
      set({ session: state.session });
      get().pauseQueue(
        "The task could not start. Review the error, then resume the queue.",
      );
    }
  },

  submitTask: (prompt, attachments = [], options) => {
    const state = get();
    const text = prompt.trim();
    if ((!text && attachments.length === 0) || !state.project) return null;

    if (state.running || state.queuedTasks.length > 0) {
      return get().enqueue(text, attachments, options) ? "queued" : null;
    }

    void get().send(text, attachments, options);
    return "sent";
  },

  enqueue: (prompt, attachments = [], options) => {
    const state = get();
    const text = prompt.trim();
    if ((!text && attachments.length === 0) || !state.project) return null;

    const runOptions = resolveChatRunOptions({
      sessionRunOptions: state.session.runOptions,
      sessionBackend: state.session.backend,
      requested: options,
      settings: useSettingsStore.getState().settings,
    });
    const task: QueuedTask = {
      id: newId(),
      prompt: text,
      attachments: [...attachments],
      runOptions,
      createdAt: Date.now(),
    };
    set((current) => ({ queuedTasks: [...current.queuedTasks, task] }));
    return task.id;
  },

  runNextQueued: async () => {
    const state = get();
    if (state.running || !state.project || state.queuedTasks.length === 0) {
      return false;
    }
    const [next, ...remaining] = state.queuedTasks;
    set({ queuedTasks: remaining, queuePauseReason: null });
    await get().send(next.prompt, next.attachments, next.runOptions);
    return true;
  },

  removeQueued: async (id) => {
    const task = get().queuedTasks.find((item) => item.id === id);
    set((state) => {
      const queuedTasks = state.queuedTasks.filter((item) => item.id !== id);
      return {
        queuedTasks,
        queuePauseReason:
          queuedTasks.length === 0 ? null : state.queuePauseReason,
      };
    });
    if (!task) return;
    await Promise.all(
      task.attachments.map((attachment) =>
        api.removeStaged(attachment.path).catch(() => undefined),
      ),
    );
  },

  clearQueue: async () => {
    const tasks = get().queuedTasks;
    set({ queuedTasks: [], queuePauseReason: null });
    await Promise.all(
      tasks.flatMap((task) =>
        task.attachments.map((attachment) =>
          api.removeStaged(attachment.path).catch(() => undefined),
        ),
      ),
    );
  },

  pauseQueue: (reason) =>
    set((state) =>
      state.queuedTasks.length > 0 ? { queuePauseReason: reason } : {},
    ),

  cancel: async () => {
    const { running, activeRunId: runId } = get();
    if (!running) return;
    set({ cancelRequested: true });
    if (!runId) return;
    try {
      await api.chatCancel(runId);
    } catch {
      // The reader task still emits an error/done event; nothing to do here.
    }
  },

  ingest: (runId, raw) =>
    set((state) => {
      if (runId !== state.activeRunId || !state.draft || !state.assistantId) {
        return {};
      }
      const draft = reduceStream(state.draft, raw);
      const messages = state.messages.map((m) =>
        m.id === state.assistantId
          ? { ...m, text: draft.text, activities: draft.activities }
          : m,
      );
      return { draft, messages };
    }),

  finish: (runId, done) =>
    set((state) => {
      if (runId !== state.activeRunId) return {};
      const endedAt = Date.now();
      const messages = state.messages.map((m) =>
        m.id === state.assistantId
          ? {
              ...m,
              streaming: false,
              activities: settleRunningActivities(m.activities, endedAt),
              text: m.text || done.resultText || "",
              costUsd: done.costUsd ?? undefined,
              tokens: done.tokens ?? undefined,
              error:
                done.isError && !m.text
                  ? `${BACKENDS[state.session.backend ?? "claude"].label} ran into a problem.`
                  : m.error,
            }
          : m,
      );
      return {
        messages,
        running: false,
        activeRunId: null,
        cancelRequested: false,
        assistantId: null,
        draft: null,
        session: {
          ...state.session,
          sessionId: done.sessionId ?? state.session.sessionId,
          activeRunId: null,
          totalCostUsd: state.session.totalCostUsd + (done.costUsd ?? 0),
          totalTokens: state.session.totalTokens + (done.tokens ?? 0),
        },
      };
    }),

  fail: (runId, err) =>
    set((state) => {
      // Accept the pre-run failure case (runId "") or a matching active run.
      if (runId !== "" && runId !== state.activeRunId) return {};
      const message = friendlyError(
        err.raw,
        err.friendly,
        state.session.backend ?? "claude",
      );
      const endedAt = Date.now();
      const messages = state.messages.map((m) =>
        m.id === state.assistantId
          ? {
              ...m,
              streaming: false,
              activities: settleRunningActivities(m.activities, endedAt),
              error: message,
              errorRaw: err.raw,
            }
          : m,
      );
      return {
        messages,
        running: false,
        activeRunId: null,
        cancelRequested: false,
        assistantId: null,
        draft: null,
        session: { ...state.session, activeRunId: null },
      };
  }),
}));

function settleRunningActivities(
  activities: ChatMessage["activities"],
  endedAt: number,
): ChatMessage["activities"] {
  return activities.map((activity) =>
    activity.status === "running"
      ? {
          ...activity,
          status: "error",
          resultText: "The run ended before this tool returned.",
          endedAt,
        }
      : activity,
  );
}
