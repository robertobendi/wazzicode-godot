import type { ThemeChoice } from "@/types/settings";

const ORDER: ThemeChoice[] = ["system", "light", "dark"];
const LABELS: Record<ThemeChoice, string> = {
  system: "System",
  light: "Light",
  dark: "Dark",
};

export default function ThemePicker({
  value,
  onChange,
}: {
  value: ThemeChoice;
  onChange: (theme: ThemeChoice) => void;
}) {
  function onKeyDown(
    event: React.KeyboardEvent<HTMLButtonElement>,
    current: ThemeChoice,
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
    const theme = ORDER[next];
    const group = event.currentTarget.parentElement;
    onChange(theme);
    requestAnimationFrame(() => {
      group?.querySelector<HTMLButtonElement>(`[data-choice="${theme}"]`)?.focus();
    });
  }

  return (
    <div
      role="radiogroup"
      aria-label="Appearance"
      className="flex gap-1 rounded-lg bg-ink-900 p-1"
    >
      {ORDER.map((theme) => {
        const selected = theme === value;
        return (
          <button
            key={theme}
            role="radio"
            aria-checked={selected}
            data-choice={theme}
            tabIndex={selected ? 0 : -1}
            onClick={() => onChange(theme)}
            onKeyDown={(event) => onKeyDown(event, theme)}
            className={`flex-1 rounded-md px-2.5 py-1.5 text-xs font-medium transition-colors duration-150 ${
              selected
                ? "bg-accent text-white"
                : "text-fg-muted hover:bg-ink-800 hover:text-fg"
            }`}
          >
            {LABELS[theme]}
          </button>
        );
      })}
    </div>
  );
}
