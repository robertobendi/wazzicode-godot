/**
 * Theme management. The resolved scheme is a class on `<html>` — the same
 * `.theme-dark` / `.theme-light` convention Hightower uses, so the CSS
 * variables in `:root` vs `.theme-light` cascade through the whole app.
 *
 * Foundry adds a third choice on top: "system" follows the OS.
 */

import type { ThemeChoice } from "@/types/settings";

export type ResolvedTheme = "light" | "dark";

const KEY = "foundry:theme";

export function resolveTheme(
  choice: ThemeChoice,
  prefersDark: boolean,
): ResolvedTheme {
  if (choice === "system") return prefersDark ? "dark" : "light";
  return choice;
}

export function applyTheme(theme: ResolvedTheme) {
  const html = document.documentElement;
  html.classList.toggle("theme-light", theme === "light");
  html.classList.toggle("theme-dark", theme === "dark");
  try {
    localStorage.setItem(KEY, theme);
  } catch {
    // A blocked storage backend only costs the pre-load paint below.
  }
}

/**
 * Paint the last resolved scheme before settings load, so the palette never
 * flashes on launch. Dark is the default, matching the rest of the suite.
 */
export function primeTheme() {
  let cached: string | null = null;
  try {
    cached = localStorage.getItem(KEY);
  } catch {
    cached = null;
  }
  applyTheme(cached === "light" ? "light" : "dark");
}
