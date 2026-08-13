import { useEffect, useRef, useState } from "react";
import { api } from "@/api";
import {
  customModelRunOptions,
  effortLabel,
  effortsForModel,
  repairRunOptions,
} from "@/lib/modelCatalog";
import type { AgentModelOption, AgentRunOptions } from "@/types/agent";

const CUSTOM = "__custom__";

export default function AgentRunControls({
  value,
  onChange,
  disabled = false,
  refreshKey = null,
}: {
  value: AgentRunOptions;
  onChange: (value: AgentRunOptions) => void;
  disabled?: boolean;
  refreshKey?: string | null;
}) {
  const [catalog, setCatalog] = useState<AgentModelOption[]>([]);
  const [catalogReady, setCatalogReady] = useState(false);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [catalogAttempt, setCatalogAttempt] = useState(0);
  const [customMode, setCustomMode] = useState(value.model !== null);
  const [customModel, setCustomModel] = useState(value.model ?? "");
  const repairKey = useRef<string | null>(null);

  useEffect(() => {
    let alive = true;
    setCatalog([]);
    setCatalogReady(false);
    setCatalogError(null);
    setCustomMode(value.model !== null);
    setCustomModel(value.model ?? "");
    repairKey.current = null;
    void api
      .agentModelCatalog(value.backend)
      .then((models) => {
        if (!alive) return;
        setCatalog(models);
        setCatalogReady(true);
      })
      .catch((error) => {
        if (!alive) return;
        setCatalogReady(true);
        setCatalogError(String(error));
      });
    return () => {
      alive = false;
    };
  }, [value.backend, refreshKey, catalogAttempt]);

  const listedModel = catalog.find((model) => model.id === value.model);

  useEffect(() => {
    if (listedModel) {
      setCustomMode(false);
    } else if (value.model) {
      setCustomMode(true);
      setCustomModel(value.model);
    }
  }, [listedModel, value.model]);

  useEffect(() => {
    if (disabled || !catalogReady || catalogError) return;
    const repaired = repairRunOptions(value, catalog);
    if (repaired.effort === value.effort && repaired.model === value.model) {
      repairKey.current = null;
      return;
    }
    const key = JSON.stringify(repaired);
    if (repairKey.current === key) return;
    repairKey.current = key;
    onChange(repaired);
  }, [catalog, catalogError, catalogReady, disabled, onChange, value]);

  const selectedModel = customMode
    ? CUSTOM
    : value.model && listedModel
      ? value.model
      : "";
  const supportedEfforts = effortsForModel(value.backend, catalog, value.model);
  const efforts =
    (catalogError || disabled) &&
    value.effort &&
    !supportedEfforts.includes(value.effort)
      ? [value.effort, ...supportedEfforts]
      : supportedEfforts;

  function chooseModel(model: string) {
    if (model === CUSTOM) {
      setCustomMode(true);
      const nextModel = listedModel ? "" : (value.model ?? "");
      setCustomModel(nextModel);
      onChange(customModelRunOptions(value, nextModel));
      return;
    }
    setCustomMode(false);
    const next = repairRunOptions(
      { ...value, model: model || null },
      catalog,
    );
    onChange(next);
  }

  return (
    <div className="space-y-3">
      <label className="block">
        <span className="text-xs font-medium text-fg-muted">Model</span>
        <select
          value={selectedModel}
          disabled={disabled}
          onChange={(event) => chooseModel(event.target.value)}
          className="mt-1 w-full rounded-lg border border-ink-700 bg-ink-900 px-2.5 py-2 text-sm text-fg focus:border-ink-600 focus:outline-none disabled:opacity-50"
        >
          <option value="">CLI-selected model</option>
          {catalog.map((model) => (
            <option key={model.id} value={model.id}>
              {model.label}
            </option>
          ))}
          <option value={CUSTOM}>Custom model…</option>
        </select>
      </label>

      {customMode && (
        <label className="block">
          <span className="sr-only">Custom model identifier</span>
          <input
            type="text"
            value={customModel}
            disabled={disabled}
            placeholder="Exact model identifier"
            spellCheck={false}
            onChange={(event) => {
              const model = event.target.value;
              setCustomModel(model);
              onChange(customModelRunOptions(value, model));
            }}
            className="selectable w-full rounded-lg border border-ink-700 bg-ink-900 px-2.5 py-2 font-mono text-xs text-fg placeholder:text-fg-dim focus:border-ink-600 focus:outline-none disabled:opacity-50"
          />
        </label>
      )}

      <fieldset disabled={disabled}>
        <legend className="text-xs font-medium text-fg-muted">Thinking</legend>
        <div className="mt-1.5 flex flex-wrap gap-1.5">
          {customMode && (
            <EffortButton
              label="CLI-selected"
              selected={!value.effort}
              onClick={() => onChange({ ...value, effort: null })}
            />
          )}
          {efforts.map((effort) => (
            <EffortButton
              key={effort}
              label={effortLabel(effort)}
              selected={value.effort === effort}
              onClick={() => onChange({ ...value, effort })}
            />
          ))}
        </div>
        {value.backend === "codex" && efforts.length === 0 && (
          <p className="mt-1.5 text-[11px] leading-relaxed text-fg-dim">
            Choose a listed Codex model to set its supported thinking level.
          </p>
        )}
        {value.backend === "claude" && value.model && efforts.length === 0 && (
          <p className="mt-1.5 text-[11px] leading-relaxed text-fg-dim">
            This model uses its own automatic thinking behavior.
          </p>
        )}
      </fieldset>

      {!catalogReady && (
        <p className="text-[11px] text-fg-dim">Loading model choices…</p>
      )}
      {catalogError && (
        <div className="text-[11px] leading-relaxed text-warning">
          <p className="selectable break-words">
            Model choices could not be verified. Custom model entry still works;
            any saved thinking choice is left unchanged.
          </p>
          <button
            type="button"
            disabled={disabled}
            onClick={() => setCatalogAttempt((attempt) => attempt + 1)}
            className="mt-1.5 rounded-md border border-warning/30 px-2 py-1 font-medium text-fg-muted transition-colors hover:border-warning/60 hover:text-fg disabled:opacity-50"
          >
            Retry model choices
          </button>
        </div>
      )}
    </div>
  );
}

function EffortButton({
  label,
  selected,
  onClick,
}: {
  label: string;
  selected: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={selected}
      className={`rounded-md border px-2 py-1 text-[11px] font-medium transition-colors disabled:opacity-50 ${
        selected
          ? "border-accent/60 bg-accent/10 text-fg"
          : "border-ink-700 text-fg-muted hover:border-ink-600 hover:text-fg"
      }`}
    >
      {label}
    </button>
  );
}
