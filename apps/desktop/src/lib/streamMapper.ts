// Pure reducer over a headless agent's newline-delimited JSON stream.
//
// Rust emits each parsed JSON line as an `agent:stream:<runId>` event; this
// module folds them into a `StreamDraft` the chat store projects onto the
// assistant message. No Tauri imports — fully unit-testable.
//
// TWO backends feed this, and it dispatches on the line's own `type` rather than
// on a backend flag threaded down from settings. That's not a shortcut: the
// vocabularies are disjoint (Claude says `system`/`assistant`/`user`/`result`,
// Codex says `thread.*`/`turn.*`/`item.*`), so the shape *is* the discriminator —
// and a run started before the user flipped the picker still reduces correctly,
// which a settings-derived flag would get wrong.
//
// Claude line shapes handled (verified against Claude Code 2.1.198):
//   {type:"system", subtype:"init", session_id, tools:[...], model}
//   {type:"stream_event", event:{type:"content_block_delta",
//        delta:{type:"text_delta", text}}}
//   {type:"assistant", message:{content:[{type:"tool_use", id, name, input}]}}
//   {type:"user", message:{content:[{type:"tool_result", tool_use_id,
//        content, is_error}]}}
//   {type:"result", subtype:"success", total_cost_usd, is_error, result}
// Everything else (other system subtypes, rate_limit_event, message_start/stop,
// content_block_start/stop, message_delta) is ignored.
//
// Codex line shapes live in `codexStream.ts`.

import type { ToolActivity } from "@/types/chat";
import { isCodexEvent, reduceCodex } from "./codexStream";
import { toolLabel } from "./toolLabels";
import {
  boundMcpResultText,
  isUnityDiagnosticActivity,
} from "./unityDiagnostics";

export interface StreamDraft {
  /** Accumulated assistant visible text. */
  text: string;
  activities: ToolActivity[];
  sessionId?: string;
  /** Tool names advertised in the system/init event (Claude only — Codex doesn't
   *  announce its toolset up front). */
  toolsSeen: string[];
  /** True when the MCP Unity tools are actually available this run. */
  hasUnityTools: boolean;
  /** Final turn cost in USD. Claude only: Codex reports tokens, not dollars, so
   *  this stays undefined there — which is the signal NOT to render "$0.00". */
  cost?: number;
  /** Total tokens for the turn, when the backend reports them (Codex). */
  tokens?: number;
  isError: boolean;
  done: boolean;
}

export function initialDraft(): StreamDraft {
  return {
    text: "",
    activities: [],
    toolsSeen: [],
    hasUnityTools: false,
    isError: false,
    done: false,
  };
}

// Loosely-typed view of a stream line; we defensively read fields.
type Raw = Record<string, any>;

/** Fold one raw stream line into the draft, returning a new draft. */
export function reduceStream(draft: StreamDraft, raw: unknown): StreamDraft {
  if (!raw || typeof raw !== "object") return draft;
  const v = raw as Raw;

  if (isCodexEvent(v.type)) return reduceCodex(draft, v);

  switch (v.type) {
    case "system":
      return v.subtype === "init" ? applyInit(draft, v) : draft;
    case "stream_event":
      return applyStreamEvent(draft, v);
    case "assistant":
      return applyAssistant(draft, v);
    case "user":
      return applyUser(draft, v);
    case "result":
      return applyResult(draft, v);
    default:
      return draft;
  }
}

function applyInit(draft: StreamDraft, v: Raw): StreamDraft {
  const tools: string[] = Array.isArray(v.tools) ? v.tools : [];
  const hasUnityTools = tools.some((t) => t.startsWith("mcp__unity-vibe-os"));
  return {
    ...draft,
    sessionId: typeof v.session_id === "string" ? v.session_id : draft.sessionId,
    toolsSeen: tools,
    hasUnityTools,
  };
}

function applyStreamEvent(draft: StreamDraft, v: Raw): StreamDraft {
  const event = v.event as Raw | undefined;
  if (!event) return draft;
  if (
    event.type === "content_block_delta" &&
    event.delta?.type === "text_delta" &&
    typeof event.delta.text === "string"
  ) {
    return { ...draft, text: draft.text + event.delta.text };
  }
  return draft;
}

function applyAssistant(draft: StreamDraft, v: Raw): StreamDraft {
  const content = v.message?.content;
  if (!Array.isArray(content)) return draft;

  let activities = draft.activities;
  for (const block of content) {
    if (block?.type !== "tool_use" || typeof block.id !== "string") continue;
    if (activities.some((a) => a.id === block.id)) continue; // dedupe re-sends
    const name = typeof block.name === "string" ? block.name : "unknown";
    const activity: ToolActivity = {
      id: block.id,
      toolUseId: block.id,
      name,
      friendlyLabel: toolLabel(name),
      status: "running",
      input: block.input,
      startedAt: Date.now(),
    };
    activities = [...activities, activity];
  }
  return activities === draft.activities ? draft : { ...draft, activities };
}

function applyUser(draft: StreamDraft, v: Raw): StreamDraft {
  const content = v.message?.content;
  if (!Array.isArray(content)) return draft;

  let activities = draft.activities;
  let changed = false;
  for (const block of content) {
    if (block?.type !== "tool_result" || typeof block.tool_use_id !== "string") {
      continue;
    }
    const idx = activities.findIndex((a) => a.toolUseId === block.tool_use_id);
    if (idx === -1) continue;
    const activity = activities[idx];
    const resolved: ToolActivity = {
      ...activity,
      status: block.is_error ? "error" : "ok",
      resultText: extractResultText(block.content),
      ...(isUnityDiagnosticActivity(activity.name)
        ? boundMcpResultText(extractRawResultText(block.content))
        : {}),
      endedAt: Date.now(),
    };
    activities = activities.map((a, i) => (i === idx ? resolved : a));
    changed = true;
  }
  return changed ? { ...draft, activities } : draft;
}

function applyResult(draft: StreamDraft, v: Raw): StreamDraft {
  return {
    ...draft,
    done: true,
    isError: v.is_error === true,
    cost: typeof v.total_cost_usd === "number" ? v.total_cost_usd : draft.cost,
    sessionId: typeof v.session_id === "string" ? v.session_id : draft.sessionId,
    // If the model produced no streamed text (e.g. tool-only turn), fall back
    // to the result string so the bubble isn't empty.
    text:
      draft.text.trim().length > 0
        ? draft.text
        : typeof v.result === "string"
          ? v.result
          : draft.text,
  };
}

/** tool_result content is a string or an array of {type:"text", text}; keep a
 * short, single-line summary for the chip tooltip. */
function extractResultText(content: unknown): string | undefined {
  let text: string;
  if (typeof content === "string") {
    text = content;
  } else if (Array.isArray(content)) {
    text = content
      .map((b) =>
        b && typeof b === "object" && typeof (b as Raw).text === "string"
          ? (b as Raw).text
          : "",
      )
      .join(" ");
  } else {
    return undefined;
  }
  const trimmed = text.replace(/\s+/g, " ").trim();
  if (!trimmed) return undefined;
  return trimmed.length > 200 ? trimmed.slice(0, 200) + "…" : trimmed;
}

function extractRawResultText(content: unknown): string | undefined {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return undefined;
  const parts = content.flatMap((block) =>
    block && typeof block === "object" && typeof (block as Raw).text === "string"
      ? [(block as Raw).text as string]
      : [],
  );
  return parts.length > 0 ? parts.join("\n") : undefined;
}
