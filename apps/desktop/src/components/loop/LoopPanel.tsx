import { useState } from "react";
import { useChatStore } from "@/stores/useChatStore";
import { useLoopStore } from "@/stores/useLoopStore";
import {
  isLoopActive,
  isLoopPaused,
  type LoopState,
  type LoopStatus,
} from "@/types/loop";
import { BACKENDS } from "@/types/settings";
import { runOptionsSummary } from "@/lib/modelCatalog";
import { failureMessage as getFailureMessage } from "@/lib/loopRecovery";
import IterationTimeline from "./IterationTimeline";
import GoalCard from "./GoalCard";

/**
 * Auto-mode surface. Shows the goal form when idle (or when starting a new
 * run after one finished), and the live run view — timeline, "now doing" line,
 * cost ticker, Stop button, and a final status banner — while a loop exists.
 */
export default function LoopPanel() {
  const state = useLoopStore((s) => s.state);
  const [startNew, setStartNew] = useState(false);

  const active = isLoopActive(state?.status);

  if (!state || (!active && startNew)) {
    return (
      <div className="min-h-0 flex-1 overflow-y-auto px-6 py-8">
        <GoalCard />
      </div>
    );
  }

  return <RunView onNewGoal={() => setStartNew(true)} />;
}

function RunView({ onNewGoal }: { onNewGoal: () => void }) {
  const state = useLoopStore((s) => s.state)!;
  const nowDoing = useLoopStore((s) => s.nowDoing);
  const stop = useLoopStore((s) => s.stop);
  const pause = useLoopStore((s) => s.pause);
  const active = isLoopActive(state.status);
  const paused = isLoopPaused(state.status);
  const backend = BACKENDS[state.options.agent.backend];
  const warnings = state.warnings.filter(
    (warning) =>
      !(
        state.status === "failed" &&
        warning.startsWith(`${backend.label} task failed:`)
      ),
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex-1 overflow-y-auto px-6 py-6">
        <div className="mx-auto flex max-w-4xl flex-col gap-5">
          {/* Goal + cost ticker */}
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0">
              <p className="text-xs uppercase tracking-wide text-fg-dim">
                Goal
              </p>
              <p className="mt-0.5 text-sm text-fg">{state.goal}</p>
              <p className="mt-1 text-xs text-fg-dim">
                {backend.label} · {runOptionsSummary(state.options.agent)}
              </p>
            </div>
            <div className="shrink-0 text-right">
              <p className="text-xs uppercase tracking-wide text-fg-dim">
                {backend.reportsCost ? "Spent" : "Progress"}
              </p>
              <p className="mt-0.5 font-mono text-sm text-fg">
                {backend.reportsCost ? (
                  <>
                    ${state.totalCostUsd.toFixed(2)}
                    <span className="text-fg-dim">
                      {" "}/ ${state.options.maxCostUsd.toFixed(0)}
                    </span>
                  </>
                ) : (
                  <>
                    {state.iterations.length}
                    <span className="text-fg-dim">
                      {" "}/ {state.options.maxIterations} steps
                    </span>
                  </>
                )}
              </p>
            </div>
          </div>

          {state.referenceImages.length > 0 && (
            <p className="text-xs text-fg-dim">
              {state.referenceImages.length} reference image
              {state.referenceImages.length === 1 ? "" : "s"}
            </p>
          )}

          {active ? (
            <NowDoing label={nowDoing} status={state.status} />
          ) : paused ? (
            <PausedBanner steps={state.iterations.length} />
          ) : (
            <StatusBanner status={state.status} agentLabel={backend.label} />
          )}

          {warnings.map((w) => (
            <p
              key={w}
              className="rounded-lg bg-warning/10 px-3 py-2 text-xs text-warning"
            >
              {w}
            </p>
          ))}

          {!active && !paused && (
            <RunRecap state={state} agentLabel={backend.label} />
          )}

          <IterationTimeline iterations={state.iterations} />
        </div>
      </div>

      {/* Sticky action bar */}
      <div className="glass-bar mx-3 mb-3 rounded-2xl border px-6 py-3">
        <div className="mx-auto max-w-4xl">
          {active && <FeedbackComposer />}
          {paused && <ResumeComposer />}
          {!active && !paused && state.status !== "done" && <RecoveryComposer />}
          <div
            className={`flex items-center justify-between ${
              active || paused || state.status !== "done"
                ? "mt-3 border-t border-white/[0.06] pt-3"
                : ""
            }`}
          >
            <span className="text-xs text-fg-dim">
              Step {state.iterations.length}
              {" · "}
              {state.options.maxIterations} max
            </span>
            {active ? (
              <div className="flex items-center gap-2">
                <button
                  onClick={() => void pause()}
                  disabled={state.status !== "running"}
                  title="Let this step finish, then hold. Nothing is lost."
                  className="rounded-xl border border-white/10 bg-white/[0.055] px-4 py-2.5 text-sm font-semibold text-fg transition-colors duration-150 hover:bg-white/[0.09] disabled:opacity-50"
                >
                  {state.status === "pausing" ? "Pausing…" : "Pause"}
                </button>
                <button
                  onClick={() => void stop()}
                  disabled={state.status === "stopping"}
                  className="rounded-xl bg-danger px-5 py-2.5 text-sm font-semibold text-white transition-colors duration-150 hover:brightness-110 disabled:opacity-50"
                >
                  {state.status === "stopping" ? "Stopping…" : "Stop"}
                </button>
              </div>
            ) : (
              <button
                onClick={onNewGoal}
                className={`rounded-xl px-5 py-2.5 text-sm font-semibold transition-colors duration-150 ${
                  state.status === "done"
                    ? "bg-accent text-white hover:bg-accent-hover"
                    : "border border-white/10 bg-white/[0.04] text-fg-muted hover:bg-white/[0.08] hover:text-fg"
                }`}
              >
                {state.status === "done"
                  ? "Start another"
                  : paused
                    ? "Abandon and start a new goal"
                    : "Start a new goal"}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function FeedbackComposer() {
  const state = useLoopStore((s) => s.state)!;
  const addFeedback = useLoopStore((s) => s.addFeedback);
  const sending = useLoopStore((s) => s.feedbackSending);
  const error = useLoopStore((s) => s.feedbackError);
  const [comment, setComment] = useState("");
  const pending = state.feedback.filter(
    (item) => item.appliedAtIteration === null,
  );
  const lastApplied = [...state.feedback]
    .reverse()
    .find((item) => item.appliedAtIteration !== null);
  const feedbackTarget =
    state.currentRunId?.endsWith(":builder") === true
      ? state.iterations.length + 1
      : state.iterations.length;
  const accepting =
    state.status === "running" &&
    feedbackTarget < state.options.maxIterations;

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!comment.trim() || !accepting || sending) return;
    if (await addFeedback(comment.trim())) setComment("");
  }

  return (
    <form
      onSubmit={(event) => void submit(event)}
      className="rounded-xl bg-black/15 px-3 py-2"
    >
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <label htmlFor="loop-feedback" className="text-xs font-semibold text-fg">
            Add feedback while this runs
          </label>
          <p className="mt-0.5 text-[11px] leading-relaxed text-fg-dim">
            Add feedback now. It is evaluated after the current agent turn,
            before the next plan.
          </p>
        </div>
        {pending.length > 0 && (
          <span className="shrink-0 rounded-full bg-accent/10 px-2 py-0.5 text-[10px] font-medium text-accent">
            {pending.length} queued
          </span>
        )}
      </div>
      <div className="mt-2 flex items-end gap-2">
        <textarea
          id="loop-feedback"
          value={comment}
          onChange={(event) => setComment(event.target.value)}
          maxLength={2000}
          rows={2}
          disabled={!accepting || sending}
          placeholder={
            accepting
              ? "Example: Keep the layout, but make the player easier to see."
              : "No later step is available for feedback."
          }
          className="selectable min-h-[3rem] flex-1 resize-none rounded-lg border border-white/10 bg-black/20 px-3 py-2 text-xs leading-relaxed text-fg placeholder:text-fg-dim focus:border-accent/40 focus:outline-none disabled:opacity-50"
        />
        <button
          type="submit"
          disabled={!comment.trim() || !accepting || sending}
          className="shrink-0 rounded-lg bg-accent px-3 py-2 text-xs font-semibold text-white hover:bg-accent-hover disabled:opacity-40"
        >
          {sending ? "Adding…" : "Add feedback"}
        </button>
      </div>
      {error && <p className="mt-2 text-[11px] text-danger">{error}</p>}
      {pending.length > 0 && (
        <ul className="mt-2 space-y-1 border-t border-white/[0.06] pt-2">
          {pending.map((item) => (
            <li
              key={item.id}
              className="truncate text-[11px] text-fg-muted"
              title={item.text}
            >
              Queued: {item.text}
            </li>
          ))}
        </ul>
      )}
      {pending.length === 0 && lastApplied && lastApplied.appliedAtIteration !== null && (
        <p className="mt-2 truncate text-[11px] text-fg-dim" title={lastApplied.text}>
          Applied to step {lastApplied.appliedAtIteration + 1}: {lastApplied.text}
        </p>
      )}
    </form>
  );
}

/** Paused runs resume from their cursor, so this note is optional guidance
 *  for the very next step rather than a fresh start. */
function ResumeComposer() {
  const project = useChatStore((store) => store.project);
  const resume = useLoopStore((store) => store.resume);
  const starting = useLoopStore((store) => store.starting);
  const error = useLoopStore((store) => store.error);
  const [note, setNote] = useState("");

  return (
    <div className="rounded-xl bg-black/15 px-3 py-2">
      <p className="text-xs font-semibold text-fg">Resume this run</p>
      <p className="mt-0.5 text-[11px] text-fg-dim">
        It picks up at the next step with the same context. Anything you add
        here is read before that step starts.
      </p>
      <div className="mt-2 flex items-end gap-2">
        <textarea
          value={note}
          onChange={(event) => setNote(event.target.value)}
          maxLength={2000}
          rows={2}
          placeholder="Optional: what you noticed while it was paused."
          className="selectable min-h-[3rem] flex-1 resize-none rounded-lg border border-white/10 bg-black/20 px-3 py-2 text-xs leading-relaxed text-fg placeholder:text-fg-dim focus:border-accent/40 focus:outline-none"
        />
        <button
          onClick={() => {
            if (project) void resume(project, note);
          }}
          disabled={!project || starting}
          className="shrink-0 rounded-lg bg-accent px-4 py-2 text-xs font-semibold text-white hover:bg-accent-hover disabled:opacity-40"
        >
          {starting ? "Resuming…" : "Resume"}
        </button>
      </div>
      {error && <p className="mt-2 text-[11px] text-danger">{error}</p>}
    </div>
  );
}

function RecoveryComposer() {
  const project = useChatStore((store) => store.project);
  const continueRun = useLoopStore((store) => store.continueRun);
  const starting = useLoopStore((store) => store.starting);
  const error = useLoopStore((store) => store.error);
  const [note, setNote] = useState("");

  return (
    <div className="rounded-xl bg-black/15 px-3 py-2">
      <p className="text-xs font-semibold text-fg">Continue from here</p>
      <p className="mt-0.5 text-[11px] text-fg-dim">
        Existing changes and checkpoints stay in place. Add optional guidance,
        then continue only the unfinished work.
      </p>
      <div className="mt-2 flex items-end gap-2">
        <textarea
          value={note}
          onChange={(event) => setNote(event.target.value)}
          maxLength={2000}
          rows={2}
          placeholder="Optional: tell the next step what to reconsider or prioritize."
          className="selectable min-h-[3rem] flex-1 resize-none rounded-lg border border-white/10 bg-black/20 px-3 py-2 text-xs leading-relaxed text-fg placeholder:text-fg-dim focus:border-accent/40 focus:outline-none"
        />
        <button
          onClick={() => {
            if (project) void continueRun(project, note);
          }}
          disabled={!project || starting}
          className="shrink-0 rounded-lg bg-accent px-4 py-2 text-xs font-semibold text-white hover:bg-accent-hover disabled:opacity-40"
        >
          {starting ? "Continuing…" : "Continue from here"}
        </button>
      </div>
      {error && <p className="mt-2 text-[11px] text-danger">{error}</p>}
    </div>
  );
}

function RunRecap({
  state,
  agentLabel,
}: {
  state: LoopState;
  agentLabel: string;
}) {
  const completed = state.iterations.filter((iteration) =>
    iteration.summary.trim(),
  );
  const incomplete = state.status !== "done";
  const failure =
    state.status === "failed" ? getFailureMessage(state, agentLabel) : null;

  return (
    <section className="glass-card rounded-xl border px-4 py-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold text-fg">Run recap</h3>
          <p className="mt-0.5 text-xs text-fg-dim">
            {state.iterations.length} completed step
            {state.iterations.length === 1 ? "" : "s"} preserved in the current
            project.
          </p>
        </div>
        {failure && (
          <span className="rounded-full bg-danger/10 px-2 py-0.5 text-[10px] font-medium text-danger">
            Interrupted
          </span>
        )}
      </div>

      {completed.length > 0 && (
        <div className="mt-3">
          <p className="text-[11px] font-semibold uppercase tracking-wide text-fg-dim">
            What was done
          </p>
          <ol className="mt-1.5 max-h-40 space-y-1.5 overflow-y-auto pr-2 text-xs leading-relaxed text-fg-muted">
            {completed.map((iteration) => (
              <li key={iteration.index}>
                <span className="mr-1.5 font-mono text-fg-dim">
                  {iteration.index + 1}.
                </span>
                {iteration.summary}
              </li>
            ))}
          </ol>
        </div>
      )}

      {failure && (
        <div className="mt-3 rounded-lg bg-danger/10 px-3 py-2">
          <p className="text-[11px] font-semibold uppercase tracking-wide text-danger">
            Why it stopped
          </p>
          <p className="mt-1 text-xs leading-relaxed text-fg-muted">{failure}</p>
        </div>
      )}

      <div className="mt-3">
        <p className="text-[11px] font-semibold uppercase tracking-wide text-fg-dim">
          {incomplete ? "What remains" : "Result"}
        </p>
        <p className="mt-1 text-xs leading-relaxed text-fg-muted">
          {incomplete
            ? "The original goal was not confirmed complete. Continuing will inspect the current project and resume with the remaining work without reverting completed steps."
            : "The builder and final review confirmed the original goal complete."}
        </p>
      </div>
    </section>
  );
}

function PausedBanner({ steps }: { steps: number }) {
  return (
    <div className="glass-card flex items-start gap-3 rounded-xl border px-4 py-3">
      <span
        aria-hidden
        className="mt-1 h-2.5 w-2.5 shrink-0 rounded-full bg-warning"
      />
      <div className="min-w-0">
        <p className="text-sm text-fg">
          Paused after step {steps}. Nothing was lost — that step finished and
          was checkpointed.
        </p>
        <p className="mt-0.5 text-xs text-fg-dim">
          Chat is free to use while this waits. Resuming continues the same
          conversation rather than starting over.
        </p>
      </div>
    </div>
  );
}

function NowDoing({
  label,
  status,
}: {
  label: string | null;
  status: LoopStatus;
}) {
  return (
    <div className="glass-card flex items-center gap-3 rounded-xl border px-4 py-3">
      <span className="relative flex h-2.5 w-2.5 shrink-0">
        <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-accent/60" />
        <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-accent" />
      </span>
      <span className="text-sm text-fg">
        {status === "stopping"
          ? "Stopping…"
          : status === "pausing"
            ? "Finishing this step, then pausing…"
            : (label ?? "Working…")}
      </span>
    </div>
  );
}

function StatusBanner({
  status,
  agentLabel,
}: {
  status: LoopStatus;
  agentLabel: string;
}) {
  const map: Record<
    LoopStatus,
    { text: string; cls: string } | undefined
  > = {
    done: {
      text: "Done — the goal is complete.",
      cls: "bg-success/10 text-success",
    },
    stopped: { text: "Stopped.", cls: "bg-ink-800 text-fg-muted" },
    blocked: {
      text: `${agentLabel} got stuck and couldn't continue. Try refining the goal.`,
      cls: "bg-danger/10 text-danger",
    },
    max_iterations: {
      text: "Reached the step limit before finishing.",
      cls: "bg-warning/10 text-warning",
    },
    cost_capped: {
      text: "Reached the budget limit before finishing.",
      cls: "bg-warning/10 text-warning",
    },
    failed: {
      text: `${agentLabel} couldn't start or finish this task. See the detail below.`,
      cls: "bg-danger/10 text-danger",
    },
    running: undefined,
    stopping: undefined,
    pausing: undefined,
    paused: undefined,
  };
  const entry = map[status];
  if (!entry) return null;
  return (
    <div className={`rounded-xl px-4 py-3 text-sm font-medium ${entry.cls}`}>
      {entry.text}
    </div>
  );
}
