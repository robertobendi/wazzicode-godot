import { useCallback, useEffect, useMemo, useState } from "react";
import { api, openExternal } from "@/api";
import { useSettingsStore } from "@/stores/useSettingsStore";
import { useToastStore } from "@/stores/useToastStore";
import {
  PROVIDER_PRESETS,
  type OpenCodeAuthStatus,
  type ProviderPreset,
} from "@/types/opencode";

/**
 * OpenCode provider manager. Keys are written into OpenCode's own auth store
 * (`~/.local/share/opencode/auth.json`) so a saved key is immediately usable by
 * `opencode run` — including the runs Studio launches. Custom OpenAI-compatible
 * endpoints additionally get a `provider` entry in OpenCode's global config.
 *
 * The same panel is used by Settings and by the onboarding wizard's OpenCode
 * "Connect" step, so a provider added during setup is identical to one added
 * later.
 */
export default function ProvidersPanel({ onSaved }: { onSaved?: () => void }) {
  const settings = useSettingsStore((s) => s.settings);
  const update = useSettingsStore((s) => s.update);
  const showToast = useToastStore((s) => s.show);

  const [status, setStatus] = useState<OpenCodeAuthStatus | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [mode, setMode] = useState<"known" | "custom">("known");
  const [selected, setSelected] = useState<string | null>(null);
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [modelDraft, setModelDraft] = useState("");
  const [models, setModels] = useState<string[]>([]);

  const refresh = useCallback(async () => {
    try {
      const next = await api.getOpenCodeCredentials();
      setStatus(next);
      setLoadError(null);
      setModelDraft((cur) => cur || next.defaultModel || "");
    } catch (err) {
      setLoadError(String(err));
    }
  }, []);

  useEffect(() => {
    void refresh();
    // Keys added through `opencode auth` in a terminal show up on return.
    const onFocus = () => void refresh();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [refresh]);

  useEffect(() => {
    let alive = true;
    void api
      .agentModelCatalog("opencode")
      .then((catalog) => alive && setModels(catalog.map((m) => m.id)))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  const savedIds = useMemo(
    () => new Set((status?.credentials ?? []).map((c) => c.providerId)),
    [status],
  );

  async function run(action: () => Promise<OpenCodeAuthStatus>, toast: string) {
    setBusy(true);
    setError(null);
    try {
      const next = await action();
      setStatus(next);
      setSelected(null);
      setKey("");
      showToast(toast);
      onSaved?.();
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  }

  function saveKnown(preset: ProviderPreset) {
    if (!key.trim()) return;
    void (async () => {
      setBusy(true);
      setError(null);
      try {
        const next = await api.setOpenCodeApiKey(preset.id, key.trim());
        setStatus(next);
        setSelected(null);
        setKey("");
        // "Connect automatically": if no default model is chosen yet, adopt the
        // first model this provider exposes so the very next run uses it.
        const current = useSettingsStore.getState().settings;
        const match = models.find((m) => m.startsWith(`${preset.id}/`));
        if (!current?.opencodeModel && match) {
          await api.setOpenCodeDefaultModel(match);
          await update({ opencodeModel: match });
          showToast(`${preset.name} key saved — default model ${match}`);
        } else {
          showToast(`${preset.name} key saved`);
        }
        onSaved?.();
      } catch (err) {
        setError(String(err));
      } finally {
        setBusy(false);
      }
    })();
  }

  function saveCustom(form: {
    providerId: string;
    name: string;
    baseUrl: string;
  }) {
    if (!key.trim()) return;
    void run(
      () =>
        api.setOpenCodeCompatibleProvider({
          providerId: form.providerId.trim(),
          name: form.name.trim(),
          baseUrl: form.baseUrl.trim(),
          apiKey: key.trim(),
        }),
      "OpenAI-compatible provider saved",
    );
  }

  function remove(providerId: string) {
    void run(
      () => api.removeOpenCodeCredential(providerId),
      `${providerId} key removed`,
    );
  }

  async function saveDefaultModel() {
    setBusy(true);
    setError(null);
    try {
      await api.setOpenCodeDefaultModel(modelDraft.trim());
      await update({ opencodeModel: modelDraft.trim() || null });
      showToast(modelDraft.trim() ? "Default model updated" : "Default model cleared");
      onSaved?.();
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  }

  const currentPreset = PROVIDER_PRESETS.find((p) => p.id === selected) ?? null;

  return (
    <div className="space-y-3">
      <p className="text-xs leading-relaxed text-fg-dim">
        OpenCode runs on a model you choose. Add a key for a provider it already
        knows, or point it at any OpenAI-compatible endpoint — Studio writes the
        key straight into OpenCode's own store, so the app and the{" "}
        <span className="font-mono text-fg-muted">opencode</span> CLI share it.
      </p>

      {loadError && (
        <p className="rounded-lg border border-danger/30 bg-danger/5 p-2.5 text-xs text-danger">
          {loadError}
        </p>
      )}

      {(status?.credentials.length ?? 0) > 0 && (
        <ul className="space-y-1.5">
          {status!.credentials.map((credential) => (
            <li
              key={credential.providerId}
              className="flex items-center justify-between gap-2 rounded-lg border border-white/[0.08] bg-white/[0.025] px-2.5 py-2"
            >
              <span className="min-w-0">
                <span className="block truncate text-xs font-medium text-fg">
                  {credential.displayName ?? credential.providerId}
                </span>
                <span className="block truncate font-mono text-[10px] text-fg-dim">
                  {credential.providerId} · {credential.keyHint ?? credential.authType}
                  {credential.baseUrl ? ` · ${credential.baseUrl}` : ""}
                </span>
              </span>
              <button
                onClick={() => remove(credential.providerId)}
                disabled={busy}
                className="shrink-0 rounded-md border border-ink-700 px-2 py-1 text-[11px] text-fg-muted transition-colors hover:border-danger/50 hover:text-danger disabled:opacity-50"
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}

      <div className="flex gap-1 rounded-lg bg-ink-900 p-1">
        {(["known", "custom"] as const).map((id) => (
          <button
            key={id}
            onClick={() => {
              setMode(id);
              setSelected(null);
              setKey("");
              setError(null);
            }}
            className={`flex-1 rounded-md px-2.5 py-1.5 text-xs font-medium transition-colors ${
              mode === id
                ? "bg-accent text-white"
                : "text-fg-muted hover:bg-ink-800 hover:text-fg"
            }`}
          >
            {id === "known" ? "Known providers" : "OpenAI-compatible"}
          </button>
        ))}
      </div>

      {mode === "known" ? (
        <div className="grid grid-cols-2 gap-1.5">
          {PROVIDER_PRESETS.map((preset) => {
            const active = selected === preset.id;
            return (
              <button
                key={preset.id}
                onClick={() => {
                  setSelected(active ? null : preset.id);
                  setKey("");
                  setError(null);
                }}
                className={`flex items-center gap-2 rounded-lg border px-2.5 py-2 text-left text-xs transition-colors ${
                  active
                    ? "border-accent bg-accent/5 text-fg"
                    : "border-ink-700 bg-ink-900 text-fg-muted hover:border-ink-600 hover:text-fg"
                }`}
              >
                <span
                  aria-hidden
                  className={`h-1.5 w-1.5 shrink-0 rounded-full ${
                    savedIds.has(preset.id) ? "bg-success" : "bg-ink-600"
                  }`}
                />
                <span className="truncate">{preset.name}</span>
              </button>
            );
          })}
        </div>
      ) : (
        <CustomProviderForm busy={busy} onSubmit={saveCustom} />
      )}

      {currentPreset && (
        <KeyForm
          label={currentPreset.name}
          placeholder={currentPreset.keyHint}
          hint={
            <button
              onClick={() => void openExternal(currentPreset.home)}
              className="text-[11px] text-accent underline-offset-2 hover:underline"
            >
              Get a key ↗
            </button>
          }
          value={key}
          onChange={setKey}
          busy={busy}
          onSave={() => saveKnown(currentPreset)}
        />
      )}

      <div className="border-t border-white/[0.08] pt-3">
        <label className="block text-[11px] font-semibold uppercase tracking-[0.16em] text-fg-dim">
          Default model
        </label>
        <p className="mt-1 text-[11px] leading-relaxed text-fg-dim">
          A <span className="font-mono">provider/model</span> id. This is what
          every Studio run and the plain{" "}
          <span className="font-mono">opencode</span> CLI use.
        </p>
        <div className="mt-2 flex gap-2">
          <input
            list="opencode-models"
            value={modelDraft}
            onChange={(e) => setModelDraft(e.target.value)}
            placeholder="deepseek/deepseek-v4-pro"
            spellCheck={false}
            className="min-w-0 flex-1 rounded-md border border-ink-700 bg-ink-900 px-2.5 py-1.5 font-mono text-xs text-fg placeholder:text-fg-dim focus:border-accent focus:outline-none"
          />
          <datalist id="opencode-models">
            {models.map((model) => (
              <option key={model} value={model} />
            ))}
          </datalist>
          <button
            onClick={() => void saveDefaultModel()}
            disabled={busy || !settings}
            className="shrink-0 rounded-md bg-ink-700 px-3 py-1.5 text-xs font-medium text-fg transition-colors hover:bg-ink-600 disabled:opacity-50"
          >
            Save
          </button>
        </div>
      </div>

      {error && (
        <p className="rounded-lg border border-danger/30 bg-danger/5 p-2.5 text-xs text-danger">
          {error}
        </p>
      )}

      {status?.path && (
        <p className="truncate text-[10px] text-fg-dim" title={status.path}>
          Credentials: <span className="font-mono">{status.path}</span>
        </p>
      )}
    </div>
  );
}

function KeyForm({
  label,
  placeholder,
  hint,
  value,
  onChange,
  busy,
  onSave,
}: {
  label: string;
  placeholder: string;
  hint?: React.ReactNode;
  value: string;
  onChange: (v: string) => void;
  busy: boolean;
  onSave: () => void;
}) {
  return (
    <div className="rounded-lg border border-white/[0.08] bg-black/10 p-3">
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-medium text-fg">{label} API key</span>
        {hint}
      </div>
      <div className="mt-2 flex gap-2">
        <input
          type="password"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && onSave()}
          placeholder={placeholder}
          spellCheck={false}
          autoComplete="off"
          className="min-w-0 flex-1 rounded-md border border-ink-700 bg-ink-900 px-2.5 py-1.5 font-mono text-xs text-fg placeholder:text-fg-dim focus:border-accent focus:outline-none"
        />
        <button
          onClick={onSave}
          disabled={busy || !value.trim()}
          className="shrink-0 rounded-md bg-accent px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-accent-hover disabled:opacity-50"
        >
          {busy ? "Saving…" : "Save"}
        </button>
      </div>
    </div>
  );
}

function CustomProviderForm({
  busy,
  onSubmit,
}: {
  busy: boolean;
  onSubmit: (form: {
    providerId: string;
    name: string;
    baseUrl: string;
  }) => void;
}) {
  const [providerId, setProviderId] = useState("");
  const [name, setName] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [touched, setTouched] = useState(false);

  const ready =
    providerId.trim() &&
    name.trim() &&
    baseUrl.trim() &&
    apiKey.trim();

  function submit() {
    setTouched(true);
    if (!providerId.trim() || !name.trim() || !baseUrl.trim() || !apiKey.trim()) {
      return;
    }
    onSubmit({ providerId, name, baseUrl });
  }

  return (
    <div className="space-y-2 rounded-lg border border-white/[0.08] bg-black/10 p-3">
      <Field
        label="Provider id"
        value={providerId}
        onChange={setProviderId}
        placeholder="my-proxy"
        invalid={touched && !providerId.trim()}
      />
      <Field
        label="Display name"
        value={name}
        onChange={setName}
        placeholder="My Proxy"
        invalid={touched && !name.trim()}
      />
      <Field
        label="Base URL"
        value={baseUrl}
        onChange={setBaseUrl}
        placeholder="https://api.example.com/v1"
        invalid={touched && !baseUrl.trim()}
        mono
      />
      <Field
        label="API key"
        value={apiKey}
        onChange={setApiKey}
        placeholder="sk-…"
        invalid={touched && !apiKey.trim()}
        secret
        onSubmit={submit}
      />
      <button
        onClick={submit}
        disabled={busy || (!touched && !ready)}
        className="w-full rounded-md bg-accent px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-accent-hover disabled:opacity-50"
      >
        {busy ? "Saving…" : "Save provider"}
      </button>
    </div>
  );
}

function Field({
  label,
  value,
  onChange,
  placeholder,
  invalid = false,
  mono = false,
  secret = false,
  onSubmit,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
  invalid?: boolean;
  mono?: boolean;
  secret?: boolean;
  onSubmit?: () => void;
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-[11px] text-fg-dim">{label}</span>
      <input
        type={secret ? "password" : "text"}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && onSubmit?.()}
        placeholder={placeholder}
        spellCheck={false}
        autoComplete="off"
        className={`w-full rounded-md border bg-ink-900 px-2.5 py-1.5 text-xs text-fg placeholder:text-fg-dim focus:outline-none ${
          mono || secret ? "font-mono" : ""
        } ${invalid ? "border-danger/60" : "border-ink-700 focus:border-accent"}`}
      />
    </label>
  );
}
