# GSD Plan — Unity Vibe OS

GSD is only available as Claude slash commands here (not terminal-callable). Mirroring the workflow manually via `.planning/` files per the brief.

## Loop
Plan → Execute → Verify → Fix → Continue, without pausing for approval between phases unless genuinely blocked.

## Targets for this run (MVP vertical slice)
1. Monorepo skeleton (pnpm workspaces, TypeScript).
2. `packages/core` — protocol, schemas, errors, envelope.
3. `packages/mcp-server` — MCP server with 8 MVP tools and mock bridge.
4. `packages/project-brain` — brain generator.
5. `packages/safety` — config + safety-mode gate (snapshot stubs).
6. `apps/cli` — `uvibe init/serve/brain/doctor/verify/mcp-config`.
7. `unity/UnityVibeOS` — Unity Editor package implementing the bridge protocol.
8. Tests (vitest) at three levels: pure TS, mock bridge, manual Unity checklist.
9. Docs: architecture, MCP tools, Unity package, safety, troubleshooting, manual test checklist, GSD automation.

## Stop conditions
- All MVP definition-of-done items verified (or honestly documented as Unity-only manual).
- Tests green.
- CLI smoke-tested in mock mode.
