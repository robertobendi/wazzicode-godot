import { useToastStore } from "@/stores/useToastStore";

/** Bottom-centered stack of brief, auto-dismissing confirmations. */
export default function ToastHost() {
  const toasts = useToastStore((s) => s.toasts);
  const dismiss = useToastStore((s) => s.dismiss);

  if (toasts.length === 0) return null;

  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-6 z-50 flex flex-col items-center gap-2">
      {toasts.map((t) => (
        <button
          key={t.id}
          onClick={() => dismiss(t.id)}
          className="glass-card pointer-events-auto animate-appear rounded-2xl border px-4 py-2.5 text-sm text-fg"
        >
          {t.message}
        </button>
      ))}
    </div>
  );
}
