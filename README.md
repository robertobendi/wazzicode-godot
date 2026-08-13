# Godot Vibe OS

Give an AI agent the same concrete context you have in the Godot editor: the edited scene, selected nodes, resource graph, ClassDB, import state, and actual 2D/3D viewport.

Godot Vibe OS combines an authenticated localhost editor addon, a focused MCP server, a source-backed Godot project map, the `gvibe` CLI, and the Foundry desktop app. It is a separate Godot-native product—not a renamed Unity bridge.

## Set up a project

Requirements: Godot 4.7.1, Node 20+, and pnpm 10. Godot 4.7.1 is the version this addon is source-audited and integration-tested against.

```bash
node /absolute/path/to/wazzicode-godot/bootstrap.mjs /absolute/path/to/MyGodotGame
```

The bootstrap builds the workspace, installs and enables `addons/godot_vibe_os`, creates `.godot-vibe/`, builds the project map, and writes the project's `.mcp.json`. Existing `AGENTS.md`, `CLAUDE.md`, and MCP entries are preserved.

Then open the project in Godot and restart your MCP client from the project directory. The addon writes authenticated discovery state under `.godot/godot-vibe-os/`; the bridge only binds to `127.0.0.1`.

```bash
node /absolute/path/to/wazzicode-godot/apps/cli/bin/gvibe doctor \
  --project=/absolute/path/to/MyGodotGame
```

## What the agent can do

The 31 `godot_*` tools are deliberately smaller and more Godot-specific than the source product's tool catalog:

- Orient once with live project, scenes, selection, import, play, git, and relevant project-map state.
- Inspect bounded Node trees and exact NodePaths; create, delete, reparent, instantiate, set properties, open, and save through editor APIs and UndoRedo.
- Query ResourceLoader dependencies before moving or changing a resource.
- Query the editor's real ClassDB before writing unfamiliar Godot APIs.
- Read, hash, search, create, and atomically edit GDScript and other Godot text resources with SHA preconditions.
- Capture the real 2D or 3D editor viewport as multimodal image content.
- Run or stop the current, main, or a custom scene.
- Verify with a real headless import plus `--check-only` for every GDScript. The result explicitly says tests are not configured; import is never mislabeled as a test suite.
- Query a maintained map of project settings, autoloads, input actions, addons, scenes, resources, shaders, GDScript classes, signals, exports, functions, preloads, and relationships.

Start a task with:

```text
Call godot_orient with my request as `task`. Inspect first. Use godot_reflect before unfamiliar APIs. Make the change through dedicated scene or file tools, then run godot_verify and report its exact verdict.
```

## CLI

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

Project state lives under `.godot-vibe/`; Godot's per-machine discovery remains under ignored `.godot/` state.

## Repository

```text
godot/addons/godot_vibe_os/  Godot 4 editor addon and authenticated bridge
packages/core/               protocol, schemas, errors, envelopes
packages/bridge-client/      discovery-aware authenticated HTTP client
packages/mcp-server/         31 tools, prompts, resources, mock bridge
packages/project-brain/      Godot scanner, parser, entity graph, queries
packages/safety/             per-target gates, snapshots, action log
apps/cli/                    gvibe setup and diagnostics
apps/desktop/                Foundry for Godot desktop app
tests/godot/                 real enabled-addon Godot integration fixture
```

## Verification

```bash
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm build
pnpm test:godot
pnpm --filter @gvibe/desktop test
cd apps/desktop/src-tauri && cargo test
```

The installed standard Godot build verifies the GDScript addon. C# project compilation requires a Godot .NET editor and is reported as unverified when that editor is unavailable. Headless mode cannot render editor viewports; the addon returns `CAPTURE_UNAVAILABLE` instead of fabricating an image.
