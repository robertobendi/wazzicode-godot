# GSD Phases

## Phase 0 — Repo discovery
- Inspected `/Users/Roberto/Repos/wazzicode-unity`: empty git repo, `main` branch, no commits.
- Toolchain: Node v25.4.0, npm 11.7, pnpm 10.29.
- GSD: no terminal binary; only Claude slash commands (`/gsd:*`). Decision: mirror manually.
- Strategy: TypeScript monorepo with pnpm workspaces, vitest, Zod, MCP SDK; Unity package as Editor-only C#.

## Phase 1 — Core schemas + protocol
**Files:** `packages/core/src/{protocol,schemas,errors,envelope,version,index}.ts`
**Verify:** `pnpm -F @uvibe/core build` succeeds; vitest `tests/core.test.ts` passes.

## Phase 2 — MCP server MVP
**Tools:** project_summary, generate_project_brain, get_open_scenes, get_scene_hierarchy, inspect_selected, get_console_logs, wait_for_compile, check_git_status.
**Verify:** mock bridge replies for all eight; `tests/mcp.test.ts` covers tool listing + mock results + envelope shape.

## Phase 3 — Unity Editor package MVP
**Files:** `unity/UnityVibeOS/Editor/{BridgeServer,BridgeRouter,SceneInspector,SelectionInspector,ConsoleCapture,CompileWatcher,ProjectInfo,Models}.cs` + asmdef + package.json + README.
**Verify:** Unity cannot run from this shell, so verification is manual. `docs/UNITY_MANUAL_TEST_CHECKLIST.md` lists every assertion; bridge protocol is unit-tested via the mock TS bridge.

## Phase 4 — Project Brain MVP
**Files:** `packages/project-brain/src/{detect,generate,index}.ts` + templates inline.
**Verify:** `tests/brain.test.ts` runs against a fixture Unity directory (`tests/fixtures/sample-unity/`).

## Phase 5 — CLI MVP
**Commands:** init, serve, brain, doctor, verify, mcp-config.
**Verify:** `tests/cli.test.ts` smoke-runs each via spawn (--mock), expects clean exit + envelope output.

## Phase 6 — Verification
- `pnpm test` green.
- `uvibe doctor` clean output.
- `uvibe verify --mock` green.
- README and MCP_TOOLS.md cross-link installed tools.

## Future phases
Diagnostics, runtime, safety/write, loop, dashboard — listed in ROADMAP.md.
