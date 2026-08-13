import { useRef } from "react";
import { useResourceDnd } from "@/hooks/useResourceDnd";
import { useChatStore } from "@/stores/useChatStore";
import MessageList from "./MessageList";
import Composer from "./Composer";
import TaskFeedback from "./TaskFeedback";

/** The main chat surface. Wires the Claude event stream + resource drag-drop. */
export default function ChatView() {
  const project = useChatStore((s) => s.project);
  const columnRef = useRef<HTMLDivElement>(null);
  const dragActive = useResourceDnd(project, columnRef);

  return (
    <div
      ref={columnRef}
      className="chat-view relative flex min-h-0 min-w-0 flex-1 flex-col"
    >
      <MessageList />
      <TaskFeedback />
      <Composer />

      {dragActive && (
        <div className="pointer-events-none absolute inset-2 z-10 flex items-center justify-center rounded-2xl border-2 border-dashed border-accent/70 bg-ink-950/70 backdrop-blur-sm">
          <span className="text-sm font-medium text-fg">
            Drop images, models, sounds…
          </span>
        </div>
      )}
    </div>
  );
}
