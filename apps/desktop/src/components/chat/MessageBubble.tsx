import { useState } from "react";
import type { ChatMessage } from "@/types/chat";
import { formatTokens } from "@/lib/formatTokens";
import ToolActivityChip from "./ToolActivityChip";
import AttachmentChip from "./AttachmentChip";

/** One chat turn: user (right, tinted block) or assistant (left, plain text). */
export default function MessageBubble({ message }: { message: ChatMessage }) {
  if (message.role === "system") {
    return (
      <div className="flex justify-center">
        <span className="rounded-full bg-ink-850 px-3 py-1 text-center text-xs text-fg-dim">
          {message.text}
        </span>
      </div>
    );
  }

  if (message.role === "user") {
    return (
      <div className="flex flex-col items-end gap-1.5">
        {message.text && (
          <div className="user-message max-w-[80%] whitespace-pre-wrap rounded-2xl rounded-br-md px-4 py-2.5 text-sm text-fg">
            {message.text}
          </div>
        )}
        {message.attachments.length > 0 && (
          <div className="flex max-w-[80%] flex-wrap justify-end gap-1.5">
            {message.attachments.map((a) => (
              <AttachmentChip key={a.id} attachment={a} compact />
            ))}
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="flex justify-start">
      <div className="w-full max-w-[65ch] space-y-2">
        {message.activities.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {message.activities.map((a) => (
              <ToolActivityChip key={a.id} activity={a} />
            ))}
          </div>
        )}

        {message.text && (
          <div className="selectable whitespace-pre-wrap text-sm leading-relaxed text-fg">
            {message.text}
            {message.streaming && (
              <span className="ml-0.5 inline-block h-4 w-[2px] animate-caret bg-accent align-text-bottom" />
            )}
          </div>
        )}

        {message.streaming && !message.text && message.activities.length === 0 && (
          <div className="flex items-center gap-2 text-sm text-fg-dim">
            <span className="h-3 w-3 animate-spin rounded-full border-[1.5px] border-fg-dim border-t-transparent" />
            Thinking…
          </div>
        )}

        {message.error && (
          <ErrorBanner text={message.error} detail={message.errorRaw} />
        )}

        {/* Claude prices a turn; Codex only counts tokens. Show whichever the
            backend actually reported — never a fabricated $0.00. */}
        {typeof message.costUsd === "number" ? (
          <div className="tabular-nums text-[11px] text-fg-dim">
            ${message.costUsd.toFixed(4)}
          </div>
        ) : typeof message.tokens === "number" && message.tokens > 0 ? (
          <div className="tabular-nums text-[11px] text-fg-dim">
            {formatTokens(message.tokens)} tokens
          </div>
        ) : null}
      </div>
    </div>
  );
}

/** Soft-red error notice with an optional raw "Details" disclosure. */
function ErrorBanner({ text, detail }: { text: string; detail?: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="rounded-xl border border-danger/25 bg-danger/10 px-3.5 py-2.5 text-sm text-danger">
      <div>{text}</div>
      {detail && (
        <>
          <button
            onClick={() => setOpen((v) => !v)}
            className="mt-1 text-xs text-danger underline-offset-2 transition-colors duration-150 hover:underline"
          >
            {open ? "Hide details" : "Details"}
          </button>
          {open && (
            <pre className="selectable mt-2 max-h-40 overflow-auto whitespace-pre-wrap break-all rounded-lg bg-ink-950/60 px-2.5 py-2 font-mono text-[11px] text-fg-dim">
              {detail}
            </pre>
          )}
        </>
      )}
    </div>
  );
}
