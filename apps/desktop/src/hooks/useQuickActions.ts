import { useEffect, useState } from "react";
import { api } from "@/api";
import {
  DEFAULT_QUICK_ACTIONS,
  coerceQuickActions,
  type QuickAction,
} from "@/lib/quickActions";

/**
 * The effective quick actions for `project`: the built-in defaults, replaced by
 * a valid `.unity-vibe/quick_actions.json` override if the project has one.
 * Renders defaults instantly, then swaps in the backend result once it arrives.
 */
export function useQuickActions(project: string | null): QuickAction[] {
  const [actions, setActions] = useState<QuickAction[]>(DEFAULT_QUICK_ACTIONS);

  useEffect(() => {
    if (!project) {
      setActions(DEFAULT_QUICK_ACTIONS);
      return;
    }
    let alive = true;
    void api
      .readQuickActions(project)
      .then((r) => {
        if (alive) setActions(coerceQuickActions(r));
      })
      .catch(() => {
        if (alive) setActions(DEFAULT_QUICK_ACTIONS);
      });
    return () => {
      alive = false;
    };
  }, [project]);

  return actions;
}
