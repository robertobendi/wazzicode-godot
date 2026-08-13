// Session-history domain types. Mirror the Rust structs in
// src-tauri/src/commands/sessions.rs (serde camelCase).

import type { ChatMessage } from "./chat";
import type { AgentBackend, AgentRunOptions } from "./agent";

/** One row in the session rail — enough to list without loading the chat. */
export interface SessionIndexEntry {
  sessionId: string;
  /** First user message, trimmed. */
  title: string;
  /** Unix milliseconds of the last update. */
  updatedAt: number;
  totalCostUsd: number;
  messageCount: number;
}

/** The full saved conversation written to disk (and read back to resume). */
export interface SessionPayload {
  sessionId: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  totalCostUsd: number;
  messages: ChatMessage[];
  /** Added after multi-agent support. Optional so old files still load. */
  agentBackend?: AgentBackend;
  /** Exact task controls used by the CLI. Optional on legacy files. */
  runOptions?: AgentRunOptions;
}
