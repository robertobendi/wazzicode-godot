import { useCallback, useEffect, useRef, useState } from "react";
import { useChatStore } from "@/stores/useChatStore";
import { useAttachmentsStore } from "@/stores/useAttachmentsStore";
import { useLoopStore } from "@/stores/useLoopStore";
import { useSettingsStore } from "@/stores/useSettingsStore";
import { useQuickActions } from "@/hooks/useQuickActions";
import { useDictation } from "@/hooks/useDictation";
import { useCliInstallActive } from "@/hooks/useOnboarding";
import { isLoopActive } from "@/types/loop";
import { BACKENDS } from "@/types/settings";
import type { AgentRunOptions } from "@/types/agent";
import { runOptionsFromSettings } from "@/lib/agentOptions";
import { runOptionsSummary } from "@/lib/modelCatalog";
import { api } from "@/api";
import AttachmentChip from "./AttachmentChip";
import AgentRunControls from "@/components/agent/AgentRunControls";
import { MicIcon } from "../shell/icons";

/**
 * Prompt input: Enter to send/queue, Shift+Enter for a newline. While an agent
 * is running, the dock stays available and new tasks join a FIFO queue.
 *
 * The mic dictates locally (offline Whisper — see `hooks/useDictation`). It
 * *appends* to whatever is already typed rather than replacing it, so speech and
 * typing compose; and it hides itself entirely when the dictation model isn't in
 * the build, rather than offering a button that can only fail.
 */
export default function Composer() {
  const running = useChatStore((s) => s.running);
  const submitTask = useChatStore((s) => s.submitTask);
  const cancel = useChatStore((s) => s.cancel);
  const cancelRequested = useChatStore((s) => s.cancelRequested);
  const queuedTasks = useChatStore((s) => s.queuedTasks);
  const project = useChatStore((s) => s.project);
  const loopRunning = useLoopStore((s) => isLoopActive(s.state?.status));
  const cliInstalling = useCliInstallActive();
  const attachments = useAttachmentsStore((s) => s.items);
  const removeAttachment = useAttachmentsStore((s) => s.remove);
  const addAttachments = useAttachmentsStore((s) => s.add);
  const clearAttachments = useAttachmentsStore((s) => s.clear);
  const quickActions = useQuickActions(project);
  const settings = useSettingsStore((s) => s.settings);
  const sessionOptions = useChatStore((s) => s.session.runOptions);
  const [runOptions, setRunOptions] = useState<AgentRunOptions>(() =>
    settings
      ? runOptionsFromSettings(settings)
      : { backend: "claude", model: null, effort: null },
  );
  const [tuningOpen, setTuningOpen] = useState(false);
  const [value, setValue] = useState("");
  const ref = useRef<HTMLTextAreaElement>(null);
  const tuningRef = useRef<HTMLDivElement>(null);
  const tuningTriggerRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (sessionOptions) {
      setRunOptions(sessionOptions);
    } else if (settings) {
      setRunOptions(runOptionsFromSettings(settings));
    }
  }, [
    sessionOptions,
    settings?.agentBackend,
    settings?.model,
    settings?.codexModel,
    settings?.effort,
    settings?.codexEffort,
  ]);

  useEffect(() => {
    if (!tuningOpen) return;
    const frame = requestAnimationFrame(() => {
      tuningRef.current
        ?.querySelector<HTMLElement>("select, input, button")
        ?.focus();
    });
    function onMouseDown(event: MouseEvent) {
      const target = event.target as Node;
      if (
        tuningRef.current?.contains(target) ||
        tuningTriggerRef.current?.contains(target)
      ) {
        return;
      }
      setTuningOpen(false);
    }
    function onEscape(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      event.preventDefault();
      setTuningOpen(false);
      requestAnimationFrame(() => tuningTriggerRef.current?.focus());
    }
    document.addEventListener("mousedown", onMouseDown);
    document.addEventListener("keydown", onEscape);
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener("mousedown", onMouseDown);
      document.removeEventListener("keydown", onEscape);
    };
  }, [tuningOpen]);

  const agentLabel = BACKENDS[runOptions.backend].label;

  // Dictation appends, so a user can type half a thought and speak the rest.
  const appendDictated = useCallback((text: string) => {
    setValue((cur) => (cur.trim() ? `${cur.trimEnd()} ${text}` : text));
    requestAnimationFrame(() => {
      const el = ref.current;
      if (el) {
        el.focus();
        autosize(el);
      }
    });
  }, []);
  const dictation = useDictation(appendDictated);

  const queueing = running || queuedTasks.length > 0;
  const canSubmit =
    (value.trim() || attachments.length > 0) &&
    !loopRunning &&
    !cliInstalling;

  // A quiet starter-prompt row, only on an empty, idle composer.
  const showQuickActions =
    !value.trim() &&
    attachments.length === 0 &&
    !queueing &&
    !loopRunning &&
    quickActions.length > 0;

  // Fill (don't send) — the employee can tweak the prompt before hitting Enter.
  function fillPrompt(prompt: string) {
    setValue(prompt);
    requestAnimationFrame(() => {
      const el = ref.current;
      if (el) {
        el.focus();
        autosize(el);
      }
    });
  }

  function submit() {
    if (!canSubmit) return;
    const text = value.trim();
    const accepted = submitTask(text, attachments, runOptions);
    if (!accepted) return;
    setValue("");
    clearAttachments(); // detach — the files now belong to the sent message
    requestAnimationFrame(() => autosize(ref.current));
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  }

  // Only reach into the OS clipboard when the paste actually carries files or an
  // image — those the webview can't read directly, so Rust stages them as
  // attachments. Plain text (e.g. pasted code) must fall through to the textarea
  // untouched: opening the OS clipboard from Rust races the webview's own paste
  // on Windows and can drop the pasted text entirely.
  function onPaste(e: React.ClipboardEvent<HTMLTextAreaElement>) {
    if (!project) return;
    const cd = e.clipboardData;
    const hasFiles =
      !!cd &&
      (cd.files.length > 0 ||
        Array.from(cd.items).some((it) => it.kind === "file"));
    if (!hasFiles) return; // let the textarea handle text normally
    void api
      .pasteClipboard(project)
      .then((staged) => {
        if (staged.length) addAttachments(staged);
      })
      .catch(() => {
        // A read failure is non-fatal here.
      });
  }

  return (
    <div className="composer-shell glass-bar mx-3 mb-3 shrink-0 rounded-xl border px-4 py-3">
      <div className="mx-auto max-w-2xl">
        {showQuickActions && (
          <div className="mb-2 flex gap-1.5 overflow-x-auto pb-0.5">
            {quickActions.map((qa) => (
              <button
                key={qa.label}
                onClick={() => fillPrompt(qa.prompt)}
                className="prompt-tile shrink-0 whitespace-nowrap rounded-full border border-white/10 bg-black/25 px-3 py-1.5 text-xs text-fg-muted hover:border-white/20 hover:bg-white/[0.055] hover:text-fg"
              >
                {qa.label}
              </button>
            ))}
          </div>
        )}

        {attachments.length > 0 && (
          <div className="mb-2 flex flex-wrap gap-1.5">
            {attachments.map((a) => (
              <AttachmentChip
                key={a.id}
                attachment={a}
                onRemove={(id) => void removeAttachment(id)}
              />
            ))}
          </div>
        )}

        <div className="command-dock relative rounded-lg border border-white/10 bg-black/25 p-2 shadow-inner shadow-white/[0.025]">
          <textarea
            ref={ref}
            value={value}
            onChange={(e) => {
              setValue(e.target.value);
              autosize(e.target);
            }}
            onKeyDown={onKeyDown}
            onPaste={onPaste}
            rows={1}
            disabled={loopRunning}
            placeholder={
              loopRunning
                ? "Auto mode is running…"
                : cliInstalling
                  ? "Finishing the CLI install…"
                  : running
                    ? "Add another task — it will start when this one finishes…"
                    : queuedTasks.length > 0
                      ? "Add another task to the queue…"
                      : dictation.state === "recording"
                        ? "Listening… click the mic to finish."
                        : dictation.state === "transcribing"
                          ? "Transcribing…"
                          : `Ask ${agentLabel} to change your game…`
            }
            className="selectable max-h-40 min-h-[2.75rem] w-full resize-none bg-transparent px-2.5 py-2 text-sm leading-relaxed text-fg placeholder:text-fg-dim focus:outline-none disabled:opacity-50"
          />

          <div className="mt-1 flex items-center justify-between gap-3 border-t border-white/[0.07] px-1 pt-2">
            <button
              ref={tuningTriggerRef}
              type="button"
              onClick={() => setTuningOpen((open) => !open)}
              aria-expanded={tuningOpen}
              aria-controls="agent-tuning"
              className="flex min-w-0 max-w-[70%] items-center gap-2 rounded-lg px-2 py-1.5 text-left text-xs text-fg-dim hover:bg-white/5 hover:text-fg-muted"
            >
              <span className="shrink-0 font-medium text-fg-muted">{agentLabel}</span>
              <span className="truncate">{runOptionsSummary(runOptions)}</span>
              <span className="shrink-0 text-[10px]" aria-hidden>
                {tuningOpen ? "▲" : "▼"}
              </span>
            </button>

            <div className="flex shrink-0 items-center gap-2">
              {dictation.state !== "unsupported" && !loopRunning && (
                <MicButton dictation={dictation} />
              )}

              {running && (
                <button
                  onClick={() => void cancel()}
                  disabled={cancelRequested}
                  className="shrink-0 rounded-lg border border-white/10 bg-white/[0.055] px-3 py-2 text-sm font-medium text-fg hover:bg-white/[0.09] disabled:cursor-wait disabled:opacity-55"
                >
                  {cancelRequested ? "Stopping…" : "Stop"}
                </button>
              )}
              <button
                onClick={submit}
                disabled={!canSubmit}
                title={queueing ? "Run after the tasks ahead of it" : undefined}
                className="shrink-0 rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-white hover:bg-accent-hover disabled:opacity-40"
              >
                {queueing ? "Queue task" : "Send"}
              </button>
            </div>
          </div>

          {tuningOpen && (
            <div
              ref={tuningRef}
              id="agent-tuning"
              className="glass-card absolute inset-x-0 bottom-full z-30 mb-2 rounded-2xl border p-4"
            >
              <AgentRunControls value={runOptions} onChange={setRunOptions} />
              {sessionOptions && (
                <p className="mt-2 text-[11px] leading-relaxed text-fg-dim">
                  {running
                    ? "Applies to your next message — the task that's running keeps the model it started with."
                    : "Applies to your next message."}
                  {" "}
                  This conversation stays on{" "}
                  {BACKENDS[sessionOptions.backend].label}; start a new chat to
                  switch agent.
                </p>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/** Mic toggle: click to talk, click again to transcribe. */
function MicButton({
  dictation,
}: {
  dictation: ReturnType<typeof useDictation>;
}) {
  const { state, error, start, stop } = dictation;
  const recording = state === "recording";
  const busy = state === "transcribing";

  const title = error
    ? error
    : recording
      ? "Stop and transcribe"
      : busy
        ? "Transcribing…"
        : "Dictate (runs locally on this machine)";

  return (
    <button
      onClick={() => (recording ? stop() : start())}
      disabled={busy}
      title={title}
      aria-label={title}
      aria-pressed={recording}
      className={`relative shrink-0 rounded-lg border px-2.5 py-2 transition-colors duration-150 disabled:opacity-60 ${
        recording
          ? "border-danger/40 bg-danger/15 text-danger"
          : state === "error"
            ? "border-danger/40 bg-ink-850 text-danger hover:bg-ink-800"
            : "border-ink-700 bg-ink-850 text-fg-muted hover:bg-ink-800 hover:text-fg"
      }`}
    >
      {busy ? (
        <span className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-fg-dim border-t-transparent" />
      ) : (
        <MicIcon className={recording ? "animate-pulse" : undefined} />
      )}
    </button>
  );
}

function autosize(el: HTMLTextAreaElement | null) {
  if (!el) return;
  el.style.height = "auto";
  el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
}
