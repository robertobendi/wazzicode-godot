# Set up WazziCode Godot

The repository includes a cross-platform, one-command installer for an existing Godot project.

## One command

With an explicit project path:

```text
node /absolute/path/to/wazzicode-godot/bootstrap.mjs /absolute/path/to/MyGodotGame
```

Or run it from the Godot project, or any directory below it. The installer walks upward until it finds `project.godot`:

```text
cd /absolute/path/to/MyGodotGame
node /absolute/path/to/wazzicode-godot/bootstrap.mjs
```

The same command works in PowerShell, Command Prompt, bash, and zsh. Quote paths that contain spaces.

Prerequisites are Node 20 or newer and Godot 4.5 or newer. If `uv` is installed, setup uses it directly. Otherwise it uses an available Python 3.11+ interpreter to create the local `.venv`, installs `uv` from PyPI inside that venv, and continues. It does not pipe a downloaded script into a shell.

## What setup changes

The bootstrap:

1. Creates or reuses this repository's `.venv`, installs the repository editable with `uv`, and verifies that `godot_ai` imports from the local source tree.
2. Links `plugin/addons/godot_ai` into the game as `addons/godot_ai`. On Windows this is a directory junction; on macOS and Linux it is a directory symlink.
3. Adds `res://addons/godot_ai/plugin.cfg` to `editor_plugins/enabled` in `project.godot` without replacing other project settings or enabled plugins.
4. Merges a `wazzicode-godot` entry into the project's `.mcp.json`, preserving other MCP servers and top-level settings. The entry launches the absolute Python executable in the local venv and disables telemetry with both `--disable-telemetry` and `GODOT_AI_DISABLE_TELEMETRY=true`.
5. Adds a short, marker-delimited MCP workflow section to both `AGENTS.md` and `CLAUDE.md`. Existing project instructions outside the markers are left intact.
6. Writes `.wazzicode-godot/config.json` with the resolved project, repository, addon, and venv locations.
7. Adds a marker-delimited block to the project's `.gitignore` for the local `.mcp.json`, linked/copied addon, and `.wazzicode-godot` runtime, cache, log, and temporary directories. The config file itself remains visible so a team can decide whether to track it.

All project writes are idempotent. Re-running setup refreshes only WazziCode-owned fields and marked blocks. Invalid JSON, incomplete markers, an unfamiliar addon directory, or a managed path escaping through a directory link causes setup to stop instead of overwriting user content.

The installer never edits global Claude, Codex, or other MCP configuration.

### Generated MCP entry

Paths are absolute and platform-native. The managed portion of `.mcp.json` has this shape; any unrelated top-level fields, servers, and extra environment keys remain in place:

```json
{
  "mcpServers": {
    "wazzicode-godot": {
      "command": "/absolute/path/to/wazzicode-godot/.venv/bin/python",
      "args": ["-m", "godot_ai", "attach", "--disable-telemetry"],
      "env": {
        "GODOT_AI_DISABLE_TELEMETRY": "true",
        "PYTHONPATH": "/absolute/path/to/wazzicode-godot/src"
      }
    }
  }
}
```

Windows uses `.venv\\Scripts\\python.exe` for `command`. The `godot_ai` module name, `GODOT_AI_*` environment contract, and `res://addons/godot_ai/plugin.cfg` resource path deliberately retain upstream compatibility. Only the project MCP entry is branded `wazzicode-godot`. No unpublished `wazzicode` package or PyPI distribution is referenced.

The generated `.wazzicode-godot/config.json` records `schemaVersion`, `serverName`, `projectRoot`, `repoRoot`, `venvPython`, `telemetryEnabled`, and the addon `mode`, `source`, and `destination`. It contains no credentials.

## Addon modes

The default link mode is recommended for development:

```text
node /path/to/wazzicode-godot/bootstrap.mjs /path/to/game --link
```

The link lets the Godot plugin resolve the checkout's local `.venv`, so editor-managed server launches also use this source tree. Keep the WazziCode checkout at the recorded location.

To place a managed copy in the project instead:

```text
node /path/to/wazzicode-godot/bootstrap.mjs /path/to/game --copy
```

Copy mode writes a small ownership marker inside the copied addon. Later `--copy` runs refresh source files without deleting unknown files. Setup refuses to replace an unmarked addon directory or switch an existing link to a copy automatically.

Because a physical copy cannot walk through the addon link to discover this checkout's venv, start the project MCP client before opening Godot when using copy mode. That lets the local `godot_ai attach` process start the checkout-backed server before the editor connects. Link mode does not have this ordering caveat and remains the recommended default.

## Options

| Option | Effect |
|---|---|
| `--project <path>` | Name the project explicitly instead of using a positional path. |
| `--link` | Install with a junction/symlink; this is the default. |
| `--copy` | Install a managed physical copy. |
| `--dry-run` | Parse and validate the project, then print every intended action without running dependency commands or writing files. |
| `-h`, `--help` | Print command help. |

`WAZZICODE_GODOT_PROJECT` can supply a default project path. `WAZZICODE_UV` and `WAZZICODE_PYTHON` can name explicit executables when normal discovery is unsuitable.

## After setup

1. Open the project in Godot 4.5+ or restart an editor that was already open.
2. Confirm **WazziCode Godot** is enabled under **Project > Project Settings > Plugins**.
3. Start your MCP client from the Godot project directory and approve the `wazzicode-godot` project server if prompted.
4. Ask the client to call `godot_orient` with the current task. It should identify the open project and report live editor readiness, scene context, diagnostics, and Git state.

The generated `AGENTS.md` and `CLAUDE.md` sections tell coding agents to begin with `godot_orient`, inspect before writes, review per-write diagnostics, and finish with `godot_verify` plus appropriate visual/play verification.

## Re-running and updating

After pulling WazziCode changes, run the same setup command again. Editable dependencies are synchronized, a linked addon already reflects source changes, copied addon files are refreshed, and project configuration is merged again without duplicating entries.

Do not use the dock's inherited upstream update button for a WazziCode update. It installs a signature-verified `hi-godot/godot-ai` release and therefore switches the copied add-on back to upstream Godot AI. Use Git plus this bootstrap until this repository publishes a separately signed WazziCode release channel.

Preview an update first when desired:

```text
node /path/to/wazzicode-godot/bootstrap.mjs /path/to/game --dry-run
```

## Troubleshooting

- **No `project.godot` found:** pass the game directory explicitly.
- **No uv or Python:** install `uv` with a trusted package manager, or install Python 3.11+, then rerun. No curl-to-shell installer is required.
- **Existing addon content:** setup deliberately will not delete it. Move or back it up, then rerun with the intended mode.
- **Invalid `.mcp.json`:** repair or move the invalid file. Setup will not replace it with a blank configuration.
- **Plugin does not appear:** restart Godot after setup and check the Plugins panel. In link mode, also confirm the WazziCode repository has not moved.
- **MCP cannot connect:** start the MCP client from the project root, inspect its `.mcp.json` approval/status, then call `editor_state` after the Godot editor is open.

## Focused setup tests

The setup tests use temporary server and Godot project fixtures; they never install into this repository's own `test_project` or edit its `AGENTS.md`/`CLAUDE.md`:

```text
node --test tests/setup/bootstrap.test.mjs
```
