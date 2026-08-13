import { useEffect, useRef } from "react";
import { useChatStore } from "@/stores/useChatStore";
import Logo from "@/components/shell/Logo";
import MessageBubble from "./MessageBubble";

export default function MessageList() {
  const messages = useChatStore((s) => s.messages);
  const project = useChatStore((s) => s.project);
  const sessionId = useChatStore((s) => s.session.sessionId);
  const scrollRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const pinnedRef = useRef(true);
  const programmaticScrollRef = useRef(false);
  const previousCountRef = useRef(0);

  useEffect(() => {
    pinnedRef.current = true;
    programmaticScrollRef.current = false;
    previousCountRef.current = messages.length;
    const frame = requestAnimationFrame(() => {
      bottomRef.current?.scrollIntoView({ behavior: "auto", block: "end" });
    });
    return () => cancelAnimationFrame(frame);
  }, [project, sessionId]);

  // Follow a live response only while the reader is already at the bottom.
  useEffect(() => {
    const newTurn = messages.length > previousCountRef.current;
    previousCountRef.current = messages.length;
    if (!pinnedRef.current) return;
    const reducedMotion = window.matchMedia(
      "(prefers-reduced-motion: reduce)",
    ).matches;
    const smooth = newTurn && !reducedMotion;
    programmaticScrollRef.current = true;
    bottomRef.current?.scrollIntoView({
      behavior: smooth ? "smooth" : "auto",
      block: "end",
    });
    const release = window.setTimeout(
      () => {
        programmaticScrollRef.current = false;
      },
      smooth ? 450 : 0,
    );
    return () => window.clearTimeout(release);
  }, [messages]);

  function trackScrollPosition() {
    if (programmaticScrollRef.current) return;
    const el = scrollRef.current;
    if (!el) return;
    pinnedRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 72;
  }

  if (messages.length === 0) {
    return (
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center overflow-y-auto px-8 py-8 text-center">
        <div className="empty-state-card animate-appear">
          <div className="identity-mark mx-auto">
            <Logo size={27} />
          </div>
          <div className="text-[10px] font-semibold uppercase tracking-[0.24em] text-accent">
            foundry-unity ready
          </div>
          <h2 className="mt-3 text-xl font-semibold text-fg">
            What should we make?
          </h2>
          <p className="mx-auto mt-2 max-w-sm text-sm leading-relaxed text-fg-muted">
            Describe a change in plain language. foundry-unity will handle the
            Unity work and keep you in the loop.
          </p>
          <div className="mx-auto mt-6 h-px w-20 bg-ink-700" />
          <p className="mt-4 text-xs text-fg-dim">
            Use the command dock below to begin.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div
      ref={scrollRef}
      onScroll={trackScrollPosition}
      onWheel={() => {
        programmaticScrollRef.current = false;
      }}
      onPointerDown={() => {
        programmaticScrollRef.current = false;
      }}
      className="min-h-0 flex-1 overflow-y-auto px-4 py-6"
    >
      <div className="mx-auto flex max-w-2xl flex-col gap-5">
        {messages.map((m) => (
          <MessageBubble key={m.id} message={m} />
        ))}
        <div ref={bottomRef} />
      </div>
    </div>
  );
}
