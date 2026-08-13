import { useCliSetup, useOnboardingProgress } from "@/hooks/useOnboarding";
import BackendPicker from "@/components/shell/BackendPicker";
import { BACKENDS, type AgentBackend } from "@/types/settings";
import type { CliStatus } from "@/types/onboarding";
import { PrimaryButton, ProgressLog, Spinner, StepHeading } from "./_shared";

/**
 * Step 1 — pick the agent, then get its CLI onto this machine. The check runs
 * on mount and again on every backend switch (the two CLIs are independent).
 * Found → a green confirmation and Continue. Missing → an Install button that
 * streams the official installer's output.
 */
export default function WelcomeStep({
  backend,
  onBackendChange,
  initial,
  settingsError,
  onContinue,
}: {
  backend: AgentBackend;
  onBackendChange: (backend: AgentBackend) => void;
  /** Status from `onboarding_status` for the CURRENT backend, if we have one. */
  initial: CliStatus | null;
  settingsError: string | null;
  onContinue: () => void;
}) {
  const { status, checking, installing, error, check, install } = useCliSetup(
    backend,
    initial,
  );
  const { lines, reset } = useOnboardingProgress("install_cli");

  const meta = BACKENDS[backend];

  async function runInstall() {
    reset();
    await install();
  }

  return (
    <div>
      <div role="status" aria-live="polite" className="sr-only">
        {checking
          ? `Checking the ${meta.label} CLI.`
          : installing
            ? `Installing the ${meta.label} CLI.`
            : status?.found && !error
              ? `${meta.label} CLI is ready.`
              : error
                ? `${meta.label} CLI needs attention.`
                : `${meta.label} CLI is not installed.`}
      </div>
      <StepHeading title="Welcome to foundry-unity">
        Make Unity changes just by chatting — no terminal needed. First, pick the
        AI agent you want to drive it.
      </StepHeading>

      <div className="mt-6">
        <BackendPicker
          value={backend}
          onChange={onBackendChange}
          showBlurb
          disabled={installing}
        />
      </div>

      {checking && (
        <div className="mt-6 flex items-center gap-2 text-sm text-fg-muted">
          <Spinner /> Checking for the {meta.label} CLI…
        </div>
      )}

      {!checking && status?.found && !error && (
        <div className="mt-6">
          <div className="rounded-xl border border-success/30 bg-success/5 p-4">
            <div className="text-sm font-medium text-fg">
              {meta.label} CLI is installed
            </div>
            <div className="mt-0.5 text-xs text-fg-dim">
              {status.version ?? "version unknown"}
            </div>
          </div>
          <div className="mt-6">
            <PrimaryButton onClick={onContinue}>Continue</PrimaryButton>
          </div>
        </div>
      )}

      {!checking && !error && status && !status.found && (
        <div className="mt-6">
          <p className="text-sm text-fg-muted">
            The <span className="font-mono text-fg">{meta.cli}</span> helper
            isn&apos;t installed yet. We can install it for you — this needs an
            internet connection and takes a minute.
          </p>
          <div className="mt-5">
            <PrimaryButton onClick={() => void runInstall()} busy={installing}>
              Install {meta.label} CLI
            </PrimaryButton>
            <button
              onClick={() => void check()}
              disabled={installing}
              className="mt-3 w-full rounded-lg border border-ink-700 px-4 py-2 text-sm font-medium text-fg-muted transition-colors hover:border-ink-600 hover:text-fg disabled:opacity-50"
            >
              Check again
            </button>
          </div>
          <ProgressLog lines={lines} />
        </div>
      )}

      {!checking && error && (
        <div className="mt-6 rounded-xl border border-danger/30 bg-danger/5 p-4">
          <p className="text-sm font-medium text-fg">
            We couldn&apos;t verify the {meta.label} CLI
          </p>
          <pre className="selectable mt-2 whitespace-pre-wrap break-words font-sans text-xs leading-relaxed text-fg-muted">
            {error}
          </pre>
          <div className="mt-4 grid grid-cols-2 gap-2">
            <button
              onClick={() => void check()}
              disabled={installing}
              className="rounded-lg border border-ink-700 px-3 py-2 text-sm font-medium text-fg transition-colors hover:border-ink-600 disabled:opacity-50"
            >
              Check again
            </button>
            <button
              onClick={() => void runInstall()}
              disabled={installing}
              className="rounded-lg bg-accent px-3 py-2 text-sm font-medium text-white transition-colors hover:bg-accent-hover disabled:opacity-50"
            >
              {installing ? "Installing…" : "Repair install"}
            </button>
          </div>
          <ProgressLog lines={lines} />
        </div>
      )}

      {settingsError && (
        <div
          role="alert"
          className="selectable mt-4 rounded-lg border border-danger/30 bg-danger/5 p-3 text-xs leading-relaxed text-danger"
        >
          Your AI agent choice could not be saved. Check the app&apos;s settings
          access, then try Continue again. {settingsError}
        </div>
      )}
    </div>
  );
}
