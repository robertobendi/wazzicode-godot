// The one control that chooses which agent drives the app. Shared by the
// settings popover and the onboarding wizard so the two never drift apart —
// all copy comes from BACKENDS, never from a hardcoded product name.

import { BACKENDS, type AgentBackend } from "@/types/settings";

const ORDER: AgentBackend[] = ["claude", "codex"];

export default function BackendPicker({
  value,
  onChange,
  showBlurb = false,
  disabled = false,
}: {
  value: AgentBackend;
  onChange: (backend: AgentBackend) => void;
  /** Include each backend's one-line description (roomier surfaces only). */
  showBlurb?: boolean;
  disabled?: boolean;
}) {
  function onKeyDown(
    event: React.KeyboardEvent<HTMLButtonElement>,
    current: AgentBackend,
  ) {
    const index = ORDER.indexOf(current);
    let next = index;
    if (event.key === "ArrowRight" || event.key === "ArrowDown") {
      next = (index + 1) % ORDER.length;
    } else if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
      next = (index - 1 + ORDER.length) % ORDER.length;
    } else if (event.key === "Home") {
      next = 0;
    } else if (event.key === "End") {
      next = ORDER.length - 1;
    } else {
      return;
    }
    event.preventDefault();
    const backend = ORDER[next];
    const group = event.currentTarget.parentElement;
    onChange(backend);
    requestAnimationFrame(() => {
      group
        ?.querySelector<HTMLButtonElement>(`[data-backend="${backend}"]`)
        ?.focus();
    });
  }

  return (
    <div
      role="radiogroup"
      aria-label="Agent"
      className={showBlurb ? "grid gap-2" : "flex gap-1 rounded-lg bg-ink-900 p-1"}
    >
      {ORDER.map((backend) => {
        const meta = BACKENDS[backend];
        const selected = backend === value;

        if (showBlurb) {
          return (
            <button
              key={backend}
              role="radio"
              aria-checked={selected}
              data-backend={backend}
              tabIndex={selected ? 0 : -1}
              disabled={disabled}
              onClick={() => onChange(backend)}
              onKeyDown={(event) => onKeyDown(event, backend)}
              className={`provider-card rounded-xl border px-4 py-3 text-left transition-colors duration-150 disabled:cursor-not-allowed disabled:opacity-50 ${
                selected
                  ? "border-accent bg-accent/5"
                  : "border-ink-700 bg-ink-900 hover:border-ink-600"
              }`}
            >
              <span className="flex items-center gap-2">
                <span
                  className={`flex h-4 w-4 shrink-0 items-center justify-center rounded-full border ${
                    selected ? "border-accent" : "border-ink-600"
                  }`}
                >
                  {selected && (
                    <span className="h-2 w-2 rounded-full bg-accent" />
                  )}
                </span>
                <span className="text-sm font-medium text-fg">{meta.label}</span>
              </span>
              <span className="mt-1 block pl-6 text-xs leading-relaxed text-fg-dim">
                {meta.blurb}
              </span>
            </button>
          );
        }

        return (
          <button
            key={backend}
            role="radio"
            aria-checked={selected}
            data-backend={backend}
            tabIndex={selected ? 0 : -1}
            disabled={disabled}
            onClick={() => onChange(backend)}
            onKeyDown={(event) => onKeyDown(event, backend)}
            className={`flex-1 rounded-md px-2.5 py-1.5 text-xs font-medium transition-colors duration-150 disabled:cursor-not-allowed disabled:opacity-50 ${
              selected
                ? "bg-accent text-white"
                : "text-fg-muted hover:bg-ink-800 hover:text-fg"
            }`}
          >
            {meta.label}
          </button>
        );
      })}
    </div>
  );
}
