# Troubleshooting

## `uvibe doctor` reports "Unity bridge: unreachable"

- The Unity Editor must be open with the `UnityVibeOS` package installed.
- Check `Window → Unity Vibe OS → Status` inside Unity. The bridge should show "running" on `127.0.0.1:38578`.
- If a previous Unity instance crashed and the port is still bound, run `Window → Unity Vibe OS → Restart Bridge`.
- Some firewalls block even loopback HTTP. Confirm with `curl http://127.0.0.1:38578/health`.

## "Cannot find module @uvibe/core" when running tests

- Run `pnpm install` first. Symlinks live in each workspace package's `node_modules/`.
- Vitest uses `vitest.config.ts` aliases; if you renamed packages, update the aliases there too.

## `tsc` fails with TS6306 "must have setting composite: true"

- We removed TS project references in tsconfig — make sure none of the package tsconfigs still has a `references` block.

## Tests pass locally but `uvibe serve` returns no responses

- The MCP server is stdio-only. Anything printed to **stdout** by your code (besides JSON-RPC frames) corrupts the protocol. Use `process.stderr.write` for logs.
- The CLI keeps the process alive by holding a never-resolving promise; if you change `runServe`, do not let it return immediately.

## "git is not a repo" but `git status` works

- `uvibe doctor` uses `git rev-parse --is-inside-work-tree`. If the project is brand-new with no commits, that still returns `true`. If it returns `false`, ensure `--project=<path>` points to the actual repo root.

## Unity package has compile errors after install

- Confirm Unity 2021.3 LTS or newer. The package targets `unity: 2021.3` in its manifest.
- If you have older `System.Net` overrides via custom asmdef, ensure `UnityVibeOS.Editor.asmdef` is editor-only and `noEngineReferences=false`.
- `HttpListener` may fail to bind if another process owns port `38578`. The error appears in the Unity console as `[UnityVibeOS] failed to start bridge ...`. Free the port or change it (currently fixed; configurable in a later version).

## "MOCK_MODE_ACTIVE" everywhere

- Unset `UVIBE_MOCK` in your environment, or remove `--mock` from the CLI.
- Update `.unity-vibe/config.json#mockMode` to `false`.

## Mock responses look stale

- They're hard-coded for testing only. To see real Unity data, point `UVIBE_PROJECT` at a real Unity project and start the Editor with `UnityVibeOS` installed.

## Port 38578 already in use

- Two Unity instances or a previous crashed process holds the port.
- Find and kill the holder: `lsof -nP -i:38578` (Mac/Linux) or `netstat -ano | findstr :38578` (Windows).
- Or change the port: stop the bridge in Unity, edit `BridgeServer.DefaultPort` (future: configurable via `.unity-vibe/config.json`).
