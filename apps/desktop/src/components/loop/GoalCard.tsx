import { useEffect, useRef, useState } from "react";
import { useChatStore } from "@/stores/useChatStore";
import { useLoopStore } from "@/stores/useLoopStore";
import { useAttachmentsStore } from "@/stores/useAttachmentsStore";
import { useSettingsStore } from "@/stores/useSettingsStore";
import { useResourceDnd } from "@/hooks/useResourceDnd";
import { useCliInstallActive } from "@/hooks/useOnboarding";
import AttachmentChip from "@/components/chat/AttachmentChip";
import { DEFAULT_LOOP_OPTIONS } from "@/types/loop";
import { BACKENDS } from "@/types/settings";
import type { AgentRunOptions } from "@/types/agent";
import { runOptionsFromSettings } from "@/lib/agentOptions";
import { runOptionsSummary } from "@/lib/modelCatalog";
import AgentRunControls from "@/components/agent/AgentRunControls";

/**
 * Auto-mode entry point: describe a goal, optionally attach reference images,
 * tweak the budget under "Advanced", and start the loop. Reuses the shared
 * attachments store + drag-drop so reference images work exactly like chat.
 */
export default function GoalCard() {
  const project = useChatStore((s) => s.project);
  const start = useLoopStore((s) => s.start);
  const starting = useLoopStore((s) => s.starting);
  const error = useLoopStore((s) => s.error);
  const cliInstalling = useCliInstallActive();

  const attachments = useAttachmentsStore((s) => s.items);
  const removeAttachment = useAttachmentsStore((s) => s.remove);
  const clearAttachments = useAttachmentsStore((s) => s.clear);
  const settings = useSettingsStore((s) => s.settings);

  const [goal, setGoal] = useState("");
  const [maxIterations, setMaxIterations] = useState(
    DEFAULT_LOOP_OPTIONS.maxIterations,
  );
  const [maxCostUsd, setMaxCostUsd] = useState(DEFAULT_LOOP_OPTIONS.maxCostUsd);
  const [qaEnabled, setQaEnabled] = useState(true);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [runOptions, setRunOptions] = useState<AgentRunOptions>(() =>
    settings ? runOptionsFromSettings(settings) : DEFAULT_LOOP_OPTIONS.agent,
  );

  useEffect(() => {
    if (settings) setRunOptions(runOptionsFromSettings(settings));
  }, [
    settings?.agentBackend,
    settings?.model,
    settings?.codexModel,
    settings?.effort,
    settings?.codexEffort,
  ]);

  const backend = BACKENDS[runOptions.backend];
  const agentLabel = backend.label;

  const regionRef = useRef<HTMLDivElement>(null);
  const dragActive = useResourceDnd(project, regionRef);

  const images = attachments.filter((a) => a.kind === "image");
  const canStart =
    goal.trim().length > 0 && !starting && !cliInstalling && !!project;

  function onStart() {
    if (!canStart || !project) return;
    void start(project, goal.trim(), {
      maxIterations,
      maxCostUsd: backend.reportsCost ? maxCostUsd : 0,
      qaEvery: qaEnabled ? 1 : 0,
      referenceImages: images.map((a) => a.path),
      agent: runOptions,
    });
    clearAttachments();
  }

  return (
    <div
      ref={regionRef}
      className="glass-card relative mx-auto flex w-full max-w-2xl flex-col gap-5 rounded-3xl border p-6"
    >
      <div>
        <h2 className="text-lg font-semibold text-fg">Auto mode</h2>
        <p className="mt-1 text-sm text-fg-muted">
          Describe what you want, and {agentLabel} will build it step by step —
          checking its own work and committing after each step. You can stop
          any time.
        </p>
      </div>

      <textarea
        value={goal}
        onChange={(e) => setGoal(e.target.value)}
        rows={5}
        placeholder="What should we build? e.g. “A main menu with Play and Quit buttons that loads the first level.”"
        className="selectable w-full resize-none rounded-xl border border-white/10 bg-black/25 px-4 py-3 text-sm text-fg placeholder:text-fg-dim transition-colors duration-150 focus:border-accent/40 focus:bg-black/35 focus:outline-none"
      />

      {images.length > 0 && (
        <div>
          <p className="mb-1.5 text-xs text-fg-dim">Reference images</p>
          <div className="flex flex-wrap gap-1.5">
            {images.map((a) => (
              <AttachmentChip
                key={a.id}
                attachment={a}
                onRemove={(id) => void removeAttachment(id)}
              />
            ))}
          </div>
        </div>
      )}

      <div className="rounded-xl border border-white/10 bg-black/20">
        <button
          onClick={() => setAdvancedOpen((v) => !v)}
          aria-expanded={advancedOpen}
          aria-controls="auto-advanced-controls"
          className="flex w-full items-center justify-between px-4 py-2.5 text-sm text-fg-muted transition-colors duration-150 hover:text-fg"
        >
          <span className="min-w-0 text-left">
            <span className="block">Advanced</span>
            <span className="block truncate text-[11px] text-fg-dim">
              {runOptionsSummary(runOptions)}
            </span>
          </span>
          <span className="text-fg-dim">{advancedOpen ? "−" : "+"}</span>
        </button>
        {advancedOpen && (
          <div
            id="auto-advanced-controls"
            className="flex flex-col gap-4 border-t border-ink-700 px-4 py-4"
          >
            <div>
              <p className="mb-2 text-xs font-medium uppercase tracking-wide text-fg-dim">
                {agentLabel} for this task
              </p>
              <AgentRunControls
                value={runOptions}
                onChange={setRunOptions}
                disabled={starting}
              />
            </div>
            <div className="border-t border-white/5" />
            <NumberRow
              label="Max steps"
              hint="Stops after this many iterations."
              value={maxIterations}
              min={1}
              max={50}
              step={1}
              onChange={setMaxIterations}
            />
            {backend.reportsCost && (
              <NumberRow
                label="Budget ($)"
                hint="Stops when spend reaches this."
                value={maxCostUsd}
                min={0.5}
                max={100}
                step={0.5}
                onChange={setMaxCostUsd}
              />
            )}
            <label className="flex items-center justify-between">
              <span className="text-sm text-fg">
                Review the result before finishing
                <span className="block text-xs text-fg-dim">
                  A strict QA pass checks the work against your goal.
                </span>
              </span>
              <input
                type="checkbox"
                checked={qaEnabled}
                onChange={(e) => setQaEnabled(e.target.checked)}
                className="h-4 w-4 accent-accent"
              />
            </label>
          </div>
        )}
      </div>

      {error && (
        <p className="rounded-lg bg-danger/10 px-3 py-2 text-sm text-danger">
          {error}
        </p>
      )}

      <button
        onClick={onStart}
        disabled={!canStart}
        className="rounded-xl bg-accent px-5 py-3 text-sm font-semibold text-white transition-colors duration-150 hover:bg-accent-hover disabled:opacity-40"
      >
        {starting ? "Starting…" : "Start building"}
      </button>

      {dragActive && (
        <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center rounded-2xl border-2 border-dashed border-accent/70 bg-ink-950/70 backdrop-blur-sm">
          <span className="text-sm font-medium text-fg">
            Drop reference images…
          </span>
        </div>
      )}
    </div>
  );
}

function NumberRow({
  label,
  hint,
  value,
  min,
  max,
  step,
  onChange,
}: {
  label: string;
  hint: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (v: number) => void;
}) {
  return (
    <label className="flex items-center justify-between gap-3">
      <span className="text-sm text-fg">
        {label}
        <span className="block text-xs text-fg-dim">{hint}</span>
      </span>
      <input
        type="number"
        value={value}
        min={min}
        max={max}
        step={step}
        onChange={(e) => {
          const n = Number(e.target.value);
          if (!Number.isNaN(n)) onChange(Math.min(max, Math.max(min, n)));
        }}
        className="w-24 rounded-lg border border-ink-700 bg-ink-850 px-2.5 py-1.5 text-right text-sm text-fg focus:border-ink-600 focus:outline-none"
      />
    </label>
  );
}
