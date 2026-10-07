import { useCallback, useEffect, useState } from "react";
import { api, pickFolder } from "@/api";
import { useSettingsStore } from "@/stores/useSettingsStore";
import { useToastStore } from "@/stores/useToastStore";
import type { PyriteSource, PyriteStatus } from "@/types/companions";
import Toggle from "./Toggle";

const SOURCE_LABEL: Record<PyriteSource, string> = {
  linked: "linked",
  env: "from PYRITE_MCP",
  discovered: "found automatically",
};

/**
 * Pyrite, the AI block modeler, as a companion to the engine tools. When it is
 * installed, agent runs get its MCP server and can generate, refine and export
 * 3D models straight into the project. Found automatically from Pyrite's own
 * registration; linking a folder by hand wins over that.
 */
export default function PyritePanel({ disabled }: { disabled: boolean }) {
  const settings = useSettingsStore((s) => s.settings);
  const update = useSettingsStore((s) => s.update);
  const showToast = useToastStore((s) => s.show);
  const [status, setStatus] = useState<PyriteStatus | null>(null);
  const [checking, setChecking] = useState(true);
  const [opening, setOpening] = useState(false);

  const check = useCallback(async () => {
    setChecking(true);
    try {
      setStatus(await api.pyriteStatus());
    } catch (e) {
      setStatus(null);
      showToast(String(e));
    } finally {
      setChecking(false);
    }
  }, [showToast]);

  const pyritePath = settings?.pyritePath ?? null;
  useEffect(() => {
    void check();
  }, [check, pyritePath]);

  async function link() {
    const folder = await pickFolder("Pick your Pyrite folder");
    if (folder) await update({ pyritePath: folder });
  }

  async function open() {
    setOpening(true);
    try {
      await api.pyriteOpen();
      showToast("Opening Pyrite…");
    } catch (e) {
      showToast(String(e));
    } finally {
      setOpening(false);
    }
  }

  if (!settings) return null;

  const found = status?.found ?? false;
  const active = found && settings.pyriteEnabled;
  const detail = checking
    ? "Looking for Pyrite…"
    : found && status
      ? [status.version && `v${status.version}`, status.source && SOURCE_LABEL[status.source]]
          .filter(Boolean)
          .join(" · ")
      : "Not found";

  return (
    <div className="rounded-xl border border-white/[0.08] bg-white/[0.025] p-3.5">
      <div className="flex items-center justify-between gap-3">
        <span className="min-w-0">
          <span className="flex items-center gap-2 text-sm text-fg">
            <span
              aria-hidden
              className={`h-1.5 w-1.5 shrink-0 rounded-full ${
                checking
                  ? "animate-dot-pulse bg-warning"
                  : active
                    ? "bg-success"
                    : found
                      ? "bg-fg-dim"
                      : "bg-warning"
              }`}
            />
            Pyrite
            {status?.running && (
              <span className="rounded bg-success/10 px-1.5 py-px text-[10px] font-medium text-success">
                running
              </span>
            )}
          </span>
          <span className="mt-0.5 block truncate text-xs text-fg-dim">
            {detail}
          </span>
        </span>
        {found && (
          <button
            onClick={() => void open()}
            disabled={opening}
            className="shrink-0 rounded-md bg-ink-700 px-2.5 py-1.5 text-xs font-medium text-fg transition-colors hover:bg-ink-600 disabled:opacity-50"
          >
            {opening ? "Opening…" : "Open editor"}
          </button>
        )}
      </div>

      {found && status?.script && (
        <p
          className="selectable mt-2 truncate font-mono text-[10px] text-fg-dim"
          title={status.script}
        >
          {status.script}
        </p>
      )}
      {!checking && !found && status?.problem && (
        <p className="mt-2 text-xs leading-relaxed text-fg-muted">
          {status.problem}
        </p>
      )}

      <div className="mt-3 flex flex-wrap gap-2">
        <button
          onClick={() => void link()}
          disabled={disabled}
          className="rounded-md border border-ink-700 px-2.5 py-1.5 text-xs font-medium text-fg-muted transition-colors hover:border-ink-600 hover:text-fg disabled:opacity-50"
        >
          {pyritePath ? "Change folder…" : "Link folder…"}
        </button>
        {pyritePath && (
          <button
            onClick={() => void update({ pyritePath: null })}
            disabled={disabled}
            className="rounded-md border border-ink-700 px-2.5 py-1.5 text-xs font-medium text-fg-muted transition-colors hover:border-ink-600 hover:text-fg disabled:opacity-50"
          >
            Find automatically
          </button>
        )}
        <button
          onClick={() => void check()}
          disabled={checking}
          className="rounded-md px-2 py-1.5 text-xs font-medium text-fg-dim transition-colors hover:text-fg disabled:opacity-50"
        >
          Check again
        </button>
      </div>

      {found && (
        <div className="border-t border-white/[0.07] pt-0.5 mt-3">
          <Toggle
            label="Use in tasks"
            hint="Agents can model 3D assets from a prompt or reference images and import them into this project."
            checked={settings.pyriteEnabled}
            onChange={(pyriteEnabled) => void update({ pyriteEnabled })}
          />
        </div>
      )}
    </div>
  );
}
