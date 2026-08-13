// Chat domain types. Shared by the stream mapper, stores, and components.

import type { AgentBackend, AgentRunOptions } from "./agent";

/** Resource kind — classified in Rust (commands/resources.rs), mirrored here. */
export type ResourceKind = "image" | "model" | "audio" | "text" | "other";

/** What `stage_paths` / `paste_clipboard` return (Rust `StagedResource`). */
export interface StagedResource {
  id: string;
  kind: ResourceKind;
  originalName: string;
  /** Absolute path of the copy under <project>/.unity-vibe/inbox. */
  stagedPath: string;
  byteSize: number;
}

/** A staged resource attached to a message. */
export interface Attachment {
  id: string;
  /** Absolute path on disk (staged under <project>/.unity-vibe/inbox). */
  path: string;
  name: string;
  kind: ResourceKind;
  /** File size in bytes, for the chip label. */
  size?: number;
  /** Renderable image URL (asset-protocol) for image kinds. */
  preview?: string;
}

export type ActivityStatus = "running" | "ok" | "error";

/** A single tool invocation, rendered as an inline chip in the assistant turn. */
export interface ToolActivity {
  /** Stable id (the tool_use content-block id). */
  id: string;
  /** Same as `id` — the tool_use_id used to resolve the later tool_result. */
  toolUseId: string;
  /** Raw tool name, e.g. "mcp__unity-vibe-os__unity_orient". */
  name: string;
  /** Human label from toolLabels.ts, e.g. "Getting oriented in Unity". */
  friendlyLabel: string;
  status: ActivityStatus;
  /** Tool input object, when present. */
  input?: unknown;
  /** Short text summary of the tool_result. */
  resultText?: string;
  /** Bounded original MCP text, retained for structured result parsing. */
  resultRaw?: string;
  /** True when resultRaw reached its storage limit. */
  resultRawTruncated?: boolean;
  startedAt: number;
  endedAt?: number;
}

export type ChatRole = "user" | "assistant" | "system";

export interface ChatMessage {
  id: string;
  role: ChatRole;
  text: string;
  /** True while the assistant turn is still streaming. */
  streaming: boolean;
  attachments: Attachment[];
  activities: ToolActivity[];
  createdAt: number;
  /** Cost of this turn, from the `result` event. */
  costUsd?: number;
  /** Tokens for the turn, on backends that report them instead of a price
   *  (Codex). Exactly one of `costUsd` / `tokens` is set. */
  tokens?: number;
  /** Friendly error text when the turn failed. */
  error?: string;
  /** Raw error detail behind `error`, shown under a "Details" disclosure. */
  errorRaw?: string;
}

/** A user task waiting for the current agent run to settle. */
export interface QueuedTask {
  id: string;
  prompt: string;
  attachments: Attachment[];
  /** Frozen when queued so later settings changes cannot alter its meaning. */
  runOptions: AgentRunOptions;
  createdAt: number;
}

export interface ChatSession {
  /** Captured from the `system/init` (or `result`) event; enables --resume. */
  sessionId: string | null;
  /** Non-null while a run is in flight. */
  activeRunId: string | null;
  totalCostUsd: number;
  /** Running token total, on backends that report tokens instead of a price
   *  (Codex). Stays 0 on Claude. */
  totalTokens: number;
  /** Backend that owns `sessionId`; null until the first task starts. */
  backend: AgentBackend | null;
  /** Frozen model/reasoning controls for this conversation. */
  runOptions: AgentRunOptions | null;
}

/** Payload of `agent:done:<runId>`. */
export interface DoneEvent {
  sessionId: string | null;
  /** USD cost of the turn. `null` on backends that don't price a turn (Codex),
   *  which is deliberately distinct from 0 — see `tokens`. */
  costUsd: number | null;
  /** Total tokens for the turn, on backends that report them (Codex). */
  tokens: number | null;
  isError: boolean;
  resultText: string | null;
  numTurns: number | null;
}

/** Payload of `agent:error:<runId>`. */
export interface ErrorEvent {
  friendly: string;
  raw: string;
}

export type ChatTerminalEvent =
  | { kind: "done"; payload: DoneEvent }
  | { kind: "error"; payload: ErrorEvent };
