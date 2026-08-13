# Decisions

## D-001 — GSD integration mode
GSD is only available as Claude slash commands in this environment, not a terminal binary. Mirroring workflow manually using `.planning/` files. `uvibe gsd-auto` is left as a future command and will detect a real GSD CLI if present.

## D-002 — Monorepo
pnpm workspaces. Three TS packages (`core`, `mcp-server`, `project-brain`, `safety`) plus one app (`cli`). Unity package lives outside the TS workspace.

## D-003 — Bridge protocol
HTTP localhost JSON-RPC at `127.0.0.1:38578`. Versioned (`v1`). Same envelope used both at the bridge layer and at the MCP tool result layer for consistency.

## D-004 — MCP transport
Stdio. Standard for Claude Code. No TCP port for MCP itself.

## D-005 — Schemas
Zod. Tools register Zod schemas with the MCP SDK directly.

## D-006 — Mock mode
Built into the bridge client; activated by `UVIBE_MOCK=1` env var or `--mock` CLI flag. Mock data is realistic and per-method.

## D-007 — Safety default
`read_only`. Write tools are gated by `packages/safety` and **not exposed in the MCP server in MVP**. They will be wired up only after snapshot + action log are implemented.

## D-008 — Unity APIs
Editor-only. Use `EditorSceneManager`, `Selection`, `SerializedObject`, `Application.logMessageReceivedThreaded`, `CompilationPipeline`. Console capture installs a log callback at editor load (best-effort: messages prior to package load are not captured; documented in MANUAL_TEST_CHECKLIST.md).

## D-009 — TypeScript module style
ESM, NodeNext. Top-level `await`. Node 20+ engines (compatible with installed Node 25).

## D-010 — No write tools in MVP
The brief explicitly says "Read-only first" and "Do not implement scene/prefab mutation until inspection, diagnostics, project brain, snapshots, and action logs work." MVP omits all unity_* write tools.
