import { useEffect, useState } from "react";
import { api, openExternal } from "@/api";
import { usePairing } from "@/hooks/usePairing";
import { useCliSetup, useOnboardingProgress } from "@/hooks/useOnboarding";
import { usePairingStore } from "@/stores/usePairingStore";
import type { PairingPhase } from "@/types/pairing";
import { BACKENDS } from "@/types/settings";

type Check = "checking" | "connected" | "needed" | "missing_cli" | "error";

/**
 * Full-screen company-account pairing flow. Check-first: on mount it probes
 * whether the Claude CLI is already authenticated; if so it just says
 * "Already connected ✓" and continues. Otherwise it runs the three-step flow
 * (Connect → Approve → Done). A terminal never appears; the employee only ever
 * sees a link to send their admin and a box to paste the code back into.
 *
 * Success is reported via `onDone`; the caller persists `pairedOk` (this screen
 * doesn't, so the caller controls the gate timing).
 */
export default function PairingScreen({
  onDone,
  onChooseAgent,
  forcePair = false,
}: {
  onDone: () => void;
  onChooseAgent?: () => void;
  forcePair?: boolean;
}) {
  const pairingListenerReady = usePairing();
  const { state, starting, submitting, start, submitCode, cancel } =
    usePairingStore();
  const phase = state.phase;
  const cli = useCliSetup("claude");
  const progress = useOnboardingProgress("install_cli");

  // Check-first: is this machine already authenticated with the CLI?
  const [check, setCheck] = useState<Check>("checking");
  const [checkError, setCheckError] = useState<string | null>(null);
  useEffect(() => {
    if (cli.checking) {
      setCheck("checking");
      return;
    }
    if (cli.error) {
      setCheckError(cli.error);
      setCheck("error");
      return;
    }
    if (!cli.status?.found) {
      setCheck("missing_cli");
      return;
    }
    if (forcePair) {
      setCheckError(null);
      setCheck("needed");
      return;
    }

    let alive = true;
    setCheck("checking");
    setCheckError(null);
    void api
      .authVerify()
      .then((r) => alive && setCheck(r.ok ? "connected" : "needed"))
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
    forcePair,
  ]);

  async function installCli() {
    progress.reset();
    await cli.install();
  }

  // Auto-continue shortly after we confirm (either the check or a fresh pair).
  const done = check === "connected" || phase === "paired";
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

  if (check === "missing_cli" || check === "error") {
    return (
      <div className="flex h-full w-full items-center justify-center bg-ink-950 px-8">
        <div className="w-full max-w-lg animate-appear">
          <div className="mb-4 h-1.5 w-10 rounded-full bg-accent/70" />
          <h1 className="text-2xl font-semibold tracking-tight text-fg">
            Install {BACKENDS.claude.label}
          </h1>
          <p className="mt-2 text-sm text-fg-muted">
            The Claude command-line helper needs to be ready before we can
            connect your account.
          </p>
          <CliRecovery
            installing={cli.installing}
            checking={cli.checking}
            error={checkError}
            lines={progress.lines}
            onInstall={() => void installCli()}
            onCheck={() => void cli.check()}
          />
          {onChooseAgent && (
            <button
              onClick={onChooseAgent}
              disabled={cli.installing}
              className="mt-5 rounded-lg border border-ink-700 px-3 py-2 text-sm font-medium text-fg-muted transition-colors hover:border-ink-600 hover:text-fg disabled:opacity-50"
            >
              Choose a different AI agent
            </button>
          )}
        </div>
      </div>
    );
  }

  // Already connected (check passed), or just paired successfully.
  if (check === "connected" || phase === "paired") {
    return (
      <CenteredCard>
        <div className="flex h-14 w-14 items-center justify-center rounded-full bg-success/15 text-2xl text-success">
          ✓
        </div>
        <h2 className="mt-5 text-xl font-semibold text-fg">
          {check === "connected" ? "Already connected" : "Connected"}
        </h2>
        <p className="mt-1 text-sm text-fg-muted">Taking you into the app…</p>
      </CenteredCard>
    );
  }

  const step = stepFor(phase);

  return (
    <div className="flex h-full w-full items-center justify-center bg-ink-950 px-8">
      <div className="w-full max-w-lg animate-appear">
        <Stepper current={step} />

        {step === 1 && phase !== "failed" && (
          <ConnectStep
            starting={starting || phase === "starting" || !pairingListenerReady}
            onStart={() => void start()}
          />
        )}

        {step === 2 && (
          <ApproveStep
            url={state.oauthUrl}
            submitting={submitting || phase === "submitting"}
            onSubmit={(code) => void submitCode(code)}
            onCancel={() => void cancel()}
          />
        )}

        {step === 3 && phase !== "failed" && <VerifyingStep />}

        {phase === "failed" && (
          <FailedStep
            error={state.error}
            rawTail={state.rawTail}
            onRetry={() => void start()}
            retryDisabled={!pairingListenerReady}
          />
        )}

        {onChooseAgent &&
          !starting &&
          (phase === "idle" || phase === "failed") && (
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
  installing,
  checking,
  error,
  lines,
  onInstall,
  onCheck,
}: {
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
        {installing ? "Installing…" : "Install Claude Code CLI"}
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

function stepFor(phase: PairingPhase): 1 | 2 | 3 {
  if (phase === "awaiting_admin") return 2;
  if (phase === "submitting" || phase === "verifying" || phase === "paired")
    return 3;
  // idle / starting / failed sit on the first step (failed renders its own panel).
  return 1;
}

function Stepper({ current }: { current: 1 | 2 | 3 }) {
  const steps = ["Connect", "Approve", "Done"];
  return (
    <div className="mb-8 flex items-center gap-2">
      {steps.map((label, i) => {
        const n = (i + 1) as 1 | 2 | 3;
        const active = n === current;
        const done = n < current;
        return (
          <div key={label} className="flex flex-1 items-center gap-2">
            <span
              className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[11px] font-medium transition-colors ${
                done
                  ? "bg-accent/20 text-accent"
                  : active
                    ? "bg-accent text-white"
                    : "bg-ink-800 text-fg-dim"
              }`}
            >
              {done ? "✓" : n}
            </span>
            <span
              className={`text-xs ${active ? "text-fg" : "text-fg-dim"}`}
            >
              {label}
            </span>
            {i < steps.length - 1 && (
              <span className="ml-1 h-px flex-1 bg-ink-700" />
            )}
          </div>
        );
      })}
    </div>
  );
}

function ConnectStep({
  starting,
  onStart,
}: {
  starting: boolean;
  onStart: () => void;
}) {
  return (
    <div>
      <div className="mb-4 h-1.5 w-10 rounded-full bg-accent/70" />
      <h1 className="text-2xl font-semibold tracking-tight text-fg">
        Connect to your company&apos;s Claude account
      </h1>
      <p className="mt-2 text-sm text-fg-muted">
        This links the app to your company&apos;s Claude so the AI can work in
        your project. You&apos;ll get a link to send your admin — it only takes a
        minute.
      </p>
      <button
        onClick={onStart}
        disabled={starting}
        className="mt-6 flex w-full items-center justify-center gap-2 rounded-lg bg-accent px-4 py-2.5 text-sm font-medium text-white transition-colors hover:bg-accent-hover disabled:opacity-60"
      >
        {starting ? (
          <>
            <Spinner /> Preparing…
          </>
        ) : (
          "Get started"
        )}
      </button>
    </div>
  );
}

function ApproveStep({
  url,
  submitting,
  onSubmit,
  onCancel,
}: {
  url: string | null;
  submitting: boolean;
  onSubmit: (code: string) => void;
  onCancel: () => void;
}) {
  const [code, setCode] = useState("");
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
    <div>
      <div className="mb-4 h-1.5 w-10 rounded-full bg-accent/70" />
      <h1 className="text-2xl font-semibold tracking-tight text-fg">
        Send this link to your admin
      </h1>
      <p className="mt-2 text-sm text-fg-muted">
        They&apos;ll open it, approve access, and send you back a short code.
        Paste that code below.
      </p>

      <div className="mt-5 flex items-stretch gap-2">
        <input
          readOnly
          value={url ?? ""}
          onFocus={(e) => e.currentTarget.select()}
          className="selectable min-w-0 flex-1 truncate rounded-lg border border-ink-700 bg-ink-900 px-3 py-2 font-mono text-xs text-fg-muted focus:border-ink-600 focus:outline-none"
        />
        <button
          onClick={() => void copy()}
          disabled={!url}
          className="shrink-0 rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-accent-hover disabled:opacity-60"
        >
          {copied ? "Copied" : "Copy link"}
        </button>
      </div>
      {url && (
        <button
          onClick={() => void openExternal(url)}
          className="mt-2 text-xs text-fg-dim underline-offset-2 hover:text-fg-muted hover:underline"
        >
          Or open it here yourself
        </button>
      )}

      <div className="mt-7">
        <label className="mb-1.5 block text-xs font-medium uppercase tracking-wide text-fg-dim">
          Code from your admin
        </label>
        <input
          autoFocus
          value={code}
          onChange={(e) => setCode(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && code.trim() && !submitting)
              onSubmit(code);
          }}
          placeholder="Paste the code here"
          spellCheck={false}
          disabled={submitting}
          className="selectable w-full rounded-lg border border-ink-700 bg-ink-900 px-4 py-3 text-center font-mono text-lg tracking-wide text-fg placeholder:text-fg-dim focus:border-accent focus:outline-none disabled:opacity-60"
        />
        <button
          onClick={() => onSubmit(code)}
          disabled={!code.trim() || submitting}
          className="mt-3 flex w-full items-center justify-center gap-2 rounded-lg bg-accent px-4 py-2.5 text-sm font-medium text-white transition-colors hover:bg-accent-hover disabled:opacity-60"
        >
          {submitting ? (
            <>
              <Spinner /> Connecting…
            </>
          ) : (
            "Connect account"
          )}
        </button>
      </div>

      <button
        onClick={onCancel}
        className="mt-5 text-xs text-fg-dim transition-colors hover:text-fg-muted"
      >
        Cancel
      </button>
    </div>
  );
}

function VerifyingStep() {
  return (
    <div className="flex flex-col items-center py-10 text-center">
      <Spinner large />
      <h2 className="mt-5 text-lg font-medium text-fg">Connecting your account…</h2>
      <p className="mt-1 text-sm text-fg-muted">This only takes a moment.</p>
    </div>
  );
}

/** Full-screen centered panel for the check/connected states. */
function CenteredCard({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-full w-full items-center justify-center bg-ink-950 px-8">
      <div className="flex flex-col items-center text-center animate-appear">
        {children}
      </div>
    </div>
  );
}

function FailedStep({
  error,
  rawTail,
  onRetry,
  retryDisabled,
}: {
  error: string | null;
  rawTail: string | null;
  onRetry: () => void;
  retryDisabled: boolean;
}) {
  const [showDetails, setShowDetails] = useState(false);
  return (
    <div className="animate-appear">
      <div className="flex h-12 w-12 items-center justify-center rounded-full bg-danger/15 text-xl text-danger">
        !
      </div>
      <h2 className="mt-4 text-xl font-semibold text-fg">
        That didn&apos;t work
      </h2>
      <p className="mt-1 text-sm text-fg-muted">
        {error ?? "Pairing didn't complete. Please try again."}
      </p>

      <button
        onClick={onRetry}
        disabled={retryDisabled}
        className="mt-5 w-full rounded-lg bg-accent px-4 py-2.5 text-sm font-medium text-white transition-colors hover:bg-accent-hover disabled:opacity-60"
      >
        Start over
      </button>

      {rawTail && (
        <div className="mt-4">
          <button
            onClick={() => setShowDetails((v) => !v)}
            className="text-xs text-fg-dim transition-colors hover:text-fg-muted"
          >
            {showDetails ? "Hide details" : "Show details"}
          </button>
          {showDetails && (
            <pre className="selectable mt-2 max-h-48 overflow-auto rounded-lg border border-white/10 bg-ink-900 p-3 text-[11px] leading-relaxed text-fg-dim">
              {rawTail}
            </pre>
          )}
        </div>
      )}
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
