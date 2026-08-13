# Development workflow

## Building

```bash
pnpm install
pnpm build      # builds core → safety → project-brain → mcp-server → cli (topological)
pnpm test       # vitest, runs against TS source via vite alias
pnpm typecheck  # alias for tsc --noEmit per package
```

Each package's `tsc -p tsconfig.json` emits to `dist/`. Tests don't depend on `dist/` because `vitest.config.ts` aliases `@uvibe/*` to `src/index.ts`. `bin/uvibe` does need `dist/`; `pnpm build` produces it.

## Running the CLI in dev

```bash
pnpm build
node apps/cli/bin/uvibe doctor --project=/path/to/UnityProject
node apps/cli/bin/uvibe verify --mock
```

For a globally available command, `pnpm link --dir apps/cli` (or `npm link` from `apps/cli`).

## Adding an MCP tool

1. Add a new `BridgeMethod` constant in `packages/core/src/protocol.ts` if the tool needs Unity. Bump `PROTOCOL_VERSION` if the change is breaking.
2. Add a Zod schema for the result in `packages/core/src/schemas.ts`.
3. Add the C# handler:
   - New method in `unity/UnityVibeOS/Editor/BridgeRouter.cs` (`switch` arm).
   - Implementation in a relevant inspector module.
4. Add the TypeScript tool in `packages/mcp-server/src/tools/<tool>.ts`. Use `bridgeCall` from `_helpers.ts`.
5. Register it in `packages/mcp-server/src/tools/index.ts`.
6. Add a mock responder in `packages/mcp-server/src/mockBridge.ts`.
7. Update `tests/mcp.test.ts` (registry list) and acceptance shape check in `apps/cli/src/commands/verify.ts`.
8. Document it in `docs/MCP_TOOLS.md`.

## Adding a CLI command

1. Add `apps/cli/src/commands/<name>.ts` exporting `run<Name>(g: GlobalOptions, parsed: ParsedArgs)`.
2. Wire it in `apps/cli/src/index.ts` `COMMANDS` map and add a help line.
3. Add a test in `tests/cli.test.ts`.

## Internal "GSD" loop (no terminal binary needed)

Manual mirror in `.planning/`. Update after each phase:

- `GSD_PLAN.md`
- `GSD_PHASES.md`
- `GSD_STATUS.md`
- `GSD_VERIFY.md`
- `GSD_DECISIONS.md`
- `ROADMAP.md`

`uvibe gsd-auto` reports planning status and detects whether a `gsd` CLI is on PATH; if it is, future versions will delegate the loop to it.
