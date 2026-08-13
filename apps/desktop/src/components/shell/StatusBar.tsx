import { useChatStore } from "@/stores/useChatStore";
import { useStatusStore } from "@/stores/useStatusStore";
import { formatTokens } from "@/lib/formatTokens";
import type { BridgeState } from "@/types/status";

/** Bottom bar: Unity connection pill + running session cost (or tokens, on a
 *  backend that doesn't price its turns — see `formatTokens`). */
export default function StatusBar() {
  const status = useStatusStore((s) => s.status);
  const running = useChatStore((s) => s.running);
  const totalCost = useChatStore((s) => s.session.totalCostUsd);
  const totalTokens = useChatStore((s) => s.session.totalTokens);

  const label = status.compiling
    ? "Unity is recompiling — hang on…"
    : status.playMode
      ? "Playing"
      : status.state === "connected" && !running
        ? "Ready — tell me what you want to change"
        : status.friendly;

  return (
    <footer className="glass-bar mx-3 mb-2 flex h-8 shrink-0 items-center justify-between rounded-xl border px-4 text-xs text-fg-dim">
      <div className="flex items-center gap-2">
        <span className={`h-2 w-2 rounded-full ${dotColor(status.state)}`} />
        <span className="text-fg-muted">{label}</span>
      </div>
      {totalCost > 0 ? (
        <span className="tabular-nums">Session ${totalCost.toFixed(4)}</span>
      ) : totalTokens > 0 ? (
        <span className="tabular-nums">
          Session {formatTokens(totalTokens)} tokens
        </span>
      ) : null}
    </footer>
  );
}

function dotColor(state: BridgeState): string {
  switch (state) {
    case "connected":
      return "bg-success";
    case "reloading":
      return "bg-warning animate-dot-pulse";
    case "identity_mismatch":
      return "bg-warning";
    case "disconnected":
    default:
      return "bg-danger";
  }
}
