import { useChatStore } from "@/stores/useChatStore";
import { useStatusStore } from "@/stores/useStatusStore";

/**
 * Non-blocking banner shown when Godot drops out mid-run.
 */
export default function ConnectionBanner() {
  const running = useChatStore((s) => s.running);
  const state = useStatusStore((s) => s.status.state);

  if (!running) return null;

  const message =
    state === "identity_mismatch"
      ? "A different Godot project is open. Open this project in Godot so the task can continue."
      : state === "disconnected"
        ? "Godot disconnected. Open this project in Godot; the task will retry when it reconnects."
        : null;
  if (!message) return null;

  return (
    <div
      role="status"
      aria-live="polite"
      className="mx-3 mt-2 animate-appear rounded-xl border border-warning/20 bg-warning/10 px-4 py-2 text-center text-xs text-warning backdrop-blur-xl"
    >
      {message}
    </div>
  );
}
