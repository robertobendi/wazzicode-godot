import { useEffect } from "react";
import { applyTheme, resolveTheme } from "@/lib/theme";
import type { ThemeChoice } from "@/types/settings";

/**
 * Paints the chosen scheme on `<html>`. Undefined while settings load — the
 * primed scheme stays up rather than flashing a system-resolved one first.
 */
export function useTheme(choice: ThemeChoice | undefined) {
  useEffect(() => {
    if (!choice) return;
    const query = window.matchMedia("(prefers-color-scheme: dark)");
    const paint = () => applyTheme(resolveTheme(choice, query.matches));
    paint();
    query.addEventListener("change", paint);
    return () => query.removeEventListener("change", paint);
  }, [choice]);
}
