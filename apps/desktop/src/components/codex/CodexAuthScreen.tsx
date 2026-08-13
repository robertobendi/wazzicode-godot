import { useEffect, useState } from "react";
import { api, openExternal } from "@/api";
import { useCodexLogin } from "@/hooks/useCodexLogin";
import { useCliSetup, useOnboardingProgress } from "@/hooks/useOnboarding";
import { BACKENDS } from "@/types/settings";

type Check = "checking" | "signed_in" | "needed" | "missing_cli" | "error";

/**
 * Full-screen Codex sign-in. Check-first, like PairingScreen: on mount it asks
 * the Codex CLI whether it's already signed in and, if so, just says so and
 * continues. Otherwise the one path is "Sign in with ChatGPT" — the CLI opens a
 * browser and we surface the URL too, since it doesn't always open by itself.
 *
 * There is deliberately NO API-key option: an API key bills OpenAI **API
 * credits**, which is a different wallet from the ChatGPT subscription this
 * product runs on. The Rust side removes inherited one-shot credentials and
 * forces ChatGPT auth for every Codex child, so a stray API login cannot spend
 * from a different wallet either.
 *
 * Credentials never touch this app; they live in the CLI's own ~/.codex.
 * Success is reported via `onDone` (the caller decides what happens next).
 */
export default function CodexAuthScreen({
  onDone,
  onChooseAgent,
  forceSignIn = false,
}: {
  onDone: () => void;
  onChooseAgent?: () => void;
  /** Settings-driven re-auth should offer the flow even when a login exists. */
  forceSignIn?: boolean;
}) {
  const { update, starting, listenerReady, start, cancel } = useCodexLogin();
  const cli = useCliSetup("codex");
  const progress = useOnboardingProgress("install_cli");
  const [check, setCheck] = useState<Check>("checking");
  const [checkError, setCheckError] = useState<string | null>(null);

  useEffect(() => {
    if (cli.checking) {
      setCheck("checking");
      return;
    }
    if (cli.error) {
      setCheck("error");
      setCheckError(cli.error);
      return;
    }
    if (!cli.status?.found) {
      setCheck("missing_cli");
      return;
    }
    if (forceSignIn) {
      setCheckError(null);
      setCheck("needed");
      return;
    }

    let alive = true;
    setCheck("checking");
    setCheckError(null);
    void api
      .codexAuthStatus()
      .then((s) => {
        if (!alive) return;
        if (!s.installed) setCheck("missing_cli");
        else {
          setCheckError(s.loggedIn ? null : s.detail);
          setCheck(s.loggedIn ? "signed_in" : "needed");
        }
      })
      .catch((e) => {
        if (!alive) return;
        setCheckError(String(e));
        setCheck("error");
      });
    return () => {
      alive = false;
    };
  }, [
    cli.checking,
    cli.error,
    cli.status?.found,
    cli.status?.version,
    forceSignIn,
  ]);

  async function installCli() {
    progress.reset();
    await cli.install();
  }

  const phase = update?.phase ?? null;
  const done = check === "signed_in" || phase === "success";

  // Auto-continue shortly after we confirm (either the check or a fresh login).
  useEffect(() => {
    if (!done) return;
    const t = setTimeout(onDone, 1200);
    return () => clearTimeout(t);
  }, [done, onDone]);

  if (check === "checking") {
    return (
      <CenteredCard>
        <Spinner large />
        <h2 className="mt-5 text-lg font-medium text-fg">
          Checking your connection…
        </h2>
      </CenteredCard>
    );
  }

  if (done) {
    return (
      <CenteredCard>
        <div className="flex h-14 w-14 items-center justify-center rounded-full bg-success/15 text-2xl text-success">
          ✓
        </div>
        <h2 className="mt-5 text-xl font-semibold text-fg">
          {check === "signed_in" && phase !== "success"
            ? "Already signed in"
            : "Signed in"}
        </h2>
        <p className="mt-1 text-sm text-fg-muted">Taking you into the app…</p>
      </CenteredCard>
    );
  }

  const waiting =
    starting || phase === "starting" || phase === "awaiting_browser";

  return (
    <div className="flex h-full w-full items-center justify-center bg-ink-950 px-8">
      <div className="w-full max-w-lg animate-appear">
        <div className="mb-4 h-1.5 w-10 rounded-full bg-accent/70" />
        <h1 className="text-2xl font-semibold tracking-tight text-fg">
          Sign in to {BACKENDS.codex.label}
        </h1>
        <p className="mt-2 text-sm text-fg-muted">
          {check === "missing_cli" || check === "error"
            ? `The ${BACKENDS.codex.cli} command-line helper needs attention before you can sign in.`
            : "Sign in with your ChatGPT account so the agent can work in your project. This uses your ChatGPT plan — never API credits. Your credentials stay with the Codex CLI."}
        </p>

        {(check === "missing_cli" || check === "error") && (
          <CliRecovery
            label={BACKENDS.codex.label}
            installing={cli.installing}
            checking={cli.checking}
            error={checkError}
            lines={progress.lines}
            onInstall={() => void installCli()}
            onCheck={() => void cli.check()}
          />
        )}

        {check === "needed" && (
          <>
            {checkError && (
              <div className="mt-4 rounded-lg border border-warning/30 bg-warning/5 p-3 text-xs leading-relaxed text-fg-muted">
                {checkError}
              </div>
            )}
            {waiting ? (
              <WaitingPanel
                url={update?.url ?? null}
                onCancel={() => void cancel()}
              />
            ) : (
              <button
                onClick={() => void start()}
                disabled={!listenerReady}
                className="mt-6 flex w-full items-center justify-center gap-2 rounded-lg bg-accent px-4 py-2.5 text-sm font-medium text-white transition-colors hover:bg-accent-hover disabled:opacity-60"
              >
                {listenerReady ? "Sign in with ChatGPT" : "Preparing sign-in…"}
              </button>
            )}

            {(phase === "failed" || phase === "cancelled") && (
              <div className="mt-4 rounded-lg border border-danger/30 bg-danger/5 p-3 text-xs text-fg-muted">
                {update?.error ??
                  (phase === "cancelled"
                    ? "Sign-in was cancelled."
                    : "Sign-in didn't complete. Please try again.")}
              </div>
            )}
          </>
        )}

        {onChooseAgent && !waiting && (
          <button
            onClick={onChooseAgent}
            className="mt-5 rounded-lg border border-ink-700 px-3 py-2 text-sm font-medium text-fg-muted transition-colors hover:border-ink-600 hover:text-fg"
          >
            Choose a different AI agent
          </button>
        )}
      </div>
    </div>
  );
}

function CliRecovery({
  label,
  installing,
  checking,
  error,
  lines,
  onInstall,
  onCheck,
}: {
  label: string;
  installing: boolean;
  checking: boolean;
  error: string | null;
  lines: string[];
  onInstall: () => void;
  onCheck: () => void;
}) {
  return (
    <div className="mt-6 rounded-xl border border-ink-700 bg-ink-900/60 p-4">
      {error && (
        <pre className="selectable mb-3 whitespace-pre-wrap break-words font-sans text-xs leading-relaxed text-danger">
          {error}
        </pre>
      )}
      <button
        onClick={onInstall}
        disabled={installing || checking}
        className="w-full rounded-lg bg-accent px-4 py-2.5 text-sm font-medium text-white transition-colors hover:bg-accent-hover disabled:opacity-50"
      >
        {installing ? "Installing…" : `Install ${label} CLI`}
      </button>
      <button
        onClick={onCheck}
        disabled={installing || checking}
        className="mt-2 w-full rounded-lg border border-ink-700 px-4 py-2 text-sm font-medium text-fg-muted transition-colors hover:border-ink-600 hover:text-fg disabled:opacity-50"
      >
        {checking ? "Checking…" : "Check again"}
      </button>
      {lines.length > 0 && (
        <pre className="selectable mt-3 max-h-32 overflow-auto whitespace-pre-wrap rounded-lg bg-ink-950 p-3 text-[11px] leading-relaxed text-fg-dim">
          {lines.join("\n")}
        </pre>
      )}
    </div>
  );
}

/** Browser flow in flight: spinner + the URL, since the browser may not open. */
function WaitingPanel({
  url,
  onCancel,
}: {
  url: string | null;
  onCancel: () => void;
}) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    if (!url) return;
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard blocked — the field is selectable as a fallback.
    }
  }

  return (
    <div className="mt-6">
      <div className="flex items-center gap-3 rounded-xl border border-white/5 bg-ink-900/60 px-4 py-3">
        <Spinner />
        <span className="text-sm text-fg-muted">
          {url
            ? "Waiting for you to finish in the browser…"
            : "Opening your browser…"}
        </span>
      </div>

      {url && (
        <>
          <p className="mt-4 text-xs text-fg-dim">
            Didn&apos;t open? Use this link.
          </p>
          <div className="mt-1.5 flex items-stretch gap-2">
            <input
              readOnly
              value={url}
              onFocus={(e) => e.currentTarget.select()}
              className="selectable min-w-0 flex-1 truncate rounded-lg border border-ink-700 bg-ink-900 px-3 py-2 font-mono text-xs text-fg-muted focus:border-ink-600 focus:outline-none"
            />
            <button
              onClick={() => void copy()}
              className="shrink-0 rounded-lg bg-ink-700 px-3 py-2 text-sm font-medium text-fg transition-colors hover:bg-ink-600"
            >
              {copied ? "Copied" : "Copy"}
            </button>
            <button
              onClick={() => void openExternal(url)}
              className="shrink-0 rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-accent-hover"
            >
              Open in browser
            </button>
          </div>
        </>
      )}

      <button
        onClick={onCancel}
        className="mt-5 text-xs text-fg-dim transition-colors hover:text-fg-muted"
      >
        Cancel
      </button>
    </div>
  );
}

/** Full-screen centered panel for the check/signed-in states. */
function CenteredCard({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-full w-full items-center justify-center bg-ink-950 px-8">
      <div className="flex flex-col items-center text-center animate-appear">
        {children}
      </div>
    </div>
  );
}

function Spinner({ large }: { large?: boolean }) {
  const size = large ? "h-8 w-8 border-[3px]" : "h-4 w-4 border-2";
  return (
    <span
      className={`inline-block ${size} animate-spin rounded-full border-ink-700 border-t-fg-muted`}
      aria-hidden
    />
  );
}
