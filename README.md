# WazziCode Godot

WazziCode Godot connects **Codex** and **Claude**—plus other MCP-compatible AI coding clients—to a live Godot editor. It exposes scene, node, script, resource, runtime, debugger, and test workflows through the Model Context Protocol (MCP).

This project is an MIT-licensed derivative of [hi-godot/godot-ai](https://github.com/hi-godot/godot-ai). See [NOTICE.md](NOTICE.md) for the exact upstream base, retained compatibility names, and update guidance; the dated candidate analysis is in [docs/UPSTREAM-EVALUATION.md](docs/UPSTREAM-EVALUATION.md).

## Quick start

Prerequisites: Godot 4.5+, Node.js 20+, either [uv](https://docs.astral.sh/uv/) or Python 3.11+, and Codex, Claude, or another MCP client.

```bash
git clone https://github.com/robertobendi/wazzicode-godot.git
cd wazzicode-godot
node ./bootstrap.mjs "/absolute/path/to/your-godot-project"
```

Then open the target project in Godot, enable **WazziCode Godot** under **Project > Project Settings > Plugins**, and use the WazziCode Godot dock to configure Codex, Claude, or both. The same MCP capabilities are available to each client.

For platform-specific paths, prerequisites, what the bootstrap changes, and manual recovery, follow [SETUP.md](SETUP.md).

## What it can do

- Inspect and edit scenes, nodes, properties, resources, scripts, signals, UI, animation, materials, particles, cameras, and environments.
- Search and modify project files with structured diagnostics and undo-aware editor operations.
- Run projects, inspect editor/runtime state, capture screenshots, read logs, profile performance, and execute Godot tests.
- Route calls to a selected editor session when several Godot projects share one backend.
- Keep large tool catalogs manageable through per-domain rollups and read-only `godot://` resources.
- Configure Codex, Claude, and other supported MCP clients from the editor dock.

See [docs/TOOLS.md](docs/TOOLS.md) for the maintained tool and resource catalog.

## Architecture

```text
Codex / Claude / another MCP client
                |
        local stdio attach bridge
                |
      Python FastMCP HTTP backend
                |
       authenticated WebSocket
                |
     Godot editor plugin (GDScript)
```

The control path is local by default. Anonymous telemetry is also **off by default** and requires explicit opt-in; see [docs/TELEMETRY.md](docs/TELEMETRY.md).

## Product name and compatibility identifiers

The visible product name is **WazziCode Godot**. The following mature upstream identifiers intentionally remain unchanged because launchers, saved editor settings, self-update logic, and MCP clients already depend on them:

- Python import: `godot_ai`
- Python distribution and legacy CLI: `godot-ai`
- Godot add-on path: `addons/godot_ai`
- editor settings namespace: `godot_ai/*`
- health/protocol names such as `/godot-ai/status` and `godot://...`

A source installation also exposes the friendly CLI alias `wazzicode-godot`; both entry points run the same compatibility-preserving implementation.

## Development

Create the development environment:

```powershell
.\script\setup-dev.ps1
```

```bash
./script/setup-dev
```

Run the Python checks from the repository root:

```powershell
.\.venv\Scripts\python -m pytest
.\.venv\Scripts\ruff check .
```

```bash
./.venv/bin/python -m pytest
./.venv/bin/ruff check .
```

Godot integration tests require a Godot editor binary and the repository test project; use `script/ci-godot-tests` in a compatible shell. These are validation commands, not claims about the current checkout's test result.

## Provenance and upstream updates

WazziCode Godot currently starts from Godot AI 3.1.1 at upstream commit `b1d767657fac87ef2a13a02c8ed58f4aa441db48`. Keep upstream as a separate remote so attribution and future merges stay reviewable:

```bash
git remote add upstream https://github.com/hi-godot/godot-ai.git  # once
git fetch upstream
git log --oneline HEAD..upstream/main
```

Merge or rebase upstream only on a dedicated branch, then re-apply and verify WazziCode branding, opt-in telemetry defaults, and bootstrap behavior before publishing. More detail is in [NOTICE.md](NOTICE.md).

## Status

This repository is a source derivative of the mature Godot AI lifecycle. Do not assume a WazziCode-specific PyPI, Godot Asset Library, or marketplace release exists unless this repository publishes the corresponding release artifact.

The inherited in-editor updater still verifies and installs official `hi-godot/godot-ai` releases. In a WazziCode source checkout, update with Git and rerun the bootstrap; using the upstream updater intentionally switches the add-on back to upstream Godot AI. The inherited publishing workflows are repository-guarded so this fork cannot accidentally publish the upstream `godot-ai` package.

## License

MIT. The original copyright and license are retained in [LICENSE](LICENSE) and in the distributable add-on. Attribution and modification notes are in [NOTICE.md](NOTICE.md).
