# Foundry for Godot

Foundry is the desktop workspace for [Godot Vibe OS](../../README.md). It lets a teammate describe a change while an AI agent works against the Godot project and the editor that are actually open. Packaged builds include the Node sidecar, `gvibe` CLI, MCP server, and editor addon, so users do not need this monorepo or a separate Node installation.

## How a project is connected

Choose a Godot project directory containing `project.godot`. Foundry then uses `gvibe` to:

- create project-owned state under `.godot-vibe/`, including safety settings, conventions, session data, snapshots, and the project brain;
- install and enable the editor addon at `res://addons/godot_vibe_os`;
- build a source-backed project brain covering settings, addons, scenes, resources, scripts, shaders, and their relationships; and
- connect the agent to the open editor through Godot Vibe OS's authenticated localhost bridge.

The live tools can inspect open scenes, selected nodes, exact NodePaths, resource dependencies, import and run state, and ClassDB. They can edit scenes through Godot's editor APIs and UndoRedo, edit project text with snapshot and hash safeguards, run or stop the project, and capture the actual 2D or 3D editor viewport.

`godot_verify` runs a real headless import and GDScript syntax checks. The automated test runner status is currently `not_configured`; import or syntax success must never be presented as a passing project test suite unless a real runner is configured and its result is observed.

## `gvibe` CLI

The desktop app drives the same CLI that is available from a terminal:

```text
gvibe setup
gvibe init
gvibe install-addon [--source=<addon-directory>]
gvibe brain [--ensure]
gvibe doctor [--json]
gvibe mcp-config [--write] [--target=codex]
gvibe lock | unlock
gvibe restore [snapshot-id]
gvibe serve
```

Use `--project=/absolute/path/to/project` when the current directory is not the project root.

## Development

Run these from the repository root:

```bash
pnpm install
pnpm --filter @gvibe/desktop tauri dev
```

The Tauri development build resolves the monorepo's `apps/cli/bin/gvibe`, so it does not require bundled release resources. The desktop package also exposes:

```bash
pnpm --filter @gvibe/desktop dev        # Vite frontend
pnpm --filter @gvibe/desktop typecheck  # tsc --noEmit
pnpm --filter @gvibe/desktop test       # vitest run
pnpm --filter @gvibe/desktop build      # tsc && vite build
pnpm --filter @gvibe/desktop preview    # vite preview
```

## Packaged build

Bundle the `gvibe` resource, target Node sidecar, Godot addon, and offline dictation assets before invoking Tauri with its release overlay:

```bash
pnpm --filter @gvibe/desktop bundle
pnpm --filter @gvibe/desktop tauri build --config src-tauri/tauri.bundle.conf.json
```

The release workflow builds unsigned `.dmg`, `.msi`, `.exe`, `.deb`, and `.AppImage` artifacts from `desktop-v*` tags or a manual dispatch. Platform security prompts are expected until signing and notarization are configured.
