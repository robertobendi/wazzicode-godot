import { convertFileSrc } from "@tauri-apps/api/core";
import type { LoopIteration, LoopVerdict } from "@/types/loop";

/**
 * Horizontal strip of iteration cards — one per builder turn. Each shows the
 * verdict, one-line summary, cost, git sha, optional QA badge, and the
 * app-captured screenshot thumbnail.
 */
export default function IterationTimeline({
  iterations,
}: {
  iterations: LoopIteration[];
}) {
  if (iterations.length === 0) {
    return (
      <p className="px-1 py-8 text-center text-sm text-fg-dim">
        Working on the first step…
      </p>
    );
  }

  return (
    <div className="flex gap-3 overflow-x-auto pb-2">
      {iterations.map((it) => (
        <IterationCard key={it.index} iter={it} />
      ))}
    </div>
  );
}

function IterationCard({ iter }: { iter: LoopIteration }) {
  return (
    <div className="flex w-64 shrink-0 flex-col gap-2 rounded-xl border border-ink-700 bg-ink-850 p-3">
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium text-fg-muted">
          Step {iter.index + 1}
        </span>
        <VerdictBadge verdict={iter.verdict} />
      </div>

      <Thumbnail path={iter.screenshotPath} index={iter.index} />

      <p className="min-h-[2.5rem] text-xs leading-snug text-fg">
        {iter.summary || <span className="text-fg-dim">No summary.</span>}
      </p>

      {iter.qa && (
        <div
          className={`rounded-md px-2 py-1 text-[11px] ${
            iter.qa.pass
              ? "bg-success/10 text-success"
              : "bg-warning/10 text-warning"
          }`}
          title={iter.qa.notes}
        >
          QA {iter.qa.pass ? "passed" : "failed"}
          {typeof iter.qa.score === "number" ? ` · ${iter.qa.score}/10` : ""}
        </div>
      )}

      <div className="flex items-center justify-between text-[11px] text-fg-dim">
        <span>${iter.costUsd.toFixed(2)}</span>
        {iter.commitSha ? (
          <span className="font-mono" title="Git checkpoint">
            {iter.commitSha}
          </span>
        ) : (
          <span className="italic">no checkpoint</span>
        )}
      </div>
    </div>
  );
}

function Thumbnail({ path, index }: { path: string | null; index: number }) {
  if (!path) {
    return (
      <div className="flex aspect-video w-full items-center justify-center rounded-lg border border-ink-700 bg-ink-900 text-[11px] text-fg-dim">
        No screenshot
      </div>
    );
  }
  // Cache-bust so a re-captured frame at the same path refreshes.
  const src = `${convertFileSrc(path)}?v=${index}`;
  return (
    <img
      src={src}
      alt={`Step ${index + 1} game view`}
      className="aspect-video w-full rounded-lg border border-ink-700 object-cover"
    />
  );
}

function VerdictBadge({ verdict }: { verdict: LoopVerdict }) {
  const map: Record<LoopVerdict, { label: string; cls: string }> = {
    done: { label: "Done", cls: "bg-success/10 text-success" },
    continue: { label: "More to do", cls: "bg-ink-800 text-fg-muted" },
    blocked: { label: "Blocked", cls: "bg-danger/10 text-danger" },
    unknown: { label: "Unclear", cls: "bg-warning/10 text-warning" },
  };
  const { label, cls } = map[verdict];
  return (
    <span className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${cls}`}>
      {label}
    </span>
  );
}
