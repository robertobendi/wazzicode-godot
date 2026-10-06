/** A labelled on/off switch row, the settings dialog's one toggle style. */
export default function Toggle({
  label,
  hint,
  checked,
  onChange,
}: {
  label: string;
  hint: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <button
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      className="mt-3 flex w-full items-start justify-between gap-3 text-left"
    >
      <span>
        <span className="block text-sm text-fg">{label}</span>
        <span className="block text-xs text-fg-dim">{hint}</span>
      </span>
      <span
        className={`mt-0.5 h-5 w-9 shrink-0 rounded-full p-0.5 transition-colors duration-150 ${
          checked ? "bg-accent" : "bg-ink-700"
        }`}
      >
        <span
          className={`block h-4 w-4 rounded-full transition-transform duration-150 ${
            checked ? "translate-x-4 bg-ink-950" : "translate-x-0 bg-fg-dim"
          }`}
        />
      </span>
    </button>
  );
}
