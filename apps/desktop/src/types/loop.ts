// Auto-mode (loop) domain types. Mirror the Rust structs in
// src-tauri/src/looprunner/mod.rs (serde camelCase / snake_case enums).

import type { AgentRunOptions } from "./agent";

export type LoopStatus =
  | "running"
  | "stopping"
  /** Pause requested; the turn in flight finishes first. */
  | "pausing"
  /** Parked at a step boundary and resumable. */
  | "paused"
  | "done"
  | "stopped"
  | "blocked"
  | "max_iterations"
  | "cost_capped"
  | "failed";

export type LoopVerdict = "done" | "continue" | "blocked" | "unknown";

export interface LoopOptions {
  maxIterations: number;
  maxCostUsd: number;
  /** 0 disables the QA critic; >0 runs QA whenever the builder says "done". */
  qaEvery: number;
  referenceImages: string[];
  agent: AgentRunOptions;
  /** Existing-work context injected into the first builder step after recovery. */
  continuationContext?: string | null;
}

export interface QaResult {
  pass: boolean;
  score: number | null;
  notes: string;
}

export interface LoopFeedback {
  id: string;
  text: string;
  createdAtMs: number;
  /** Null while queued; otherwise the zero-based builder step that received it. */
  appliedAtIteration: number | null;
}

export interface LoopFailure {
  message: string;
  phase: "builder" | "qa";
  /** Zero-based step that failed. */
  iteration: number;
}

export interface LoopIteration {
  index: number;
  verdict: LoopVerdict;
  summary: string;
  costUsd: number;
  screenshotPath: string | null;
  commitSha: string | null;
  qa: QaResult | null;
}

/** Where a paused run picks back up. Set only while `paused`. */
export interface LoopCursor {
  nextIteration: number;
  strikes: number;
  prevSummary: string;
  qaFeedback: string | null;
  carriedFeedback: string[];
  builderSessionId: string | null;
}

export interface LoopState {
  loopId: string;
  goal: string;
  referenceImages: string[];
  status: LoopStatus;
  iterations: LoopIteration[];
  totalCostUsd: number;
  options: LoopOptions;
  warnings: string[];
  feedback: LoopFeedback[];
  failure: LoopFailure | null;
  currentRunId: string | null;
  cursor?: LoopCursor | null;
}

/** A running loop is one whose status hasn't reached a terminal state. A
 *  paused run is deliberately *not* active: it holds no project lock, so chat
 *  works while it waits. */
export function isLoopActive(status: LoopStatus | undefined): boolean {
  return status === "running" || status === "stopping" || status === "pausing";
}

/** Parked and resumable — distinct from finished, which cannot be resumed. */
export function isLoopPaused(status: LoopStatus | undefined): boolean {
  return status === "paused";
}

export const DEFAULT_LOOP_OPTIONS: LoopOptions = {
  maxIterations: 10,
  maxCostUsd: 5.0,
  qaEvery: 1,
  referenceImages: [],
  agent: { backend: "claude", model: null, effort: null },
};
