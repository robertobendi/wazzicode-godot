# GSD automation

The brief asks Unity Vibe OS to run the `Plan → Execute → Verify → Fix → Continue` loop without making the user type slash commands.

In this environment, GSD ships **only as Claude slash commands**, not a terminal binary on `PATH`. Per the brief, we mirror the workflow manually using `.planning/` files. We do **not** invoke Claude slash commands programmatically — that would be unreliable and outside our control.

## What we do

- Maintain `.planning/{ROADMAP, GSD_PLAN, GSD_PHASES, GSD_STATUS, GSD_VERIFY, GSD_DECISIONS}.md`.
- After each phase: update STATUS, append to PHASES, record DECISIONS.
- Run automated verification (`pnpm test`, `uvibe verify --mock`) as part of "Verify".
- Document blockers honestly when Unity Editor APIs cannot be exercised from this shell (see `UNITY_MANUAL_TEST_CHECKLIST.md`).

## `uvibe gsd-auto`

Run from any project directory:

```bash
uvibe gsd-auto
```

It reports:

- Whether a `gsd` terminal binary is on `PATH`.
- Whether `.planning/` files exist.
- Mode: `cli` (delegate to GSD CLI), `internal` (mirror manually), or `mixed`.

Today, this is read-only reporting. Future versions will:

- Detect a real `gsd` CLI and delegate phase commands to it.
- Run the internal loop against a `.unity-vibe/tasks/current_task.md` file: inspect → modify → compile → test → fix → verify → save report into `.unity-vibe/reports/`.

## Why we don't try harder to call Claude slash commands

- Slash commands run inside Claude Code's chat session, not as terminal commands. There is no stable, sandboxed way to invoke them from a CLI.
- Doing so would couple Unity Vibe OS to Claude Code's internal RPC, which can change without notice.
- Mirroring the discipline (plan/phase/status/verify/decisions) gives the same outcome and keeps Unity Vibe OS portable.
