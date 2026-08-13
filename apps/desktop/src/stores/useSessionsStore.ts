import { create } from "zustand";
import { api } from "@/api";
import { inferSessionRunOptions } from "@/lib/agentOptions";
import { useChatStore } from "@/stores/useChatStore";
import type { ChatMessage } from "@/types/chat";
import type { SessionIndexEntry, SessionPayload } from "@/types/session";

/**
 * Session history. Chats are persisted per-project under
 * `.unity-vibe/studio/sessions/`; this store mirrors the lightweight index the
 * left rail renders and drives save / open / delete. The Rust side owns the
 * files ([`commands/sessions.rs`]); resume works because loading a session sets
 * the chat store's `sessionId`, which the next `send` passes to `--resume`.
 */
interface SessionsState {
  index: SessionIndexEntry[];
  /** The session currently loaded into the chat view, if any. */
  activeSessionId: string | null;
  loading: boolean;

  /** Reload the index for `project`. */
  refresh: (project: string) => Promise<void>;
  /** Snapshot the current chat into a session file (no-op without a session). */
  autosave: (project: string) => Promise<void>;
  /** Load a past session into the chat view. False if a run is in flight. */
  open: (project: string, sessionId: string) => Promise<boolean>;
  /** Delete a session file + drop it from the index. */
  remove: (project: string, sessionId: string) => Promise<void>;
  /** Save the current chat, then start a fresh one. */
  newChat: (project: string) => Promise<void>;
  /** Clear index + active session (on project switch). */
  reset: () => void;
}

/** Drop streaming flags and purely-empty placeholder turns before persisting. */
function serializeMessages(messages: ChatMessage[]): ChatMessage[] {
  return messages
    .filter(
      (m) =>
        m.text.trim() ||
        m.attachments.length > 0 ||
        m.activities.length > 0 ||
        m.error,
    )
    .map((m) => ({ ...m, streaming: false }));
}

/** The rail title: the first user message, trimmed to 60 chars. */
function titleFrom(messages: ChatMessage[]): string {
  const firstUser = messages.find((m) => m.role === "user" && m.text.trim());
  const text = firstUser?.text.trim() || "New conversation";
  return text.length > 60 ? text.slice(0, 60) : text;
}

export const useSessionsStore = create<SessionsState>((set, get) => ({
  index: [],
  activeSessionId: null,
  loading: false,

  refresh: async (project) => {
    set({ loading: true });
    try {
      const index = await api.listSessions(project);
      set({ index });
    } catch {
      // Backend not ready / no dir yet — leave the current index.
    } finally {
      set({ loading: false });
    }
  },

  autosave: async (project) => {
    const chat = useChatStore.getState();
    const sessionId = chat.session.sessionId;
    // No session id yet means the turn never produced one — nothing to resume,
    // so there's nothing worth saving.
    if (!sessionId) return;
    const messages = serializeMessages(chat.messages);
    if (messages.length === 0) return;

    const now = Date.now();
    const runOptions = inferSessionRunOptions({
      agentBackend: chat.session.backend,
      runOptions: chat.session.runOptions,
      messages,
    });
    const payload: SessionPayload = {
      sessionId,
      title: titleFrom(messages),
      createdAt: chat.messages[0]?.createdAt ?? now,
      updatedAt: now,
      totalCostUsd: chat.session.totalCostUsd,
      messages,
      agentBackend: runOptions.backend,
      runOptions,
    };
    try {
      await api.saveSession(project, payload);
      set({ activeSessionId: sessionId });
      await get().refresh(project);
    } catch {
      // Autosave is best-effort; a write failure shouldn't disrupt the chat.
    }
  },

  open: async (project, sessionId) => {
    const chat = useChatStore.getState();
    if (chat.running || chat.queuedTasks.length > 0) return false;
    try {
      const payload = await api.loadSession(project, sessionId);
      useChatStore.getState().loadSession(payload);
      set({ activeSessionId: sessionId });
      return true;
    } catch {
      return false;
    }
  },

  remove: async (project, sessionId) => {
    try {
      await api.deleteSession(project, sessionId);
    } catch {
      // Ignore — drop it from the index regardless.
    }
    set((s) => ({
      index: s.index.filter((e) => e.sessionId !== sessionId),
      activeSessionId:
        s.activeSessionId === sessionId ? null : s.activeSessionId,
    }));
  },

  newChat: async (project) => {
    const chat = useChatStore.getState();
    if (chat.running || chat.queuedTasks.length > 0) return;
    await get().autosave(project);
    useChatStore.getState().reset();
    set({ activeSessionId: null });
  },

  reset: () => set({ index: [], activeSessionId: null }),
}));
