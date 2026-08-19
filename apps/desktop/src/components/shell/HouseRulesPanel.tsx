import { useEffect, useState } from "react";
import { api } from "@/api";
import type { HouseRule, HouseRules } from "@/types/settings";

/**
 * House rules editor: the standing instructions appended to the end of every
 * prompt, in chat and in auto mode.
 *
 * The catalog (labels, hints, and the exact text each rule sends) comes from
 * Rust, which also does the appending — so what this panel shows is what the
 * agent gets, with no second copy of the wording in the webview.
 */
export default function HouseRulesPanel({
  value,
  onChange,
}: {
  value: HouseRules;
  onChange: (next: HouseRules) => void;
}) {
  const [catalog, setCatalog] = useState<HouseRule[] | null>(null);

  useEffect(() => {
    let alive = true;
    void api
      .houseRuleCatalog()
      .then((rules) => alive && setCatalog(rules))
      .catch(() => alive && setCatalog([]));
    return () => {
      alive = false;
    };
  }, []);

  if (!catalog) return null;
  if (catalog.length === 0) {
    return (
      <p className="text-xs leading-relaxed text-fg-dim">
        The rule list could not be loaded.
      </p>
    );
  }

  const enabled = new Set(value.enabled);
  const recommended = catalog.filter((r) => r.defaultOn).map((r) => r.id);
  const isRecommended =
    enabled.size === recommended.length && recommended.every((id) => enabled.has(id));

  function toggle(id: string) {
    const next = new Set(value.enabled);
    if (!next.delete(id)) next.add(id);
    onChange({ ...value, enabled: [...next] });
  }

  const active = catalog.filter((rule) => enabled.has(rule.id));

  return (
    <div>
      <div className="space-y-0.5">
        {catalog.map((rule) => {
          const on = enabled.has(rule.id);
          return (
            <button
              key={rule.id}
              role="switch"
              aria-checked={on}
              onClick={() => toggle(rule.id)}
              title={rule.text}
              className="flex w-full items-start gap-2.5 rounded-lg px-2 py-1.5 text-left hover:bg-white/[0.04]"
            >
              <span
                aria-hidden
                className={`mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded border text-[10px] font-bold leading-none transition-colors duration-150 ${
                  on
                    ? "border-accent bg-accent text-white"
                    : "border-ink-600 text-transparent"
                }`}
              >
                ✓
              </span>
              <span className="min-w-0">
                <span className={`block text-sm ${on ? "text-fg" : "text-fg-muted"}`}>
                  {rule.label}
                </span>
                <span className="block text-[11px] leading-relaxed text-fg-dim">
                  {rule.hint}
                </span>
              </span>
            </button>
          );
        })}
      </div>

      <label className="mt-3 block">
        <span className="block text-xs font-medium text-fg-muted">
          Your own rules
        </span>
        <textarea
          value={value.custom}
          onChange={(e) => onChange({ ...value, custom: e.target.value })}
          rows={3}
          maxLength={2000}
          placeholder="One instruction per line…"
          className="selectable mt-1.5 w-full resize-y rounded-lg border border-white/10 bg-black/25 px-2.5 py-2 text-xs leading-relaxed text-fg placeholder:text-fg-dim focus:border-white/20 focus:outline-none"
        />
      </label>

      <div className="mt-2 flex items-center justify-between gap-3">
        <details className="min-w-0">
          <summary className="cursor-pointer text-[11px] text-fg-dim transition-colors hover:text-fg-muted">
            What gets sent ({active.length + customLineCount(value.custom)})
          </summary>
          <ul className="selectable mt-1.5 space-y-1 rounded-lg bg-black/20 p-2.5 text-[11px] leading-relaxed text-fg-muted">
            {active.map((rule) => (
              <li key={rule.id}>— {rule.text}</li>
            ))}
            {customLines(value.custom).map((line, i) => (
              <li key={`custom-${i}`}>— {line}</li>
            ))}
          </ul>
        </details>
        {!isRecommended && (
          <button
            onClick={() => onChange({ ...value, enabled: recommended })}
            className="shrink-0 text-[11px] text-fg-dim transition-colors hover:text-fg"
          >
            Reset to recommended
          </button>
        )}
      </div>
    </div>
  );
}

/** Mirrors the Rust bullet split so the preview counts what is actually sent. */
function customLines(custom: string): string[] {
  return custom
    .split("\n")
    .map((line) => line.trim().replace(/^[-*•]+/, "").trim())
    .filter(Boolean);
}

function customLineCount(custom: string): number {
  return customLines(custom).length;
}
