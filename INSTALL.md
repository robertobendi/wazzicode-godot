# Install Unity Vibe OS

> **For Claude reading this:** if a user gave you this repo and asked you to set it up in their Unity project, you only need to run **one command**. Skip the rest of this file unless that command fails.

## TL;DR (one command)

```bash
node /absolute/path/to/wazzicode-unity/bootstrap.mjs /absolute/path/to/UnityProject
```

That's it. The script is idempotent and self-contained.

If you run it from inside a Unity project (or any subdirectory), the path argument is optional — the bootstrap walks up to find the Unity project:

```bash
cd /path/to/UnityProject
node /absolute/path/to/wazzicode-unity/bootstrap.mjs
```

## What the bootstrap does

1. Installs Node deps (`pnpm` if available, else `npm`).
2. Builds the TypeScript packages in topological order (`tsc -p` per package; no pnpm-specific magic required).
3. Runs `uvibe setup` against the Unity project, which:
   - Writes `.unity-vibe/{config.json, conventions.md, project_brain.{md,json}, claude_context.md}`.
   - Adds `"com.uvibe.os": "file:..."` to `Packages/manifest.json`.
   - Writes `.mcp.json` at the Unity project root with **absolute paths** (no `uvibe` on PATH required).
   - Updates `CLAUDE.md` (Claude Code) and `AGENTS.md` (Codex) with marker-delimited Unity Vibe OS sections. Existing project instructions are preserved and reruns update only the managed sections.
   - Runs `uvibe doctor` for a green-light check.

## After bootstrap

1. **Open the Unity project** in Unity Editor — the bridge auto-starts on `127.0.0.1:38578`.
2. **Restart Claude Code** in the Unity project directory:
   ```bash
   cd /path/to/UnityProject
   claude
   ```
   Claude Code auto-discovers `.mcp.json` and prompts you to approve the `unity-vibe-os` server.
3. **Verify**: `claude mcp list` (or `uvibe doctor`).

That's it. Claude can now drive Unity through 52 MCP tools — including one-call **`unity_orient`** (session bootstrap), **`unity_verify`** (compile + console + tests in a single verdict), and **`unity_batch`** (apply a multi-step plan in one round trip) — plus scene/selection inspection, console + compile, **multimodal screenshots** (it can literally see your Game/Scene view), live **performance counters**, the **Test Framework runner**, play-mode control + runtime inspection, asset/reference-graph diagnostics, **autonomous scene navigation** (open / additive-load scenes), **layout editing** (set-transform, reparent), **prefab-mode editing** (open / save / apply), **play-mode input simulation**, **animator** state/parameter/transition control, a whitelisted **menu-item** escape hatch, the **2D/asset pipeline** (import, sprite slicing, tilemap painting), and the rest of the safety-gated write tools.

## Prerequisites

- Node ≥ 20
- `pnpm` ≥ 10 OR `npm` ≥ 9 (auto-detected; pnpm preferred)
- A Unity project (Unity ≥ 2021.3)

## Bootstrap flags

| Flag | Effect |
|---|---|
| `--rebuild` | Force `install` + `tsc` even if artifacts exist |
| `--skip-install` | Skip dependency install |
| `--skip-build` | Skip TS build |
| `--skip-unity-install` | Don't touch `Packages/manifest.json` |
| `--unity-install-mode=manifest\|symlink\|copy` | How to register the Unity package (default: `manifest` = `file:` dependency entry) |

## Re-running

Safe and recommended after `git pull`. The bootstrap detects existing `node_modules` and `dist/`, skips them by default. Pass `--rebuild` to force.

## What if bootstrap fails?

Run the steps yourself:

```bash
cd /path/to/wazzicode-unity
pnpm install            # or npm install
pnpm build              # or: for each package, run: npx tsc -p <package>/tsconfig.json
node apps/cli/bin/uvibe setup --project=/path/to/UnityProject
```

Each step is idempotent.

## What this DOES NOT do

- It does **not** modify `~/.claude.json` or any global config. Configuration is per-project (`.mcp.json` at the Unity project root).
- It does **not** publish anything online or phone home. Everything is local; the bridge binds to `127.0.0.1` only.
- It does **not** install anything inside Unity itself beyond the package manifest entry. Unity will compile the package on next Editor load.

## Uninstall

```bash
# 1. Remove the Unity package entry
# Edit /path/to/UnityProject/Packages/manifest.json and delete the "com.uvibe.os" line.

# 2. Remove generated artifacts
rm /path/to/UnityProject/.mcp.json
rm -rf /path/to/UnityProject/.unity-vibe

# 3. (Optional) Strip the unity-vibe-os blocks from CLAUDE.md and AGENTS.md
# It's clearly marked: <!-- BEGIN unity-vibe-os --> ... <!-- END unity-vibe-os -->
```
