// Compact token counts for the status bar / message footer.
//
// Only backends that don't price a turn report tokens (Codex). Claude reports a
// USD cost instead, so the two are never shown together.

/** 850 → "850", 1500 → "1.5k", 1_240_000 → "1.2M". */
export function formatTokens(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "0";
  if (n < 1_000) return String(Math.round(n));
  if (n < 1_000_000) {
    const k = n / 1_000;
    // 12.4k, but 124k (no misleading precision once we're past 100k).
    return `${k < 100 ? k.toFixed(1) : Math.round(k)}k`;
  }
  return `${(n / 1_000_000).toFixed(1)}M`;
}
