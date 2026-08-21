import { useEffect } from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { useToastStore } from "@/stores/useToastStore";

interface SelfHealReport {
  project: string;
  repaired: string[];
}

/**
 * Surface what opening a project had to repair.
 *
 * Studio brings a project's install back in line with the running build when it opens (Editor
 * package, agent instructions, `.mcp.json`). That is deliberately automatic — but silently
 * rewriting files in someone's game repo is not, so anything it changed is announced once.
 * Nothing is emitted when the install was already current.
 */
export function useProjectSelfHeal() {
  useEffect(() => {
    let unlisten: UnlistenFn | undefined;
    let cancelled = false;
    void listen<SelfHealReport>("project:self-heal", (event) => {
      const { repaired } = event.payload;
      if (repaired.length === 0) return;
      useToastStore.getState().show(`Brought this project up to date — ${repaired.join("; ")}.`);
    }).then((u) => {
      if (cancelled) u();
      else unlisten = u;
    });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);
}
