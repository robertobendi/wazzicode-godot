// Shared building blocks for the onboarding wizard steps. Styled to match
// PairingScreen (numbered progress dots, one card per step, design tokens).

import type { ReactNode } from "react";
import Logo from "@/components/shell/Logo";

export const STEP_LABELS = ["Agent", "Project", "Set up", "Connect", "Ready"];

export function Stepper({ current }: { current: number }) {
  const progress = ((current + 1) / STEP_LABELS.length) * 100;
  return (
    <div className="mb-8">
      <div className="mb-3 flex items-center justify-between text-[11px] font-medium uppercase tracking-[0.14em]">
        <span className="text-fg-dim">Setup</span>
        <span className="text-fg-muted">
          {String(current + 1).padStart(2, "0")} / {String(STEP_LABELS.length).padStart(2, "0")}
          <span className="mx-2 text-fg-dim">·</span>
          {STEP_LABELS[current]}
        </span>
      </div>
      <div className="setup-progress">
        <span style={{ width: `${progress}%` }} />
      </div>
    </div>
  );
}

export function StepHeading({
  title,
  children,
}: {
  title: string;
  children?: ReactNode;
}) {
  return (
    <div>
      <div className="identity-mark">
        <Logo size={26} />
      </div>
      <h1 className="text-2xl font-semibold tracking-tight text-fg">{title}</h1>
      {children && <p className="mt-2 text-sm leading-relaxed text-fg-muted">{children}</p>}
    </div>
  );
}

export function PrimaryButton({
  onClick,
  disabled,
  busy,
  children,
}: {
  onClick: () => void;
  disabled?: boolean;
  busy?: boolean;
  children: ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled || busy}
      className="flex w-full items-center justify-center gap-2 rounded-xl bg-accent px-4 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-accent-hover disabled:opacity-60"
    >
      {busy ? (
        <>
          <Spinner /> Working…
        </>
      ) : (
        children
      )}
    </button>
  );
}

export function SecondaryButton({
  onClick,
  children,
}: {
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className="rounded-xl border border-white/10 bg-white/[0.045] px-4 py-2.5 text-sm font-medium text-fg transition-colors hover:bg-white/[0.08]"
    >
      {children}
    </button>
  );
}

/** A quiet mono box that tails process output (installer / setup lines). */
export function ProgressLog({ lines }: { lines: string[] }) {
  if (lines.length === 0) return null;
  return (
    <pre className="selectable mt-4 max-h-40 overflow-auto rounded-lg border border-white/10 bg-ink-900 p-3 text-[11px] leading-relaxed text-fg-dim">
      {lines.join("\n")}
    </pre>
  );
}

export function Spinner({ large }: { large?: boolean }) {
  const size = large ? "h-8 w-8 border-[3px]" : "h-4 w-4 border-2";
  return (
    <span
      className={`inline-block ${size} animate-spin rounded-full border-ink-700 border-t-fg-muted`}
      aria-hidden
    />
  );
}

export function Pill({ ok, children }: { ok: boolean; children: ReactNode }) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs ${
        ok
          ? "border-success/40 text-success"
          : "border-ink-700 text-fg-muted"
      }`}
    >
      <span className={`h-1.5 w-1.5 rounded-full ${ok ? "bg-success" : "bg-fg-dim"}`} />
      {children}
    </span>
  );
}
