import { Component, type ErrorInfo, type ReactNode } from "react";

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
}

/** Keep a frontend render failure actionable instead of leaving a blank app. */
export default class AppErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("foundry-unity UI error", error, info.componentStack);
  }

  render() {
    if (!this.state.error) return this.props.children;

    return (
      <div className="flex h-full w-full items-center justify-center bg-ink-950 px-6 text-fg">
        <div className="glass-card w-full max-w-md rounded-2xl border p-6 text-center">
          <div className="mx-auto h-1.5 w-10 rounded-full bg-danger/70" />
          <h1 className="mt-5 text-xl font-semibold">
            foundry-unity needs to reload
          </h1>
          <p className="mt-2 text-sm leading-relaxed text-fg-muted">
            The interface hit a display problem. Your project files and saved
            chats are safe.
          </p>
          <button
            onClick={() => window.location.reload()}
            className="mt-6 w-full rounded-lg bg-accent px-4 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-accent-hover"
          >
            Reload foundry-unity
          </button>
          <details className="mt-4 text-left">
            <summary className="cursor-pointer text-xs text-fg-dim">
              Technical details
            </summary>
            <pre className="selectable mt-2 max-h-32 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-black/20 p-3 text-[11px] text-fg-dim">
              {this.state.error.message}
            </pre>
          </details>
        </div>
      </div>
    );
  }
}
