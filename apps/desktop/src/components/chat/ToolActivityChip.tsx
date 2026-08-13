import type { ToolActivity } from "@/types/chat";

/** Quiet pill for one tool invocation: tiny status dot + friendly label. */
export default function ToolActivityChip({
  activity,
}: {
  activity: ToolActivity;
}) {
  return (
    <div
      className="inline-flex animate-appear items-center gap-1.5 rounded-full border border-white/5 bg-ink-850 px-2.5 py-1 text-xs text-fg-muted"
      title={activity.resultText || activity.name}
    >
      <StatusDot status={activity.status} />
      <span>{activity.friendlyLabel}</span>
    </div>
  );
}

function StatusDot({ status }: { status: ToolActivity["status"] }) {
  const cls =
    status === "running"
      ? "bg-accent animate-dot-pulse"
      : status === "ok"
        ? "bg-success"
        : "bg-danger";
  return <span className={`h-1.5 w-1.5 rounded-full ${cls}`} />;
}
