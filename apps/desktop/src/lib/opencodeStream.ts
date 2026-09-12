// Pure reducer over OpenCode's `opencode run --format json` lines.
//
// The Claude half lives in `streamMapper.ts`, the Codex half in `codexStream.ts`;
// all three fold into the SAME `StreamDraft`, so the chat store, message bubble
// and tool timeline stay backend-agnostic.
//
// Line shapes handled (verified against opencode 1.14.46):
//   {type:"step_start",  sessionID, part:{type:"step-start"}}
//   {type:"text",        sessionID, part:{type:"text", text}}
//   {type:"tool_use",    sessionID, part:{type:"tool", tool, callID,
//        state:{status, input, output, metadata, title, time}}}
//   {type:"step_finish", sessionID, part:{type:"step-finish", reason,
//        tokens:{input,output,reasoning,cache}, cost}}
//   {type:"error",       error:{name, data:{message}}}
//
// Three differences from the other two worth knowing:
//
//   1. **Text arrives as finished-part chunks**, so it is appended verbatim
//      rather than streamed token-by-token.
//   2. **`step_finish` fires after every step** (including tool-call steps), not
//      once per turn, so cost and tokens are summed across steps.
//   3. **Cost is real** (a provider-priced number, possibly 0), so `cost` is
//      populated rather than left undefined.

import type { ToolActivity } from "@/types/chat";
import type { StreamDraft } from "./streamMapper";
import { openCodeToolLabel } from "./toolLabels";
import {
  boundMcpResultText,
  shouldRetainGodotRawResult,
} from "./godotDiagnostics";

type Raw = Record<string, any>;

/** True if `raw` is an OpenCode event (vs. a Claude or Codex one). */
export function isOpenCodeEvent(v: Raw): boolean {
  switch (v.type) {
    case "step_start":
    case "step_finish":
    case "text":
    case "tool_use":
      return true;
    case "error":
      // Codex errors are `{type:"error", message}`; OpenCode's carry an object.
      return !!v.error && typeof v.error === "object";
    default:
      return false;
  }
}

/** Fold one raw OpenCode line into the draft, returning a new draft. */
export function reduceOpenCode(draft: StreamDraft, v: Raw): StreamDraft {
  const sessionId =
    typeof v.sessionID === "string" && v.sessionID ? v.sessionID : undefined;
  const next = sessionId ? { ...draft, sessionId } : draft;

  switch (v.type) {
    case "text": {
      const text = v.part?.text;
      return typeof text === "string" && text
        ? { ...next, text: next.text + text }
        : next;
    }
    case "step_finish": {
      const part = (v.part ?? {}) as Raw;
      const cost = typeof part.cost === "number" ? part.cost : undefined;
      const tokens = tokenTotal(part.tokens);
      return {
        ...next,
        cost: cost === undefined ? next.cost : (next.cost ?? 0) + cost,
        tokens: tokens === undefined ? next.tokens : (next.tokens ?? 0) + tokens,
      };
    }
    case "tool_use":
      return applyTool(next, v);
    case "error": {
      const message = openCodeError(v);
      return {
        ...next,
        isError: true,
        text: next.text.trim().length > 0 ? next.text : message ?? next.text,
      };
    }
    default:
      return next;
  }
}

function applyTool(draft: StreamDraft, v: Raw): StreamDraft {
  const part = v.part as Raw | undefined;
  if (!part || typeof part !== "object") return draft;
  const id =
    typeof part.callID === "string"
      ? part.callID
      : typeof part.id === "string"
        ? part.id
        : null;
  if (!id) return draft;

  const name = typeof part.tool === "string" ? part.tool : "tool";
  const state = (part.state ?? {}) as Raw;
  const status = toolStatus(state.status);
  const hasGodotTools =
    draft.hasGodotTools || /godot[-_]?vibe[-_]?os/i.test(name);

  const existing = draft.activities.findIndex((a) => a.id === id);
  if (existing === -1) {
    const activity: ToolActivity = {
      id,
      toolUseId: id,
      name,
      friendlyLabel: openCodeToolLabel(name),
      status,
      input: state.input,
      startedAt: Date.now(),
      ...(status === "running"
        ? {}
        : {
            resultText: toolResult(state),
            ...activityRawResult(name, state),
            endedAt: Date.now(),
          }),
    };
    return { ...draft, activities: [...draft.activities, activity], hasGodotTools };
  }

  if (status === "running") return { ...draft, hasGodotTools };
  const resolved: ToolActivity = {
    ...draft.activities[existing],
    status,
    resultText: toolResult(state),
    ...activityRawResult(name, state),
    endedAt: Date.now(),
  };
  return {
    ...draft,
    activities: draft.activities.map((a, i) => (i === existing ? resolved : a)),
    hasGodotTools,
  };
}

function activityRawResult(name: string, state: Raw) {
  if (!shouldRetainGodotRawResult(name)) return {};
  return boundMcpResultText(
    typeof state.output === "string" ? state.output : undefined,
  );
}

function toolStatus(status: unknown): ToolActivity["status"] {
  if (typeof status !== "string") return "running";
  if (/error|fail/i.test(status)) return "error";
  if (/complete|success|done/i.test(status)) return "ok";
  return "running";
}

function toolResult(state: Raw): string | undefined {
  const error = state.error;
  if (typeof error === "string" && error.trim()) return short(error);
  return short(state.output);
}

/** Sum one step's token bucket the same way the Rust capture does. */
function tokenTotal(tokens: unknown): number | undefined {
  if (!tokens || typeof tokens !== "object") return undefined;
  const t = tokens as Raw;
  let total = 0;
  for (const key of ["input", "output", "reasoning"]) {
    const n = t[key];
    if (typeof n === "number" && Number.isFinite(n)) total += n;
  }
  const cache = t.cache;
  if (cache && typeof cache === "object") {
    for (const key of ["read", "write"]) {
      const n = (cache as Raw)[key];
      if (typeof n === "number" && Number.isFinite(n)) total += n;
    }
  }
  return total > 0 ? total : undefined;
}

function openCodeError(v: Raw): string | undefined {
  const error = v.error;
  if (!error || typeof error !== "object") return undefined;
  const e = error as Raw;
  if (typeof e.data?.message === "string") return e.data.message;
  if (typeof e.name === "string") return e.name;
  return undefined;
}

/** Keep a short, single-line summary for the chip tooltip. */
function short(text: unknown): string | undefined {
  if (typeof text !== "string") return undefined;
  const trimmed = text.replace(/\s+/g, " ").trim();
  if (!trimmed) return undefined;
  return trimmed.length > 200 ? trimmed.slice(0, 200) + "…" : trimmed;
}
