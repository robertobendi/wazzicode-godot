// Pure reducer over the Codex CLI's `codex exec --json` lines.
//
// The Claude half lives in `streamMapper.ts`; both fold into the SAME
// `StreamDraft`, so everything downstream (chat store, message bubble, tool
// timeline) is backend-agnostic and neither knows which CLI produced a turn.
//
// Line shapes handled:
//   {type:"thread.started", thread_id}
//   {type:"turn.started"}
//   {type:"item.started",   item:{id, type, …}}
//   {type:"item.updated",   item:{id, type, …}}
//   {type:"item.completed", item:{id, type:"agent_message", text}}
//   {type:"item.completed", item:{id, type:"command_execution", command,
//        aggregated_output, exit_code, status}}
//   {type:"item.completed", item:{id, type:"mcp_tool_call", server, tool,
//        arguments, result, error, status}}
//   {type:"item.completed", item:{id, type:"file_change", changes:[{path,kind}]}}
//   {type:"turn.completed", usage:{input_tokens, output_tokens}}
//   {type:"turn.failed",    error:{message}}
//   {type:"error",          message}
//
// Two differences from Claude worth knowing:
//
//   1. **No token-level text streaming.** Codex emits the assistant's prose as a
//      whole `agent_message` item, not as deltas. The bubble therefore fills in
//      at once rather than typing out. Tool chips still stream, so a long turn
//      shows live progress — just not word-by-word prose.
//
//   2. **No cost.** `turn.completed` carries token counts, not dollars. We record
//      tokens and leave `cost` undefined rather than reporting a fake $0.

import type { ToolActivity } from "@/types/chat";
import type { StreamDraft } from "./streamMapper";
import { codexItemLabel, codexMcpName, toolLabel } from "./toolLabels";
import {
  boundMcpResultText,
  isUnityDiagnosticActivity,
} from "./unityDiagnostics";

type Raw = Record<string, any>;

/** Item types that become a tool chip. `reasoning` is deliberately absent — it's
 *  the model's private thinking, not an action taken on the user's project. */
const ACTIVITY_ITEMS = new Set([
  "command_execution",
  "mcp_tool_call",
  "file_change",
  "patch_apply",
  "web_search",
  "todo_list",
]);

/** True if `raw` is a Codex event (vs. a Claude one). */
export function isCodexEvent(type: unknown): boolean {
  return (
    typeof type === "string" &&
    (type.startsWith("item.") ||
      type.startsWith("turn.") ||
      type.startsWith("thread.") ||
      type === "error")
  );
}

/** Fold one raw Codex line into the draft, returning a new draft. */
export function reduceCodex(draft: StreamDraft, v: Raw): StreamDraft {
  switch (v.type) {
    case "thread.started": {
      // Field name has drifted across Codex builds; accept the known spellings.
      const id = v.thread_id ?? v.session_id ?? v.id;
      return typeof id === "string" ? { ...draft, sessionId: id } : draft;
    }
    case "item.started":
    case "item.updated":
    case "item.completed":
      return applyItem(draft, v);
    case "turn.completed":
      return applyTurnCompleted(draft, v);
    case "turn.failed":
      return {
        ...draft,
        done: true,
        isError: true,
        text: draft.text || errorText(v.error) || "Codex stopped with an error.",
      };
    case "error":
      return {
        ...draft,
        isError: true,
        text: draft.text || (typeof v.message === "string" ? v.message : draft.text),
      };
    default:
      return draft;
  }
}

function applyItem(draft: StreamDraft, v: Raw): StreamDraft {
  const item = v.item as Raw | undefined;
  if (!item || typeof item.id !== "string") return draft;
  const type = typeof item.type === "string" ? item.type : "";
  const completed = v.type === "item.completed";

  // The assistant's visible answer. A turn can produce several; keep them all.
  if (type === "agent_message") {
    if (!completed || typeof item.text !== "string") return draft;
    const text = draft.text ? `${draft.text}\n\n${item.text}` : item.text;
    return { ...draft, text };
  }

  if (!ACTIVITY_ITEMS.has(type)) return draft;

  const name = activityName(item, type);
  const existing = draft.activities.findIndex((a) => a.id === item.id);

  if (existing === -1) {
    const activity: ToolActivity = {
      id: item.id,
      toolUseId: item.id,
      name,
      friendlyLabel: activityLabel(item, type),
      status: completed ? itemStatus(item) : "running",
      input: activityInput(item, type),
      startedAt: Date.now(),
      ...(completed
        ? {
            resultText: activityResult(item, type),
            ...activityRawResult(item, type, name),
            endedAt: Date.now(),
          }
        : {}),
    };
    return {
      ...draft,
      activities: [...draft.activities, activity],
      hasUnityTools: draft.hasUnityTools || isUnityCall(item, type),
    };
  }

  if (!completed) return draft; // item.updated on a chip we already show
  const resolved: ToolActivity = {
    ...draft.activities[existing],
    status: itemStatus(item),
    resultText: activityResult(item, type),
    ...activityRawResult(item, type, name),
    endedAt: Date.now(),
  };
  return {
    ...draft,
    activities: draft.activities.map((a, i) => (i === existing ? resolved : a)),
    hasUnityTools: draft.hasUnityTools || isUnityCall(item, type),
  };
}

function applyTurnCompleted(draft: StreamDraft, v: Raw): StreamDraft {
  const usage = v.usage as Raw | undefined;
  const tokens =
    usage && typeof usage === "object"
      ? num(usage.input_tokens) + num(usage.output_tokens)
      : 0;
  return {
    ...draft,
    done: true,
    // No `cost`: Codex prices nothing. Leaving it undefined is what tells the UI
    // to show tokens (or nothing) instead of a misleading "$0.00".
    tokens: tokens > 0 ? (draft.tokens ?? 0) + tokens : draft.tokens,
  };
}

function isUnityCall(item: Raw, type: string): boolean {
  return type === "mcp_tool_call" && item.server === "unity_vibe_os";
}

/** The raw tool name we store on the chip — normalized to Claude's flat form for
 *  MCP calls so both backends share one label table. */
function activityName(item: Raw, type: string): string {
  if (type === "mcp_tool_call") {
    return codexMcpName(String(item.server ?? ""), String(item.tool ?? ""));
  }
  return type;
}

function activityLabel(item: Raw, type: string): string {
  return type === "mcp_tool_call"
    ? toolLabel(activityName(item, type))
    : codexItemLabel(type);
}

/** What the chip's tooltip shows as the call's input. */
function activityInput(item: Raw, type: string): unknown {
  switch (type) {
    case "command_execution":
      return item.command;
    case "mcp_tool_call":
      return item.arguments;
    case "file_change":
      return item.changes;
    default:
      return undefined;
  }
}

/** ok / error for a completed item. Codex reports it two ways depending on the
 *  item type: a `status` string, or (for shell) a non-zero `exit_code`. */
function itemStatus(item: Raw): ToolActivity["status"] {
  if (item.error) return "error";
  if (typeof item.status === "string" && /fail|error/i.test(item.status)) {
    return "error";
  }
  if (typeof item.exit_code === "number" && item.exit_code !== 0) return "error";
  return "ok";
}

function activityResult(item: Raw, type: string): string | undefined {
  if (item.error) return short(errorText(item.error));
  switch (type) {
    case "command_execution":
      return short(item.aggregated_output);
    case "mcp_tool_call":
      return short(resultText(item.result));
    case "file_change":
      return short(
        Array.isArray(item.changes)
          ? item.changes.map((c: Raw) => c?.path).filter(Boolean).join(", ")
          : undefined,
      );
    case "web_search":
      return short(item.query);
    default:
      return undefined;
  }
}

function activityRawResult(item: Raw, type: string, name: string) {
  if (type !== "mcp_tool_call" || !isUnityDiagnosticActivity(name)) return {};
  return boundMcpResultText(resultText(item.result) ?? errorText(item.error));
}

/** An MCP result is a string, or MCP content blocks — same shape Claude uses. */
function resultText(result: unknown): string | undefined {
  if (typeof result === "string") return result;
  if (Array.isArray(result)) {
    return result
      .map((b) => (b && typeof b === "object" ? ((b as Raw).text ?? "") : ""))
      .join(" ");
  }
  if (result && typeof result === "object") {
    const content = (result as Raw).content;
    if (content !== undefined) return resultText(content);
  }
  return undefined;
}

function errorText(err: unknown): string | undefined {
  if (typeof err === "string") return err;
  if (err && typeof err === "object" && typeof (err as Raw).message === "string") {
    return (err as Raw).message;
  }
  return undefined;
}

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

/** Keep a short, single-line summary for the chip tooltip. */
function short(text: unknown): string | undefined {
  if (typeof text !== "string") return undefined;
  const trimmed = text.replace(/\s+/g, " ").trim();
  if (!trimmed) return undefined;
  return trimmed.length > 200 ? trimmed.slice(0, 200) + "…" : trimmed;
}
