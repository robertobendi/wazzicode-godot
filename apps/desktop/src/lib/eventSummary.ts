// One-line, human-readable summary of a raw agent stream event, for the debug
// drawer. Handles BOTH backends' vocabularies (see `streamMapper.ts` — the two
// are disjoint, so the event's own `type` is enough to tell them apart).
//
// The drawer exists to answer "what is the agent actually doing to my Unity
// project, and what broke?" — so the summary leads with the MCP tool call and
// its outcome, which a raw JSON dump buries.

export type EventLevel = "info" | "text" | "tool" | "error";

export interface EventSummary {
  /** Short label, e.g. `unity_verify` or `turn.completed`. */
  label: string;
  /** Optional extra context — args, exit code, error text. */
  detail?: string;
  level: EventLevel;
}

type Raw = Record<string, any>;

/** Strip the MCP prefix so `mcp__unity-vibe-os__unity_verify` reads `unity_verify`. */
function shortToolName(name: string): string {
  return name.replace(/^mcp__[^_]*(?:-[^_]*)*__/, "").replace(/^mcp__/, "");
}

function clip(s: string, n = 120): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > n ? t.slice(0, n) + "…" : t;
}

function stringify(v: unknown): string | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v === "string") return clip(v);
  try {
    return clip(JSON.stringify(v));
  } catch {
    return undefined;
  }
}

export function summarizeEvent(payload: unknown): EventSummary {
  if (typeof payload === "string") {
    return { label: "raw", detail: clip(payload), level: "info" };
  }
  if (!payload || typeof payload !== "object") {
    return { label: "unknown", level: "info" };
  }
  const v = payload as Raw;
  const type = typeof v.type === "string" ? v.type : "";

  // ---- Codex ----
  if (type.startsWith("thread.") || type.startsWith("turn.") || type.startsWith("item.")) {
    return summarizeCodex(type, v);
  }

  // ---- Claude ----
  switch (type) {
    case "system":
      return {
        label: `system/${v.subtype ?? "?"}`,
        detail: Array.isArray(v.tools) ? `${v.tools.length} tools` : undefined,
        level: "info",
      };
    case "assistant": {
      const blocks: Raw[] = Array.isArray(v.message?.content) ? v.message.content : [];
      const tool = blocks.find((b) => b?.type === "tool_use");
      if (tool) {
        return {
          label: shortToolName(String(tool.name ?? "tool")),
          detail: stringify(tool.input),
          level: "tool",
        };
      }
      const text = blocks.find((b) => b?.type === "text");
      return { label: "assistant", detail: stringify(text?.text), level: "text" };
    }
    case "user": {
      const blocks: Raw[] = Array.isArray(v.message?.content) ? v.message.content : [];
      const res = blocks.find((b) => b?.type === "tool_result");
      if (res) {
        return {
          label: res.is_error ? "tool failed" : "tool ok",
          detail: stringify(res.content),
          level: res.is_error ? "error" : "tool",
        };
      }
      return { label: "user", level: "info" };
    }
    case "result":
      return {
        label: v.is_error ? "result (error)" : "result",
        detail:
          typeof v.total_cost_usd === "number"
            ? `$${v.total_cost_usd.toFixed(4)}`
            : undefined,
        level: v.is_error ? "error" : "info",
      };
    case "stream_event":
      // Token deltas are far too chatty to summarize individually.
      return { label: "delta", level: "text" };
    case "error":
      return { label: "error", detail: stringify(v.message), level: "error" };
    default:
      return { label: type || "event", level: "info" };
  }
}

function summarizeCodex(type: string, v: Raw): EventSummary {
  if (type === "thread.started") {
    return {
      label: "thread.started",
      detail: stringify(v.thread_id ?? v.session_id ?? v.id),
      level: "info",
    };
  }
  if (type === "turn.completed") {
    const u = v.usage as Raw | undefined;
    const tokens =
      u && typeof u === "object"
        ? (Number(u.input_tokens) || 0) + (Number(u.output_tokens) || 0)
        : 0;
    return {
      label: "turn.completed",
      detail: tokens > 0 ? `${tokens} tokens` : undefined,
      level: "info",
    };
  }
  if (type === "turn.failed") {
    return {
      label: "turn.failed",
      detail: stringify(v.error?.message ?? v.error),
      level: "error",
    };
  }
  if (!type.startsWith("item.")) {
    return { label: type, level: "info" };
  }

  const item = (v.item ?? {}) as Raw;
  const itemType = typeof item.type === "string" ? item.type : "item";
  const phase = type.slice("item.".length); // started | updated | completed
  const failed =
    Boolean(item.error) ||
    (typeof item.exit_code === "number" && item.exit_code !== 0) ||
    (typeof item.status === "string" && /fail|error/i.test(item.status));

  switch (itemType) {
    case "agent_message":
      return { label: "agent_message", detail: stringify(item.text), level: "text" };
    case "reasoning":
      return { label: "reasoning", detail: stringify(item.text), level: "text" };
    case "mcp_tool_call": {
      const tool = `${item.tool ?? "?"}`;
      const detail =
        phase === "completed"
          ? stringify(item.error ?? item.result)
          : stringify(item.arguments);
      return {
        label: failed ? `${tool} (failed)` : tool,
        detail,
        level: failed ? "error" : "tool",
      };
    }
    case "command_execution": {
      const detail =
        phase === "completed"
          ? stringify(item.aggregated_output)
          : stringify(item.command);
      const code =
        typeof item.exit_code === "number" ? ` exit ${item.exit_code}` : "";
      return {
        label: `shell${code}`,
        detail,
        level: failed ? "error" : "tool",
      };
    }
    case "file_change": {
      const paths = Array.isArray(item.changes)
        ? item.changes.map((c: Raw) => c?.path).filter(Boolean).join(", ")
        : undefined;
      return { label: "file_change", detail: stringify(paths), level: "tool" };
    }
    case "error":
      return { label: "error", detail: stringify(item.message), level: "error" };
    default:
      return { label: `${itemType}.${phase}`, level: "info" };
  }
}
