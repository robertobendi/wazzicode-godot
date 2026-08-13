import { useState } from "react";
import { api, pickFolder } from "@/api";
import type { ProjectInfo } from "@/types/project";
import { PrimaryButton, SecondaryButton, StepHeading } from "./_shared";

/**
 * Step 2 — pick and validate the Unity project folder (same logic as
 * ProjectPicker: must have Assets/ + ProjectSettings/). On confirm, hands the
 * validated info up to the wizard.
 */
export default function ProjectStep({
  initial,
  onPicked,
  onBack,
}: {
  initial: ProjectInfo | null;
  onPicked: (info: ProjectInfo) => void;
  onBack: () => void;
}) {
  const [candidate, setCandidate] = useState<ProjectInfo | null>(
    initial?.ok ? initial : null,
  );
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function inspect(path: string) {
    setError(null);
    setChecking(true);
    try {
      const info = await api.validateUnityProject(path);
      if (!info.ok) {
        setCandidate(null);
        setError(
          `That folder doesn't look like a Unity project (missing ${
            info.hasAssets ? "" : "Assets/ "
          }${info.hasProjectSettings ? "" : "ProjectSettings/"}).`.trim(),
        );
      } else {
        setCandidate(info);
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setChecking(false);
    }
  }

  async function browse() {
    const path = await pickFolder();
    if (path) await inspect(path);
  }

  return (
    <div>
      <StepHeading title="Choose your game">
        Open the folder that holds your Unity game — the one with{" "}
        <code className="text-fg-dim">Assets</code> and{" "}
        <code className="text-fg-dim">ProjectSettings</code>.
      </StepHeading>

      <div className="mt-6">
        <PrimaryButton onClick={() => void browse()} busy={checking}>
          {candidate ? "Choose a different folder…" : "Choose folder…"}
        </PrimaryButton>
      </div>

      {error && <p className="mt-3 text-xs text-danger">{error}</p>}

      {candidate && (
        <div className="glass-card mt-4 animate-appear rounded-xl border p-4">
          <div className="text-sm font-medium text-fg">{candidate.name}</div>
          <div className="mt-0.5 truncate text-xs text-fg-dim">{candidate.path}</div>
          <div className="mt-2 text-[11px] text-fg-muted">
            Unity {candidate.unityVersion ?? "version unknown"}
          </div>
        </div>
      )}

      <div className="mt-8 flex gap-3">
        <SecondaryButton onClick={onBack}>Back</SecondaryButton>
        <div className="flex-1">
          <PrimaryButton
            onClick={() => candidate && onPicked(candidate)}
            disabled={!candidate}
          >
            Continue
          </PrimaryButton>
        </div>
      </div>
    </div>
  );
}
