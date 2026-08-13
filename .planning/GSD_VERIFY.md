# GSD Verify

## Automated (vitest)
- `tests/core.test.ts` — protocol envelope, error codes, schema parsing
- `tests/mcp.test.ts` — tool registry, mock bridge, envelope shape
- `tests/brain.test.ts` — project brain generator against fixture Unity project
- `tests/cli.test.ts` — CLI smoke (init, doctor, brain, mcp-config)

Run: `pnpm test`

## Manual (Unity inside Editor)
See `docs/UNITY_MANUAL_TEST_CHECKLIST.md`.

## Acceptance tests (from brief)
1. **No Unity running — `uvibe doctor`**: clean exit, reports MCP installed, bridge unreachable, brain status.
2. **Mock open scenes**: `unity_get_open_scenes` returns Scenes/Sample.unity.
3. **Mock selected**: `unity_inspect_selected` returns full envelope.
4. **Mock diagnostics**: skipped — diagnose tools are post-MVP.
5. **Mock compile**: `unity_wait_for_compile` returns `{compiling:false}`.
6. **Project brain**: `uvibe brain` writes 5 files.
7. **Safety mode blocks writes**: write tools are not yet exposed; `safety` package returns `SAFETY_MODE_BLOCKED` on attempt.
8. **Snapshot before write**: design only; implemented when write tools land.
9. **Mock verify**: `uvibe verify --mock` exits 0.
10. **MCP config gen**: `uvibe mcp-config` prints valid JSON snippet.
