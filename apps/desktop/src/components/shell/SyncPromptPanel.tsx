import { useSettingsStore } from "@/stores/useSettingsStore";
import type { SyncPrompt } from "@/types/settings";
import Toggle from "./Toggle";

const EMPTY: SyncPrompt = { prompt: "", enabled: false };

/**
 * The prompt Synchronize runs for the open project. Per project, because what
 * it does — repoint an API endpoint, bump a build number, regenerate a config —
 * belongs to that game, not to every project the app opens.
 */
export default function SyncPromptPanel({ project }: { project: string }) {
  const settings = useSettingsStore((s) => s.settings);
  const update = useSettingsStore((s) => s.update);
  if (!settings) return null;

  const entry = settings.syncPrompts?.[project] ?? EMPTY;
  const name = project.split(/[\\/]/).filter(Boolean).pop() ?? project;

  function save(next: SyncPrompt) {
    const syncPrompts = { ...(settings?.syncPrompts ?? {}) };
    if (!next.prompt.trim() && !next.enabled) delete syncPrompts[project];
    else syncPrompts[project] = next;
    void update({ syncPrompts });
  }

  return (
    <div className="rounded-xl border border-white/[0.07] bg-black/10 px-3.5 pb-3.5">
      <Toggle
        label="Run a prompt on Synchronize"
        hint={`For ${name}: pull, run it, then push what it changed.`}
        checked={entry.enabled}
        onChange={(enabled) => save({ ...entry, enabled })}
      />
      <label className="mt-3 block">
        <span className="sr-only">Sync prompt</span>
        <textarea
          value={entry.prompt}
          onChange={(e) =>
            save({
              prompt: e.target.value,
              // Typing the first words switches it on; clearing it does not
              // switch it off, so a half-edited prompt never silently stops.
              enabled: entry.enabled || (!entry.prompt && !!e.target.value.trim()),
            })
          }
          rows={3}
          maxLength={4000}
          placeholder="e.g. Point the API endpoint in config.gd at the staging server, then run the tests."
          className="selectable w-full resize-y rounded-lg border border-white/10 bg-black/25 px-2.5 py-2 text-xs leading-relaxed text-fg placeholder:text-fg-dim focus:border-white/20 focus:outline-none"
        />
      </label>
    </div>
  );
}
